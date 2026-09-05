/**
 * Plan = pure data describing the difference between desired state (sources + match decisions)
 * and the remote Spotify state. Computed by `computePlaylistPlan` (pure) / `buildPlan` (run.ts),
 * printed by `--dry-run`, executed by `apply`. See DESIGN.md §6.
 */
import type { LocalExportRow } from "../state/repo.ts";
import { buildLocalUri, parseLocalUri } from "../spotify/localUri.ts";
import { planMoves } from "./reorder.ts";

export interface DesiredItem {
  uri: string;
  kind: "spotify" | "local";
  canonicalKey: string;
}

export interface Move {
  /** index of the item to move in the *current* order at the time this move is applied */
  rangeStart: number;
  /** target index (Spotify `insert_before` semantics) */
  insertBefore: number;
}

export interface PlaylistPlan {
  sourcePlaylistId: number;
  sourceName: string;
  /** null when the playlist must be created first */
  spotifyId: string | null;
  /** snapshot the remote listing (and therefore `prune[].positions`) belongs to; null when created */
  snapshotId: string | null;
  create: { name: string } | null;
  rename: { from: string; to: string } | null;
  /** spotify:track URIs to POST, in desired order */
  adds: string[];
  /** local items that must be pasted into the desktop client by the user */
  awaiting: DesiredItem[];
  /** tool-managed remote items no longer in the source; removed only with --prune */
  prune: Array<{ uri: string; positions: number[] }>;
  /** remote items not managed by this tool; never removed, kept at the tail */
  foreign: string[];
  /** minimal move sequence to reach desired order (after adds, and prune when enabled) */
  moves: Move[];
  /** full target order (after adds/prune) — used by the replace-all fast path */
  targetOrder: string[];
  /** when true, apply may replace the whole playlist instead of moving (no local items involved) */
  replaceAllowed: boolean;
}

export interface LikePlan {
  /** spotify track ids to PUT /me/tracks */
  add: string[];
  /** tool-liked ids no longer desired; removed only with --prune */
  prune: string[];
}

export interface ExportPlan {
  canonicalKey: string;
  sourcePath: string;
  /** sanitized file name without extension, unique within export.dir */
  baseName: string;
  decryptNcm: boolean;
}

export interface Plan {
  playlists: PlaylistPlan[];
  likes: LikePlan;
  exports: ExportPlan[];
  /** export records (and files) no longer needed; removed only with --prune, after the playlist prune */
  exportGc: LocalExportRow[];
  /** canonical keys needing human review */
  reviewPending: number;
}

export interface RemoteItem {
  uri: string;
  isLocal: boolean;
  /**
   * A local entry that names one of our exports — exactly, or with an identity the client will never
   * resolve (different duration segment, tags from an earlier export). Ours to remove with --prune
   * when it is no longer desired (superseded by a Spotify match, gone from the source, wrong identity).
   */
  owned: boolean;
}

export interface PlaylistPlanInput {
  sourcePlaylistId: number;
  sourceName: string;
  targetName: string;
  /** existing remote playlist (already verified to exist), or null */
  spotify: { id: string; name: string } | null;
  /** snapshot id the `remote` listing was taken at (null when `spotify` is null) */
  snapshotId: string | null;
  /** ordered, deduped by uri */
  desired: DesiredItem[];
  /** current remote order; local uris already canonicalized via `resolveRemoteLocalUri` */
  remote: RemoteItem[];
  /** uris this tool added to the remote playlist */
  managed: Set<string>;
  pruneEnabled: boolean;
}

/** Exported titles once carried this marker; remote entries created from them are stale. */
const LEGACY_TITLE_SUFFIX = / \(local\)$/;

export interface ResolvedRemoteLocal {
  uri: string;
  owned: boolean;
}

/**
 * Map a remote local-file uri onto our export identities. Same artist/album/title/duration as an export
 * → the export's `local_uri`. Same artist/album/title but a different identity (wrong or missing
 * duration segment, legacy title suffix) → the verbatim uri (removal by position needs it exactly).
 * Both are `owned`. Anything else is left untouched (a foreign local file).
 */
export function resolveRemoteLocalUri(remoteUri: string, exports: readonly LocalExportRow[]): ResolvedRemoteLocal {
  const parts = parseLocalUri(remoteUri);
  if (!parts) return { uri: remoteUri, owned: false };
  const fold = (s: string) => s.replace(LEGACY_TITLE_SUFFIX, "").trim().toLowerCase();
  for (const e of exports) {
    const p = parseLocalUri(e.localUri);
    if (!p) continue;
    if (fold(p.artist) !== fold(parts.artist) || fold(p.album) !== fold(parts.album) || fold(p.title) !== fold(parts.title)) continue;
    const exact = parts.durationSec === p.durationSec && parts.title === p.title;
    return { uri: exact ? e.localUri : remoteUri, owned: true };
  }
  return { uri: buildLocalUri(parts), owned: false };
}

export function computePlaylistPlan(input: PlaylistPlanInput): PlaylistPlan {
  const { desired, remote, managed, pruneEnabled } = input;
  const desiredSet = new Set(desired.map((d) => d.uri));

  if (input.spotify === null) {
    return {
      sourcePlaylistId: input.sourcePlaylistId,
      sourceName: input.sourceName,
      spotifyId: null,
      snapshotId: null,
      create: { name: input.targetName },
      rename: null,
      adds: desired.filter((d) => d.kind === "spotify").map((d) => d.uri),
      awaiting: desired.filter((d) => d.kind === "local"),
      prune: [],
      foreign: [],
      moves: [],
      targetOrder: desired.filter((d) => d.kind === "spotify").map((d) => d.uri),
      replaceAllowed: false,
    };
  }

  const remoteSet = new Set(remote.map((r) => r.uri));
  const adds = desired.filter((d) => d.kind === "spotify" && !remoteSet.has(d.uri)).map((d) => d.uri);
  const awaiting = desired.filter((d) => d.kind === "local" && !remoteSet.has(d.uri));

  const prune: PlaylistPlan["prune"] = [];
  const pruneByUri = new Map<string, number[]>();
  const foreign: string[] = [];
  remote.forEach((r, i) => {
    if (desiredSet.has(r.uri)) return;
    if (managed.has(r.uri) || r.owned) {
      let positions = pruneByUri.get(r.uri);
      if (!positions) {
        positions = [];
        pruneByUri.set(r.uri, positions);
        prune.push({ uri: r.uri, positions });
      }
      positions.push(i);
    } else if (!foreign.includes(r.uri)) {
      foreign.push(r.uri);
    }
  });

  // Predict the order after adds (appended) and prune (when enabled), tokenizing duplicates so
  // the reorder planner sees a permutation.
  const pruneSet = pruneEnabled ? new Set(pruneByUri.keys()) : new Set<string>();
  const occurrence = new Map<string, number>();
  const token = (uri: string) => {
    const n = occurrence.get(uri) ?? 0;
    occurrence.set(uri, n + 1);
    return `${uri}#${n}`;
  };
  const current: string[] = [];
  for (const r of remote) if (!pruneSet.has(r.uri)) current.push(token(r.uri));
  for (const uri of adds) current.push(token(uri));

  const currentSet = new Set(current);
  const target: string[] = [];
  for (const d of desired) {
    const t = `${d.uri}#0`;
    if (currentSet.has(t)) target.push(t);
  }
  const targetSet = new Set(target);
  for (const t of current) if (!targetSet.has(t)) target.push(t);

  const moves = planMoves(current, target);
  const targetOrder = target.map((t) => t.slice(0, t.lastIndexOf("#")));
  const anyLocal = remote.some((r) => r.isLocal) || targetOrder.some((u) => u.startsWith("spotify:local:"));

  return {
    sourcePlaylistId: input.sourcePlaylistId,
    sourceName: input.sourceName,
    spotifyId: input.spotify.id,
    snapshotId: input.snapshotId,
    create: null,
    rename: input.spotify.name === input.targetName ? null : { from: input.spotify.name, to: input.targetName },
    adds,
    awaiting,
    prune,
    foreign,
    moves,
    targetOrder,
    replaceAllowed: !anyLocal,
  };
}
