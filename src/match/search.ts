import type { Config } from "../config.ts";
import type { SpotifyApi } from "../spotify/api.ts";
import type { SpotifyTrack } from "../spotify/types.ts";
import type { Repo } from "../state/repo.ts";
import { sleep } from "../util/retry.ts";
import { splitAnnotations, versionTagsOf } from "./normalize.ts";
import type { ScoreInput } from "./score.ts";

const DAY_MS = 86_400_000;
const SEARCH_LIMIT = 10;
const QUOTES = /["'“”‘’]/g;

/** Thrown on a cache miss once `matching.max_searches_per_run` network searches have been spent. */
export class SearchBudgetExhaustedError extends Error {
  constructor(readonly budget: number) {
    super(`search budget of ${budget} requests for this run is used up`);
    this.name = "SearchBudgetExhaustedError";
  }
}

/** Query-friendly form of a title: annotations removed, version tags kept as plain words, quotes stripped. */
export function queryTitle(title: string): string {
  const { base, segments } = splitAnnotations(title);
  const words = [base];
  for (const seg of segments) words.push(...versionTagsOf(seg));
  return words.join(" ").replace(QUOTES, "").replace(/\s+/g, " ").trim();
}

export class TrackSearch {
  private readonly ttlMs: number;
  private readonly budget: number;
  private readonly maxQueries: number;
  private readonly minIntervalMs: number;
  private networkSearches = 0;
  /** Serializes the pacing gap so concurrent callers never exceed one request per `minIntervalMs`. */
  private gate: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: SpotifyApi,
    private readonly repo: Repo,
    cfg: Config["matching"],
    private readonly market: string,
  ) {
    this.ttlMs = cfg.search_cache_ttl_days * DAY_MS;
    this.budget = cfg.max_searches_per_run === 0 ? Number.POSITIVE_INFINITY : cfg.max_searches_per_run;
    this.maxQueries = cfg.max_queries_per_track;
    this.minIntervalMs = cfg.search_min_interval_ms;
  }

  /** Network searches performed so far in this process. */
  get used(): number {
    return this.networkSearches;
  }

  /** Runs a search, serving from `search_cache` when a fresh entry exists for (query, market). */
  async search(q: string, now: number): Promise<SpotifyTrack[]> {
    const key = new Bun.CryptoHasher("sha1").update(`${q}\u0000${this.market}`).digest("hex");
    const cached = this.repo.cacheGet<SpotifyTrack[]>(key, now, this.ttlMs);
    if (cached) return cached;
    if (this.networkSearches >= this.budget) throw new SearchBudgetExhaustedError(this.budget);
    this.networkSearches++;
    await this.pace();
    const tracks = await this.api.searchTracks(q, this.market, SEARCH_LIMIT);
    this.repo.cacheSet(key, tracks, now);
    return tracks;
  }

  private pace(): Promise<void> {
    const turn = this.gate.then(() => sleep(this.minIntervalMs));
    this.gate = turn.catch(() => undefined);
    return turn;
  }

  /**
   * DESIGN.md §5.1 query sequence: isrc → fielded title+artist → free text → aliases → bare title.
   * Deduped, in order, capped at `max_queries_per_track` while always keeping the bare-title fallback last.
   */
  queriesFor(src: ScoreInput & { isrc?: string }): string[] {
    const primary = new Set<string>();
    if (src.isrc) primary.add(`isrc:${src.isrc.toUpperCase()}`);
    const artist = src.artists[0]?.replace(QUOTES, "").trim();
    const titles = [src.title, ...src.aliases].map(queryTitle).filter((t) => t.length > 0);
    for (const title of titles) {
      if (artist) {
        primary.add(`track:"${title}" artist:"${artist}"`);
        primary.add(`${title} ${artist}`);
      } else {
        primary.add(`track:"${title}"`);
      }
    }
    const bare = titles[0];
    if (bare === undefined) return [...primary].slice(0, this.maxQueries);
    primary.delete(bare);
    const head = [...primary].slice(0, Math.max(0, this.maxQueries - 1));
    return [...head, bare];
  }
}
