import type { Config } from "../config.ts";
import type { SpotifyApi } from "../spotify/api.ts";
import type { SpotifyTrack } from "../spotify/types.ts";
import type { Repo, SourceTrackRow } from "../state/repo.ts";
import { mapLimit } from "../util/retry.ts";
import { isrcsByFingerprint } from "./fingerprint.ts";
import { passesAutoGate, prepareSource, scorePrepared, type PreparedSource } from "./score.ts";
import { queryTitle, TrackSearch } from "./search.ts";
import type { Candidate, DecidedBy, MatchRow, ScoreParts } from "./types.ts";

const MAX_CANDIDATES = 10;
/** DESIGN.md §5.1 step 5: a bare-title query only contributes candidates whose artist already looks right. */
const BARE_TITLE_MIN_ARTIST = 0.8;
const SEARCH_CONCURRENCY = 4;
const TRACK_REF = /^(?:spotify:track:|https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/)([0-9A-Za-z]{22})(?:[?#].*)?$/;

/** Dedupes search results by id (and relinked origin id) and scores each one once. */
class CandidatePool {
  private readonly seen = new Set<string>();
  private readonly byId = new Map<string, Candidate>();
  private readonly candidates: Candidate[] = [];

  constructor(
    private readonly src: PreparedSource,
    private readonly cfg: Config["matching"],
  ) {}

  /** Scores unseen tracks; returns those admitted. Unplayable tracks are skipped when `playableOnly`. */
  add(tracks: SpotifyTrack[], playableOnly: boolean, minArtist: number): Candidate[] {
    const added: Candidate[] = [];
    for (const t of tracks) {
      if (t.id === null || t.is_local) continue;
      if (this.seen.has(t.id) || (t.linked_from !== undefined && this.seen.has(t.linked_from.id))) continue;
      this.seen.add(t.id);
      if (t.linked_from) this.seen.add(t.linked_from.id);
      if (playableOnly && t.is_playable === false) continue;
      const scored = scorePrepared(this.src, t, this.cfg);
      if (scored.parts.artist < minArtist) continue;
      const c = toCandidate(t.id, t, scored);
      this.candidates.push(c);
      this.byId.set(t.id, c);
      if (t.linked_from) this.byId.set(t.linked_from.id, c);
      added.push(c);
    }
    return added;
  }

  /** Pooled candidates for these tracks, whichever query admitted them (an identity hit must count even for a track a text query saw first). */
  known(tracks: SpotifyTrack[]): Candidate[] {
    const out = new Set<Candidate>();
    for (const t of tracks) {
      const c = (t.id !== null ? this.byId.get(t.id) : undefined) ?? (t.linked_from !== undefined ? this.byId.get(t.linked_from.id) : undefined);
      if (c) out.add(c);
    }
    return [...out];
  }

  sorted(): Candidate[] {
    return [...this.candidates].sort((a, b) => b.score - a.score);
  }
}

function toCandidate(id: string, t: SpotifyTrack, scored: { score: number; parts: ScoreParts }): Candidate {
  return {
    id,
    uri: t.uri,
    title: t.name,
    artists: t.artists.map((a) => a.name),
    album: t.album.name,
    durationMs: t.duration_ms,
    isPlayable: t.is_playable !== false,
    score: scored.score,
    parts: scored.parts,
  };
}

type Hit = { by: "isrc" | "fingerprint"; candidate: Candidate } | { by: "auto" };

/** ISRCs for a local file (Chromaprint → AcoustID → MusicBrainz); replaceable so the decision path can be exercised without `fpcalc`. */
export type IsrcLookup = (path: string, contentHash: string, cfg: Config["matching"], repo: Repo, now: number) => Promise<string[]>;

export class Matcher {
  private readonly api: SpotifyApi;
  private readonly repo: Repo;
  private readonly cfg: Config;
  private readonly market: string;
  private readonly search: TrackSearch;
  private readonly isrcLookup: IsrcLookup;

  constructor(deps: { api: SpotifyApi; repo: Repo; cfg: Config; market: string; isrcLookup?: IsrcLookup }) {
    this.api = deps.api;
    this.repo = deps.repo;
    this.cfg = deps.cfg;
    this.market = deps.market;
    this.search = new TrackSearch(deps.api, deps.repo, deps.cfg.matching, deps.market);
    this.isrcLookup = deps.isrcLookup ?? isrcsByFingerprint;
  }

  /** Network searches spent by this matcher (cache hits excluded). */
  get searchesUsed(): number {
    return this.search.used;
  }

  /**
   * Runs queries in order, admitting playable results into the pool. Stops at the first ISRC hit
   * (returned as the decision) or as soon as some candidate passes the auto gate.
   */
  private async runQueries(pool: CandidatePool, queries: string[], bareTitle: string | null, isrcBy: "isrc" | "fingerprint", now: number): Promise<Hit | null> {
    const m = this.cfg.matching;
    for (const q of queries) {
      const tracks = await this.search.search(q, now);
      const added = pool.add(tracks, true, q === bareTitle ? BARE_TITLE_MIN_ARTIST : 0);
      if (q.startsWith("isrc:")) {
        const hits = pool.known(tracks);
        if (hits.length === 0) continue;
        let best = hits[0]!;
        for (const c of hits) if (c.score > best.score) best = c;
        return { by: isrcBy, candidate: best };
      }
      if (added.some((c) => passesAutoGate(c.score, c.parts, m))) return { by: "auto" };
    }
    return null;
  }

  /**
   * Decides `matched` / `review` / `local` for one source track. User decisions are returned untouched.
   * Does not persist: the caller writes the returned row with `repo.upsertMatch`.
   */
  async matchOne(track: SourceTrackRow, existing: MatchRow | null, now: number): Promise<MatchRow> {
    if (existing?.decidedBy === "user") return existing;
    const m = this.cfg.matching;
    const pool = new CandidatePool(prepareSource(track, m), m);
    const bareTitle = track.artists.length > 0 ? queryTitle(track.title) : null;
    let hit = await this.runQueries(pool, this.search.queriesFor(track), bareTitle, "isrc", now);
    if (hit === null && track.file && m.fingerprint) {
      const isrcs = await this.isrcLookup(track.file.path, track.file.contentHash, m, this.repo, now);
      for (const isrc of isrcs) {
        hit = await this.runQueries(pool, [`isrc:${isrc}`], null, "fingerprint", now);
        if (hit !== null) break;
      }
    }

    let candidates = pool.sorted();
    let winner: { candidate: Candidate; decidedBy: DecidedBy; score: number } | null = null;
    if (hit !== null && hit.by !== "auto") {
      winner = { candidate: hit.candidate, decidedBy: hit.by, score: 1 };
    } else {
      const auto = candidates.find((c) => passesAutoGate(c.score, c.parts, m));
      if (auto) winner = { candidate: auto, decidedBy: "auto", score: auto.score };
    }
    if (winner !== null && !candidates.slice(0, MAX_CANDIDATES).includes(winner.candidate)) {
      candidates = [winner.candidate, ...candidates.filter((c) => c !== winner.candidate)];
    }
    candidates = candidates.slice(0, MAX_CANDIDATES);

    const row: MatchRow = {
      canonicalKey: track.canonicalKey,
      status: "local",
      spotifyId: null,
      spotifyUri: null,
      score: candidates[0]?.score ?? null,
      decidedBy: "auto",
      candidates,
      decidedAt: now,
      lastSearchAt: now,
      searchCount: (existing?.searchCount ?? 0) + 1,
    };
    if (winner !== null) {
      row.status = "matched";
      row.spotifyId = winner.candidate.id;
      row.spotifyUri = `spotify:track:${winner.candidate.id}`;
      row.score = winner.score;
      row.decidedBy = winner.decidedBy;
    } else if (candidates[0] !== undefined && candidates[0].score >= m.review_threshold) {
      row.status = "review";
      row.decidedBy = null;
      row.decidedAt = null;
    }
    return row;
  }

  /** Every scored candidate for the TUI: the full §5.1 query union, or one custom query. Unplayable tracks are kept and flagged. */
  async candidatesFor(track: SourceTrackRow, query?: string): Promise<Candidate[]> {
    const m = this.cfg.matching;
    const pool = new CandidatePool(prepareSource(track, m), m);
    const queries = query === undefined ? this.search.queriesFor(track) : [query];
    const now = Date.now();
    for (const tracks of await mapLimit(queries, SEARCH_CONCURRENCY, (q) => this.search.search(q, now))) pool.add(tracks, false, 0);
    return pool.sorted();
  }

  /** Scores a pasted `spotify:track:` URI or open.spotify.com track URL against the source track. */
  async candidateFromUri(track: SourceTrackRow, uriOrUrl: string): Promise<Candidate | null> {
    const id = TRACK_REF.exec(uriOrUrl.trim())?.[1];
    if (id === undefined) return null;
    const t = await this.api.getTrack(id, this.market);
    if (t === null || t.id === null) return null;
    const m = this.cfg.matching;
    return toCandidate(t.id, t, scorePrepared(prepareSource(track, m), t, m));
  }
}
