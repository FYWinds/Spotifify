import type { Config } from "../config.ts";
import type { SpotifyTrack } from "../spotify/types.ts";
import { normalizeArtists, normalizeTitle, similarity, type NormalizedTitle } from "./normalize.ts";
import type { ScoreParts } from "./types.ts";

export interface ScoreInput {
  title: string;
  aliases: string[];
  artists: string[];
  album?: string;
  durationMs?: number;
}

/** Source side of a comparison, normalized once so it can be scored against many candidates. */
export interface PreparedSource {
  titles: NormalizedTitle[];
  versionTags: Set<string>;
  artists: string[];
  album: string | null;
  durationMs: number | undefined;
}

const W_TITLE = 0.45;
const W_ARTIST = 0.3;
const W_ALBUM = 0.1;
const W_DURATION = 0.15;

export function prepareSource(src: ScoreInput, cfg: Config["matching"]): PreparedSource {
  const main = normalizeTitle(src.title);
  return {
    titles: [main, ...src.aliases.map(normalizeTitle)],
    versionTags: main.versionTags,
    artists: normalizeArtists(src.artists, cfg.artist_aliases),
    album: src.album ? normalizeTitle(src.album).core : null,
    durationMs: src.durationMs,
  };
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function artistSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  for (const x of a) {
    for (const y of b) {
      if (x === y) return 1;
      const s = similarity(x, y);
      if (s > best) best = s;
    }
  }
  return best;
}

export function scorePrepared(src: PreparedSource, cand: SpotifyTrack, cfg: Config["matching"]): { score: number; parts: ScoreParts } {
  const candTitle = normalizeTitle(cand.name);
  let title = 0;
  for (const t of src.titles) {
    const s = similarity(t.core, candTitle.core);
    if (s > title) title = s;
  }
  const artist = artistSimilarity(
    src.artists,
    normalizeArtists(
      cand.artists.map((a) => a.name),
      cfg.artist_aliases,
    ),
  );
  const album = src.album === null ? 0.5 : similarity(src.album, normalizeTitle(cand.album.name).core);
  let duration = 0.5;
  if (src.durationMs !== undefined) {
    const delta = Math.abs(src.durationMs - cand.duration_ms);
    duration = delta <= cfg.duration_tolerance_ms ? 1 : delta <= 10_000 ? 0.5 : 0;
  }
  const parts: ScoreParts = { title, artist, album, duration, versionTagsAgree: setsEqual(src.versionTags, candTitle.versionTags) };
  return { score: W_TITLE * title + W_ARTIST * artist + W_ALBUM * album + W_DURATION * duration, parts };
}

/** DESIGN.md §5.3: weighted sum of title / artist / album / duration similarities. */
export function scoreCandidate(src: ScoreInput, cand: SpotifyTrack, cfg: Config["matching"]): { score: number; parts: ScoreParts } {
  return scorePrepared(prepareSource(src, cfg), cand, cfg);
}

/** Hard gate for `matched(auto)`: high overall score plus strong title/artist, exact-enough duration, and agreeing version tags. */
export function passesAutoGate(score: number, parts: ScoreParts, cfg: Config["matching"]): boolean {
  return score >= cfg.auto_threshold && parts.title >= 0.9 && parts.artist >= 0.8 && parts.duration === 1 && parts.versionTagsAgree;
}
