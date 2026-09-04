/**
 * Execute a Plan against Spotify + the export folder, writing state back after every successful
 * remote operation so a crash mid-way leaves a consistent (re-plannable) state. See DESIGN.md §6.
 */
import type { Config } from "../config.ts";
import type { SpotifyApi } from "../spotify/api.ts";
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
}

/** Replace the whole playlist only when it saves real calls: more than this many moves AND more than a third of the list. */
const REPLACE_MIN_MOVES = 5;
const REPLACE_MOVE_RATIO = 1 / 3;

/** Applies playlist and library changes. Exports run separately (`applyExports`) before planning. */
export async function applyPlan(plan: Plan, deps: ApplyDeps): Promise<ApplySummary> {
  const s: ApplySummary = { created: 0, renamed: 0, added: 0, pruned: 0, moved: 0, replaced: 0, liked: 0, unliked: 0, exported: 0, exportErrors: 0 };

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

  if (p.rename) {
    await api.renamePlaylist(spotifyId, p.rename.to);
    name = p.rename.to;
    s.renamed++;
    log.info("renamed playlist", p.rename);
  }

  // Replace-all fast path: only when no local items exist and moving would cost noticeably more calls.
  const useReplace = p.replaceAllowed && p.moves.length > REPLACE_MIN_MOVES && p.moves.length > p.targetOrder.length * REPLACE_MOVE_RATIO;
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
    for (const uris of chunk(p.adds, 100)) {
      snapshot = await api.addPlaylistItems(spotifyId, uris);
      repo.addManaged(spotifyId, uris, now);
      s.added += uris.length;
    }
    if (deps.prune && p.prune.length > 0) {
      snapshot ??= (await api.getPlaylist(spotifyId))?.snapshot_id ?? null;
      if (snapshot === null) throw new Error(`playlist ${spotifyId} vanished during apply`);
      const items = p.prune.map((x) => (x.uri.startsWith("spotify:local:") ? { uri: x.uri, positions: x.positions } : { uri: x.uri }));
      snapshot = await api.removePlaylistItems(spotifyId, items, snapshot);
      repo.removeManaged(spotifyId, p.prune.map((x) => x.uri));
      s.pruned += p.prune.length;
    }
    if (p.moves.length > 0) {
      snapshot ??= (await api.getPlaylist(spotifyId))?.snapshot_id ?? null;
      if (snapshot === null) throw new Error(`playlist ${spotifyId} vanished during apply`);
      for (const m of p.moves) {
        snapshot = await api.reorderPlaylistItems(spotifyId, m.rangeStart, m.insertBefore, snapshot);
        s.moved++;
      }
    }
  }

  if (p.adds.length > 0 || p.moves.length > 0 || p.prune.length > 0) {
    log.info("synced playlist", { name, added: p.adds.length, pruned: deps.prune ? p.prune.length : 0, moves: p.moves.length, awaiting: p.awaiting.length });
  }
  repo.setSpotifyPlaylist({ sourcePlaylistId: p.sourcePlaylistId, spotifyId, name, snapshotId: snapshot, lastSyncedAt: now });
}
