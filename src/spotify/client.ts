import { log } from "../util/log.ts";
import { RetryableError, withRetry } from "../util/retry.ts";
import { AuthExpiredError, refreshTokens, type TokenStore } from "./auth.ts";
import type { Paging, SpotifyTokens } from "./types.ts";

const API = "https://api.spotify.com";
const ATTEMPTS = 5;

export type Query = Record<string, string | number | undefined>;

export class SpotifyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    method: string,
    url: string,
  ) {
    super(`Spotify ${method} ${url} → ${status}: ${body}`);
    this.name = "SpotifyHttpError";
  }
}

/** Longest 429 back-off we sleep through in-process; anything longer (Spotify hands out ~24 h for quota exhaustion) aborts the phase. */
const MAX_RETRY_AFTER_MS = 120_000;

/** 429 with a Retry-After beyond MAX_RETRY_AFTER_MS: callers should stop, persist `untilMs`, and continue next run. */
export class SpotifyRateLimitedError extends Error {
  constructor(
    readonly untilMs: number,
    path: string,
  ) {
    super(`Spotify rate limited on ${path} until ${new Date(untilMs).toISOString()}`);
    this.name = "SpotifyRateLimitedError";
  }
}

/** Thin fetch wrapper: bearer injection, proactive + reactive refresh, 429/5xx retry, JSON decoding. */
export class SpotifyClient {
  private readonly clientId: string;
  private readonly store: TokenStore;
  private refreshing: Promise<SpotifyTokens> | null = null;

  constructor(opts: { clientId: string; store: TokenStore }) {
    this.clientId = opts.clientId;
    this.store = opts.store;
  }

  async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    // SPOTIFIFY_SPOTIFY_API lets an in-process fake stand in for the Web API in end-to-end tests.
    const url = new URL(path.startsWith("http") ? path : (process.env.SPOTIFIFY_SPOTIFY_API ?? API) + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

    let retriedAuth = false;
    return withRetry(
      async () => {
        const token = await this.accessToken();
        const res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          body,
        });
        const text = await res.text();
        if (res.ok) return (text === "" ? undefined : JSON.parse(text)) as T;

        if (res.status === 401 && !retriedAuth) {
          retriedAuth = true;
          await this.refresh();
          throw new RetryableError("401; refreshed token", 0);
        }
        if (res.status === 429) {
          const secs = Number(res.headers.get("Retry-After") ?? "1");
          const waitMs = (Number.isFinite(secs) ? secs : 1) * 1000;
          if (waitMs > MAX_RETRY_AFTER_MS) throw new SpotifyRateLimitedError(Date.now() + waitMs, url.pathname);
          log.warn(`Spotify rate limited; waiting ${secs}s`, { method, path: url.pathname });
          throw new RetryableError(`429 on ${method} ${url.pathname}`, waitMs);
        }
        // A 5xx on a write may arrive after Spotify applied it (a re-sent POST would add twice, a re-sent
        // reorder move twice), so only reads are retried; a failed write ends the run and the next one re-plans.
        if (res.status >= 500 && method === "GET") throw new RetryableError(`${res.status} on ${method} ${url.pathname}`);
        throw new SpotifyHttpError(res.status, text, method, url.pathname);
      },
      { attempts: ATTEMPTS },
    );
  }

  /** Follows `Paging.next` until exhausted. */
  async paginate<T>(path: string, query?: Query): Promise<T[]> {
    const out: T[] = [];
    let page = await this.request<Paging<T>>("GET", path, { query });
    for (;;) {
      out.push(...page.items);
      if (page.next === null) return out;
      page = await this.request<Paging<T>>("GET", page.next);
    }
  }

  private async accessToken(): Promise<string> {
    const tokens = this.store.load();
    if (tokens === null) throw new AuthExpiredError();
    if (tokens.expires_at > Date.now()) return tokens.access_token;
    return (await this.refresh()).access_token;
  }

  /** Concurrent callers share one refresh so a burst of expired requests does not spam the token endpoint. */
  private refresh(): Promise<SpotifyTokens> {
    if (this.refreshing) return this.refreshing;
    const tokens = this.store.load();
    if (tokens === null) throw new AuthExpiredError();
    this.refreshing = refreshTokens(this.clientId, tokens)
      .then((fresh) => {
        this.store.save(fresh);
        return fresh;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }
}
