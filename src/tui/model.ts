import type { MatchRow } from "../match/types.ts";
import type { Repo, SourceTrackRow } from "../state/repo.ts";

/** Which queue is on screen: `review` = needs a human; `local` = auto-decided unmatched, still pickable. */
export type Tab = "review" | "local";

export const TABS: readonly Tab[] = ["review", "local"];

export interface ReviewItem {
  match: MatchRow;
  track: SourceTrackRow;
  playlists: string[];
}

export type Queues = Record<Tab, ReviewItem[]>;

/** Load one tab's queue; keys without a representative source track are dropped. */
export function loadQueue(repo: Repo, tab: Tab): ReviewItem[] {
  const matches = repo.listMatches(tab);
  const tracks = repo.representativeTracks(matches.map((m) => m.canonicalKey));
  const items: ReviewItem[] = [];
  for (const match of matches) {
    const track = tracks.get(match.canonicalKey);
    if (!track) continue;
    items.push({ match, track, playlists: repo.playlistNamesForKey(match.canonicalKey) });
  }
  return items;
}

/** `m:ss`; `--:--` when unknown. */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "--:--";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Signed whole-second delta between candidate and source, e.g. `+3s`; empty when the source duration is unknown. */
export function fmtDelta(candidateMs: number, sourceMs: number | undefined): string {
  if (sourceMs === undefined) return "";
  const d = Math.round((candidateMs - sourceMs) / 1000);
  if (d === 0) return "±0s";
  return `${d > 0 ? "+" : "-"}${Math.abs(d)}s`;
}

export function scoreColor(score: number): "green" | "yellow" | "red" {
  if (score >= 0.85) return "green";
  if (score >= 0.6) return "yellow";
  return "red";
}

export function sourceOrigin(track: SourceTrackRow): string {
  if (track.kind === "netease") return `netease  id ${track.externalId}`;
  return `local  ${track.file?.path ?? track.externalId}`;
}
