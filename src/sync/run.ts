/**
 * The five sync phases (pull → match → plan → apply → report). Each phase is idempotent and
 * re-runnable; see DESIGN.md §2.
 */
import type { Config } from "../config.ts";
import { Matcher } from "../match/matcher.ts";
import { SearchBudgetExhaustedError } from "../match/search.ts";
import type { MatchRow } from "../match/types.ts";
import { LocalSource } from "../sources/local/source.ts";
import { NeteaseAuthError, NeteaseClient } from "../sources/netease/client.ts";
import { NeteaseSource } from "../sources/netease/source.ts";
import type { SourceKind, SourceTrack } from "../sources/types.ts";
import type { SpotifyApi } from "../spotify/api.ts";
import { SpotifyHttpError, SpotifyRateLimitedError } from "../spotify/client.ts";
import { MANAGED_DESCRIPTION, type SpotifyPlaylistItem } from "../spotify/types.ts";
import { parseLocalUri } from "../spotify/localUri.ts";
import type { LocalExportRow, Repo, SourcePlaylistRow } from "../state/repo.ts";
import { sanitizeFilename } from "../util/fs.ts";
import { log } from "../util/log.ts";
import { mapLimit } from "../util/retry.ts";
import { applyExports, applyPlan, type ApplySummary } from "./apply.ts";
import { computePlaylistPlan, resolveRemoteLocalUri, type DesiredItem, type ExportPlan, type Plan, type PlaylistPlan, type RemoteItem } from "./plan.ts";

export interface SyncOptions {
  dryRun: boolean;
  prune: boolean;
  /** pull/plan only this source kind */
  source?: SourceKind;
  /** plan/apply only source playlists whose name equals this (pull is never filtered: it would prune the others) */
  playlist?: string;
  skipMatch: boolean;
  onProgress?: (phase: string, done: number, total: number) => void;
}

export interface SyncDeps {
  cfg: Config;
  repo: Repo;
  api: SpotifyApi;
}

export interface AwaitingEntry {
  playlist: string;
  uris: string[];
}

export interface MatchPhaseSummary {
  searched: number;
  matched: number;
  review: number;
  local: number;
  /** tracks still due after this run (budget / rate limit stopped the phase early) */
  remaining: number;
  /** epoch ms until which Spotify refuses searches (429 with a long Retry-After), or null */
  blockedUntil: number | null;
  budgetExhausted: boolean;
}

export interface SyncSummary {
  pulled: Record<SourceKind, { playlists: number; tracks: number }>;
  matched: MatchPhaseSummary;
  plan: { creates: number; adds: number; prune: number; moves: number; likes: number; unlikes: number; exports: number; reviewPending: number };
  apply: ApplySummary | null;
  awaiting: AwaitingEntry[];
  matchCounts: Record<string, number>;
}

const META_SEARCH_BLOCKED_UNTIL = "spotify_search_blocked_until";

const DAY_MS = 86_400_000;

export interface SyncResult {
  summary: SyncSummary;
  plan: Plan;
}

export async function runSync(deps: SyncDeps, opts: SyncOptions): Promise<SyncResult> {
  const { cfg, repo, api } = deps;
  const now = Date.now();
  const runId = repo.startRun(now);
  try {
    const pulled = await pull(deps, opts, now);
    const matched = opts.skipMatch
      ? { searched: 0, matched: 0, review: 0, local: 0, remaining: 0, blockedUntil: null, budgetExhausted: false }
      : await match(deps, opts, now);
    // Export before planning: it depends only on match state, and the plan must see fresh export records
    // to list them as awaiting paste in the same run.
    const exports = planExportsOnly(repo, cfg, opts);
    const exported = opts.dryRun ? null : await applyExports(exports, { repo, cfg, now });
    const plan = await buildPlan(deps, opts, exports);
    const apply = opts.dryRun ? null : await applyPlan(plan, { api, repo, cfg, prune: opts.prune, now });
    if (apply && exported) {
      apply.exported = exported.exported;
      apply.exportErrors = exported.errors;
    }
    const summary: SyncSummary = {
      pulled,
      matched,
      plan: {
        creates: plan.playlists.filter((p) => p.create).length,
        adds: plan.playlists.reduce((n, p) => n + p.adds.length, 0),
        prune: plan.playlists.reduce((n, p) => n + p.prune.length, 0),
        moves: plan.playlists.reduce((n, p) => n + p.moves.length, 0),
        likes: plan.likes.add.length,
        unlikes: plan.likes.prune.length,
        exports: plan.exports.length,
        reviewPending: plan.reviewPending,
      },
      apply,
      awaiting: awaitingEntries(plan, repo),
      matchCounts: repo.countMatches(),
    };
    repo.finishRun(runId, true, summary, Date.now());
    return { summary, plan };
  } catch (e) {
    repo.finishRun(runId, false, { error: e instanceof Error ? e.message : String(e) }, Date.now());
    throw e;
  }
}

/** Canonical keys referenced by the playlists this run mirrors; match and export never spend effort outside it. */
export function selectedKeys(repo: Repo, cfg: Config, opts: Pick<SyncOptions, "source" | "playlist">): Set<string> {
  const keys = new Set<string>();
  for (const sp of selectedSourcePlaylists(repo, cfg, opts)) for (const t of repo.playlistTracks(sp.id)) keys.add(t.canonicalKey);
  return keys;
}

/** Export plan for every unmatched track that has a local file and belongs to a mirrored playlist (no network). `force` re-exports existing ones. */
export function planExportsOnly(repo: Repo, cfg: Config, opts: Pick<SyncOptions, "source" | "playlist"> = {}, force = false): ExportPlan[] {
  const keys = selectedKeys(repo, cfg, opts);
  return planExports(repo, repo.listMatches("local").map((m) => m.canonicalKey).filter((k) => keys.has(k)), repo.listExports(), force);
}

// ---- pull -------------------------------------------------------------------

async function pull(deps: SyncDeps, opts: SyncOptions, now: number): Promise<SyncSummary["pulled"]> {
  const { cfg, repo } = deps;
  const out: SyncSummary["pulled"] = { netease: { playlists: 0, tracks: 0 }, local: { playlists: 0, tracks: 0 } };
  const wanted = (k: SourceKind) => opts.source === undefined || opts.source === k;

  if (cfg.netease.enabled && wanted("netease")) {
    const auth = repo.getAuth<{ cookie: string }>("netease");
    if (!auth) throw new NeteaseAuthError("netease not logged in: run `spotifify auth netease`");
    const byExternal = new Map(repo.listSourcePlaylists("netease").map((p) => [p.externalId, p] as const));
    const source = new NeteaseSource(new NeteaseClient(auth.cookie), cfg.netease, {
      playlistUpdatedAt: (id) => byExternal.get(id)?.sourceUpdatedAt ?? undefined,
      playlistTracks: (id) => {
        const p = byExternal.get(id);
        return p ? repo.playlistTracks(p.id) : [];
      },
      knownSongs: (ids) => repo.sourceTracksByExternalIds("netease", ids) as Map<string, SourceTrack>,
    });
    const { playlists } = await source.pull();
    repo.savePull("netease", playlists, now);
    out.netease = { playlists: playlists.length, tracks: playlists.reduce((n, p) => n + p.tracks.length, 0) };
    log.info("pulled netease", out.netease);
  }

  if (cfg.local.enabled && wanted("local")) {
    const source = new LocalSource(cfg.local, repo.localTracksByPath(), (done, total) => opts.onProgress?.("scan", done, total));
    const { playlists } = await source.pull();
    repo.savePull("local", playlists, now);
    out.local = { playlists: playlists.length, tracks: playlists.reduce((n, p) => n + p.tracks.length, 0) };
    log.info("pulled local", out.local);
  }
  return out;
}

// ---- match ------------------------------------------------------------------

async function match(deps: SyncDeps, opts: SyncOptions, now: number): Promise<MatchPhaseSummary> {
  const { cfg, repo, api } = deps;
  const wanted = selectedKeys(repo, cfg, opts);
  const due = repo.matchesDue(now, cfg.matching.retry_unmatched_after_days * DAY_MS).filter((m) => wanted.has(m.canonicalKey));
  const result: MatchPhaseSummary = { searched: 0, matched: 0, review: 0, local: 0, remaining: due.length, blockedUntil: null, budgetExhausted: false };

  const storedBlock = Number(repo.metaGet(META_SEARCH_BLOCKED_UNTIL) ?? 0);
  if (storedBlock > now) {
    result.blockedUntil = storedBlock;
    log.warn("Spotify search still rate-limited; skipping match phase", { until: new Date(storedBlock).toISOString(), due: due.length });
    return result;
  }
  repo.metaSet(META_SEARCH_BLOCKED_UNTIL, null);
  if (due.length === 0) return result;

  const tracks = repo.representativeTracks(due.map((m) => m.canonicalKey));
  const matcher = new Matcher({ api, repo, cfg, market: await api.resolveMarket(cfg.spotify.market) });
  let done = 0;
  let stop = false;
  await mapLimit(due, cfg.matching.search_concurrency, async (existing) => {
    if (stop) return;
    const track = tracks.get(existing.canonicalKey);
    if (!track) return;
    let row: MatchRow;
    try {
      row = await matcher.matchOne(track, existing, now);
    } catch (e) {
      if (e instanceof SpotifyRateLimitedError) {
        if (!stop) {
          stop = true;
          result.blockedUntil = e.untilMs;
          repo.metaSet(META_SEARCH_BLOCKED_UNTIL, String(e.untilMs));
          log.warn("Spotify search quota exhausted; stopping match phase", { until: new Date(e.untilMs).toISOString() });
        }
        return;
      }
      if (e instanceof SearchBudgetExhaustedError) {
        if (!stop) {
          stop = true;
          result.budgetExhausted = true;
          log.warn("search budget for this run used up; stopping match phase", { budget: e.budget });
        }
        return;
      }
      throw e;
    }
    repo.upsertMatch(row);
    result.searched++;
    result.remaining--;
    if (row.status === "matched") result.matched++;
    else if (row.status === "review") result.review++;
    else if (row.status === "local") result.local++;
    done++;
    opts.onProgress?.("match", done, due.length);
    if (done % 50 === 0) log.info("matching", { done, total: due.length, requests: matcher.searchesUsed });
  });
  log.info("matched", { ...result, requests: matcher.searchesUsed });
  return result;
}

/**
 * Source playlists this run acts on: `--source` / `--playlist` filters, and the local library only when
 * `local.mirror_playlist` is on (otherwise local files serve purely as audio for tracks of other playlists).
 */
export function selectedSourcePlaylists(repo: Repo, cfg: Config, opts: Pick<SyncOptions, "source" | "playlist">): SourcePlaylistRow[] {
  return repo
    .listSourcePlaylists(opts.source)
    .filter((p) => (opts.playlist === undefined || p.name === opts.playlist) && (p.kind !== "local" || cfg.local.mirror_playlist));
}

// ---- plan -------------------------------------------------------------------

export async function buildPlan(deps: SyncDeps, opts: Pick<SyncOptions, "prune" | "source" | "playlist">, exportPlans: ExportPlan[]): Promise<Plan> {
  const { cfg, repo, api } = deps;
  const me = await api.me();
  const remotePlaylists = (await api.listMyPlaylists()).filter((p) => p.owner.id === me.id);
  const exports = repo.listExports();

  const sourcePlaylists = selectedSourcePlaylists(repo, cfg, opts);

  const playlists: PlaylistPlan[] = [];
  const likeDesired = new Set<string>();

  for (const sp of sourcePlaylists) {
    const targetName = cfg.sync.playlist_prefix + sp.name;
    const tracks = repo.playlistTracks(sp.id);
    const matches = repo.matchesForKeys(tracks.map((t) => t.canonicalKey));
    const exportByKey = new Map(exports.map((e) => [e.canonicalKey, e] as const));
    const likeThis = sp.kind === "netease" ? cfg.netease.like_matched : cfg.local.like_matched;

    const desired: DesiredItem[] = [];
    const seen = new Set<string>();
    for (const t of tracks) {
      const m = matches.get(t.canonicalKey);
      if (!m) continue;
      let item: DesiredItem | null = null;
      if (m.status === "matched" && m.spotifyUri && m.spotifyId) {
        item = { uri: m.spotifyUri, kind: "spotify", canonicalKey: t.canonicalKey };
        if (likeThis) likeDesired.add(m.spotifyId);
      } else if (m.status === "local") {
        const e = exportByKey.get(t.canonicalKey);
        if (e) item = { uri: e.localUri, kind: "local", canonicalKey: t.canonicalKey };
      }
      if (item && !seen.has(item.uri)) {
        seen.add(item.uri);
        desired.push(item);
      }
    }

    const remote = await resolveRemotePlaylist(sp, targetName, remotePlaylists, deps);
    let remoteItems: RemoteItem[] = [];
    let snapshotId: string | null = null;
    if (remote) {
      const listing = await listPlaylistItemsConsistently(api, remote.id);
      snapshotId = listing.snapshotId;
      remoteItems = listing.items.map((it) => {
        if (!it.item) return { uri: "", isLocal: false, stale: false };
        if (it.is_local || it.item.is_local) return { ...resolveRemoteLocalUri(it.item.uri, exports), isLocal: true };
        return { uri: it.item.uri, isLocal: false, stale: false };
      });
    }

    playlists.push(
      computePlaylistPlan({
        sourcePlaylistId: sp.id,
        sourceName: sp.name,
        targetName,
        spotify: remote,
        snapshotId,
        desired,
        remote: remoteItems,
        managed: remote ? repo.managedUris(remote.id) : new Set<string>(),
        pruneEnabled: opts.prune,
      }),
    );
  }

  // Likes: everything desired that is not already saved; prune tool-liked ids no longer desired.
  const likeIds = [...likeDesired];
  const saved = await savedFlags(api, likeIds);
  const likes = {
    add: likeIds.filter((_, i) => !saved[i]),
    prune: [...repo.likedIds()].filter((id) => !likeDesired.has(id)),
  };

  return { playlists, likes, exports: exportPlans, reviewPending: repo.countMatches().review };
}

/** Which of `ids` are already liked. `/me/tracks/contains` is 403 for some development-mode apps; then list the library instead. */
async function savedFlags(api: SpotifyApi, ids: string[]): Promise<boolean[]> {
  if (ids.length === 0) return [];
  try {
    return await api.checkSaved(ids);
  } catch (e) {
    if (!(e instanceof SpotifyHttpError) || e.status !== 403) throw e;
    log.warn("/me/tracks/contains is forbidden for this app; listing the whole library instead");
    const saved = await api.listSavedTrackIds();
    return ids.map((id) => saved.has(id));
  }
}

/**
 * Items plus the snapshot id they belong to. The listing is paginated and the snapshot endpoint is
 * separate, so the listing is bracketed by two snapshot reads and retried while they differ; the
 * snapshot is what position-based removals are validated against, so a wrong one must never be sent.
 */
async function listPlaylistItemsConsistently(api: SpotifyApi, id: string): Promise<{ items: SpotifyPlaylistItem[]; snapshotId: string }> {
  for (let attempt = 1; ; attempt++) {
    const before = await api.getPlaylistSnapshot(id);
    const items = await api.getPlaylistItems(id);
    const after = await api.getPlaylistSnapshot(id);
    if (before === after) return { items, snapshotId: after };
    if (attempt === 3) throw new Error(`playlist ${id} keeps changing while it is being read; retry later`);
    log.warn("playlist changed while listing, retrying", { id, attempt });
  }
}

/**
 * Find the remote playlist for a source playlist: the stored mapping if it still exists, else a
 * remote playlist with the target name carrying our description (adoption after state loss), else null.
 */
async function resolveRemotePlaylist(
  sp: SourcePlaylistRow,
  targetName: string,
  remotePlaylists: Array<{ id: string; name: string; description: string | null }>,
  deps: SyncDeps,
): Promise<{ id: string; name: string } | null> {
  const mapping = deps.repo.getSpotifyPlaylist(sp.id);
  if (mapping) {
    const live = remotePlaylists.find((p) => p.id === mapping.spotifyId);
    if (live) return { id: live.id, name: live.name };
    log.warn("mapped spotify playlist no longer exists; will recreate", { source: sp.name, spotifyId: mapping.spotifyId });
    deps.repo.deleteSpotifyPlaylist(sp.id);
  }
  const adopt = remotePlaylists.find((p) => p.name === targetName && p.description === MANAGED_DESCRIPTION);
  if (adopt) {
    log.info("adopting existing spotify playlist", { name: adopt.name, id: adopt.id });
    deps.repo.setSpotifyPlaylist({ sourcePlaylistId: sp.id, spotifyId: adopt.id, name: adopt.name, snapshotId: null, lastSyncedAt: null });
    return { id: adopt.id, name: adopt.name };
  }
  return null;
}

function planExports(repo: Repo, localKeys: string[], exports: LocalExportRow[], force = false): ExportPlan[] {
  const usedNames = new Set(exports.map((e) => e.exportPath.replace(/\.[^.\\/]+$/, "").replace(/^.*[\\/]/, "").toLowerCase()));
  const exportByKey = new Map(exports.map((e) => [e.canonicalKey, e] as const));
  const tracks = repo.representativeTracks(localKeys);
  const plans: ExportPlan[] = [];
  for (const key of localKeys) {
    const t = tracks.get(key);
    if (!t?.file) continue;
    const existing = exportByKey.get(key);
    // An export is current when the source is unchanged and its recorded identity is complete
    // (rows written before the duration segment was known cannot match anything the client indexes).
    if (!force && existing && existing.contentHash === t.file.contentHash && parseLocalUri(existing.localUri)?.durationSec !== null) continue;
    let base = sanitizeFilename(`${t.artists.join(", ") || "Unknown Artist"} - ${t.title}`);
    if (!existing) {
      for (let n = 2; usedNames.has(base.toLowerCase()); n++) base = sanitizeFilename(`${t.artists.join(", ") || "Unknown Artist"} - ${t.title} (${n})`);
    } else {
      base = existing.exportPath.replace(/\.[^.\\/]+$/, "").replace(/^.*[\\/]/, "");
    }
    usedNames.add(base.toLowerCase());
    plans.push({ canonicalKey: key, sourcePath: t.file.path, baseName: base, decryptNcm: t.file.path.toLowerCase().endsWith(".ncm") });
  }
  return plans;
}

function awaitingEntries(plan: Plan, repo: Repo): AwaitingEntry[] {
  const out: AwaitingEntry[] = [];
  for (const p of plan.playlists) {
    if (p.awaiting.length === 0) continue;
    const mapping = repo.getSpotifyPlaylist(p.sourcePlaylistId);
    out.push({ playlist: mapping?.name ?? p.create?.name ?? p.sourceName, uris: p.awaiting.map((a) => a.uri) });
  }
  return out;
}

// ---- report -----------------------------------------------------------------

export function formatPlan(plan: Plan, prune: boolean): string {
  const lines: string[] = [];
  for (const p of plan.playlists) {
    const head = p.create ? `+ create "${p.create.name}"` : `~ "${p.rename ? `${p.rename.from}" → "${p.rename.to}` : p.sourceName}"`;
    lines.push(`${head}: add ${p.adds.length}, move ${p.moves.length}, awaiting paste ${p.awaiting.length}, foreign ${p.foreign.length}, prune ${p.prune.length}${prune ? "" : " (report only)"}`);
    for (const u of p.adds.slice(0, 20)) lines.push(`    + ${u}`);
    if (p.adds.length > 20) lines.push(`    + … ${p.adds.length - 20} more`);
    for (const x of p.prune) lines.push(`    ${prune ? "-" : "?"} ${x.uri}`);
  }
  lines.push(`likes: +${plan.likes.add.length}, prune ${plan.likes.prune.length}${prune ? "" : " (report only)"}`);
  lines.push(`exports: ${plan.exports.length}`);
  for (const e of plan.exports.slice(0, 20)) lines.push(`    → ${e.baseName}  (${e.sourcePath})`);
  if (plan.exports.length > 20) lines.push(`    → … ${plan.exports.length - 20} more`);
  lines.push(`review pending: ${plan.reviewPending}`);
  return lines.join("\n");
}
