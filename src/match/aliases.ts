/**
 * Mine `matching.artist_aliases` candidates from matches whose identity is certain (user-confirmed,
 * ISRC or fingerprint hits): when exactly one source artist and one Spotify artist are left unpaired
 * after applying the current alias table, they are the same act under two names (周杰倫 → Jay Chou).
 */
import type { Config } from "../config.ts";
import type { Repo } from "../state/repo.ts";
import { normalizeArtists, normalizeText, similarity, splitArtists } from "./normalize.ts";

export interface AliasSuggestion {
  /** raw source artist name as it appears in the source */
  from: string;
  /** raw Spotify artist name */
  to: string;
  /** confirmed matches supporting this pairing */
  count: number;
  /** a few "artist - title" examples */
  examples: string[];
  /** other Spotify names the same source artist was paired with (ambiguous; the most frequent wins) */
  conflicts: string[];
}

/** Below this similarity the two names would not be matched by fuzzy scoring, so an alias actually changes outcomes. */
const FUZZY_ENOUGH = 0.8;
const EXAMPLES = 3;

export function inferArtistAliases(repo: Repo, cfg: Config["matching"]): AliasSuggestion[] {
  const rows = repo.listMatches("matched").filter((m) => m.decidedBy === "user" || m.decidedBy === "isrc" || m.decidedBy === "fingerprint");
  const tracks = repo.representativeTracks(rows.map((m) => m.canonicalKey));
  // normalized source name → normalized spotify name → tally
  const tally = new Map<string, Map<string, { from: string; to: string; count: number; examples: string[] }>>();

  for (const m of rows) {
    const track = tracks.get(m.canonicalKey);
    const cand = m.candidates.find((c) => c.id === m.spotifyId);
    if (!track || !cand) continue;

    const srcRaw = splitArtists(track.artists);
    const candRaw = splitArtists(cand.artists);
    const srcNorm = normalizeArtists(track.artists, cfg.artist_aliases);
    const candNorm = normalizeArtists(cand.artists, cfg.artist_aliases);
    const candSet = new Set(candNorm);
    const srcSet = new Set(srcNorm);

    const leftSrc = srcRaw.filter((r) => !candSet.has(normalizeArtists([r], cfg.artist_aliases)[0] ?? ""));
    const leftCand = candRaw.filter((r) => !srcSet.has(normalizeArtists([r], cfg.artist_aliases)[0] ?? ""));
    if (leftSrc.length !== 1 || leftCand.length !== 1) continue;

    const from = leftSrc[0]!;
    const to = leftCand[0]!;
    const nf = normalizeText(from);
    const nt = normalizeText(to);
    if (nf === "" || nt === "" || similarity(nf, nt) >= FUZZY_ENOUGH) continue;

    let byTarget = tally.get(nf);
    if (!byTarget) {
      byTarget = new Map();
      tally.set(nf, byTarget);
    }
    let entry = byTarget.get(nt);
    if (!entry) {
      entry = { from, to, count: 0, examples: [] };
      byTarget.set(nt, entry);
    }
    entry.count++;
    if (entry.examples.length < EXAMPLES) entry.examples.push(`${track.artists.join(", ")} - ${track.title}  →  ${cand.artists.join(", ")} - ${cand.title}`);
  }

  const out: AliasSuggestion[] = [];
  for (const byTarget of tally.values()) {
    const ranked = [...byTarget.values()].sort((a, b) => b.count - a.count);
    const best = ranked[0]!;
    out.push({ from: best.from, to: best.to, count: best.count, examples: best.examples, conflicts: ranked.slice(1).map((r) => r.to) });
  }
  return out.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
}
