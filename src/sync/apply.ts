/**
 * Execute a Plan against Spotify + the export folder, writing state back after every successful
 * remote operation so a crash mid-way leaves a consistent (re-plannable) state. See DESIGN.md §6.
 */
import type { Config } from "../config.ts";
import { ITEMS_BATCH, type SpotifyApi } from "../spotify/api.ts";
import { MANAGED_DESCRIPTION } from "../spotify/types.ts";
import type { Repo } from "../state/repo.ts";
import { chunk } from "../util/retry.ts";
import { log } from "../util/log.ts";
import { exportTrack } from "./export.ts";
import type { ExportPlan, Plan, PlaylistPlan } from "./plan.ts";

export interface ApplyDeps {
  api: SpotifyApi;
  repo: Repo;
  cfg: Config;
  prune: boolean;
  now: number;
}

export interface ApplySummary {
  created: number;
  renamed: number;
  added: number;
  pruned: number;
  moved: number;
  replaced: number;
  liked: number;
  unliked: number;
  exported: number;
  exportErrors: number;
  /** exports garbage-collected after the playlist prune (--prune only) */
  exportsRemoved: number;
}

/** Replace the whole playlist only when it saves real calls: more than this many moves AND more than a third of the list. */
const REPLACE_MIN_MOVES = 5;
const REPLACE_MOVE_RATIO = 1 / 3;

export class PlaylistDriftError extends Error {
  constructor(name: string) {
    super(`playlist "${name}" changed since it was read; nothing was applied to it — rerun \`spotifify sync\``);
    this.name = "PlaylistDriftError";
  }
}

/** Applies playlist and library changes. Exports run separately (`applyExports`) before planning. */
export async function applyPlan(plan: Plan, deps: ApplyDeps): Promise<ApplySummary> {
  const s: ApplySummary = { created: 0, renamed: 0, added: 0, pruned: 0, moved: 0, replaced: 0, liked: 0, unliked: 0, exported: 0, exportErrors: 0, exportsRemoved: 0 };

  for (const p of plan.playlists) await applyPlaylist(p, deps, s);

  if (plan.likes.add.length > 0) {
    await deps.api.saveTracks(plan.likes.add);
    deps.repo.addLiked(plan.likes.add, deps.now);
    s.liked = plan.likes.add.length;
  }
  if (deps.prune && plan.likes.prune.length > 0) {
    await deps.api.removeSavedTracks(plan.likes.prune);
    deps.repo.removeLiked(plan.likes.prune);
    s.unliked = plan.likes.prune.length;
  }
  return s;
}

/** Run the ffmpeg export step alone; also used by `spotifify export`. `uriChanged` counts re-exports whose `spotify:local:` identity differs from the previous export (the pasted entries for those are now stale). */
export async function applyExports(plans: ExportPlan[], deps: { repo: Repo; cfg: Config; now: number }): Promise<{ exported: number; uriChanged: number; errors: number }> {
  const out = { exported: 0, uriChanged: 0, errors: 0 };
  for (const e of plans) {
    const track = deps.repo.representativeTracks([e.canonicalKey]).get(e.canonicalKey);
    if (!track?.file) continue;
    try {
      const previous = deps.repo.getExport(e.canonicalKey);
      const r = await exportTrack(e, track, deps.cfg.export);
      deps.repo.setExport({ canonicalKey: e.canonicalKey, exportPath: r.exportPath, localUri: r.localUri, contentHash: track.file.contentHash, exportedAt: deps.now });
      out.exported++;
      if (previous && previous.localUri !== r.localUri) out.uriChanged++;
      log.info("exported", { path: r.exportPath, uri: r.localUri });
    } catch (err) {
      out.errors++;
      log.error("export failed", { path: e.sourcePath, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

async function applyPlaylist(p: PlaylistPlan, deps: ApplyDeps, s: ApplySummary): Promise<void> {
  const { api, repo, now } = deps;
  let spotifyId = p.spotifyId;
  let name = p.rename?.from ?? p.sourceName;

  if (p.create) {
    const created = await api.createPlaylist(p.create.name, MANAGED_DESCRIPTION);
    spotifyId = created.id;
    name = created.name;
    repo.setSpotifyPlaylist({ sourcePlaylistId: p.sourcePlaylistId, spotifyId, name, snapshotId: created.snapshot_id, lastSyncedAt: null });
    s.created++;
    log.info("created playlist", { name, id: spotifyId });
  }
  if (spotifyId === null) throw new Error(`playlist plan for ${p.sourceName} has neither spotifyId nor create`);

  // Moves and the replace order describe the playlist as it was listed and carry no snapshot Spotify could
  // validate them against (unlike position removals), so an edit since the listing would reorder the wrong
  // rows: such a playlist is checked before anything is written to it.
  const willPrune = deps.prune && p.prune.length > 0;
  if (p.snapshotId !== null && p.moves.length > 0 && (await api.getPlaylistSnapshot(spotifyId)) !== p.snapshotId) {
    throw new PlaylistDriftError(name);
  }

  if (p.rename) {
    await api.renamePlaylist(spotifyId, p.rename.to);
    name = p.rename.to;
    s.renamed++;
    log.info("renamed playlist", p.rename);
  }

  // Replace-all fast path: one atomic PUT, only for lists it can hold whole, with no local items, and when
  // moving would cost noticeably more calls.
  const useReplace =
    p.replaceAllowed && p.targetOrder.length <= ITEMS_BATCH && p.moves.length > REPLACE_MIN_MOVES && p.moves.length > p.targetOrder.length * REPLACE_MOVE_RATIO;
  let snapshot: string | null = null;

  if (useReplace) {
    // Prune not requested → pruned items were kept in targetOrder by the planner, so nothing is lost here.
    snapshot = await api.replacePlaylistItems(spotifyId, p.targetOrder);
    repo.addManaged(spotifyId, p.adds, now);
    if (deps.prune) repo.removeManaged(spotifyId, p.prune.map((x) => x.uri));
    s.added += p.adds.length;
    s.pruned += deps.prune ? p.prune.length : 0;
    s.replaced++;
    log.info("replaced playlist contents", { name, items: p.targetOrder.length });
  } else {
    for (const uris of chunk(p.adds, ITEMS_BATCH)) {
      snapshot = await api.addPlaylistItems(spotifyId, uris);
      repo.addManaged(spotifyId, uris, now);
      s.added += uris.length;
    }
    if (willPrune) {
      // Positions come from the planning-time listing, so they are validated against that snapshot
      // (Spotify checks them against the snapshot given, not the current one). Adds only append.
      const base = p.snapshotId ?? snapshot ?? (await api.getPlaylist(spotifyId))?.snapshot_id ?? null;
      if (base === null) throw new Error(`playlist ${spotifyId} vanished during apply`);
      const items = p.prune.map((x) => (x.uri.startsWith("spotify:local:") ? { uri: x.uri, positions: x.positions } : { uri: x.uri }));
      snapshot = await api.removePlaylistItems(spotifyId, items, base);
      repo.removeManaged(spotifyId, p.prune.map((x) => x.uri));
      s.pruned += p.prune.length;
    }
    if (p.moves.length > 0) {
      // Moves are computed on the post-add/post-prune order, so they chain from the latest write.
      snapshot ??= p.snapshotId ?? (await api.getPlaylist(spotifyId))?.snapshot_id ?? null;
      if (snapshot === null) throw new Error(`playlist ${spotifyId} vanished during apply`);
      for (const m of p.moves) {
        snapshot = await api.reorderPlaylistItems(spotifyId, m.rangeStart, m.insertBefore, snapshot);
        s.moved++;
      }
    }
  }
  // Local entries present after this run reference their export from this playlist; an export is only
  // garbage-collected once no playlist references it any more (see planExportGc). Without --prune the
  // stale ones are still there.
  const localPresent = deps.prune ? p.linked : [...p.linked, ...p.prune.map((x) => x.uri).filter((u) => u.startsWith("spotify:local:"))];
  repo.replaceManagedLocal(spotifyId, localPresent, now);

  if (p.adds.length > 0 || p.moves.length > 0 || p.prune.length > 0) {
    log.info("synced playlist", { name, added: p.adds.length, pruned: deps.prune ? p.prune.length : 0, moves: p.moves.length, awaiting: p.awaiting.length });
  }
  repo.setSpotifyPlaylist({ sourcePlaylistId: p.sourcePlaylistId, spotifyId, name, snapshotId: snapshot, lastSyncedAt: now });
}
