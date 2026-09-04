import { login_status, playlist_detail, song_detail, user_playlist } from "./lib.ts";
import { z } from "zod";
import { log } from "../../util/log.ts";
import { chunk, RetryableError, sleep, withRetry } from "../../util/retry.ts";

export interface NeteasePlaylistSummary {
  id: number;
  name: string;
  creatorId: number;
  specialType: number;
  trackCount: number;
  updateTime: number;
  trackUpdateTime: number;
}

export interface NeteaseSong {
  id: number;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  aliases: string[];
}

/** Cookie invalid / expired: the CLI exits 3 without doing anything else. */
export class NeteaseAuthError extends Error {
  constructor(message = "netease login required (cookie missing or expired)") {
    super(message);
    this.name = "NeteaseAuthError";
  }
}

// Response bodies as observed from NeteaseCloudMusicApi 4.32.0. The library resolves `{ status, body }` and
// *rejects* with the same plain-object shape (not an Error) whenever the API code is not 200 / a special code.
const LoginStatusBody = z.object({
  data: z.object({ profile: z.object({ userId: z.number(), nickname: z.string().default("") }).nullish() }).optional(),
});
const UserPlaylistBody = z.object({
  more: z.boolean().default(false),
  playlist: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        creator: z.object({ userId: z.number() }).nullish(),
        userId: z.number().optional(),
        specialType: z.number().default(0),
        trackCount: z.number().default(0),
        updateTime: z.number().default(0),
        trackUpdateTime: z.number().optional(),
      }),
    )
    .default([]),
});
const PlaylistDetailBody = z.object({
  playlist: z.object({
    trackIds: z.array(z.object({ id: z.number() })).default([]),
    updateTime: z.number().default(0),
    trackUpdateTime: z.number().optional(),
  }),
});
// Cloud-disk uploads (and some delisted songs) carry null `name` / `ar[].name` / `al.name`; uploads keep the
// original file metadata under `pc` (sn = title, ar = artist, alb = album).
const SongDetailBody = z.object({
  songs: z
    .array(
      z.object({
        id: z.number(),
        name: z.string().nullish(),
        ar: z.array(z.object({ name: z.string().nullish() })).nullish(),
        al: z.object({ name: z.string().nullish() }).nullish(),
        dt: z.number().nullish(),
        alia: z.array(z.string().nullish()).nullish(),
        tns: z.array(z.string().nullish()).nullish(),
        pc: z.object({ sn: z.string().nullish(), ar: z.string().nullish(), alb: z.string().nullish() }).nullish(),
      }),
    )
    .default([]),
});
const Failure = z.object({
  status: z.number().optional(),
  body: z.object({ code: z.number().optional(), msg: z.string().optional(), message: z.string().optional() }).optional(),
});
const Envelope = z.object({ status: z.number(), body: z.object({ code: z.number().optional() }).passthrough() });

export const REQUEST_GAP_MS = 200;
const SONG_DETAIL_BATCH = 500;
const PLAYLIST_PAGE = 1000;

/** Normalizes a library rejection (plain object) or thrown Error into our error taxonomy. */
function toError(e: unknown): Error {
  if (e instanceof Error) {
    // the library routes network failures into status-502 objects; a genuine throw is a client-side transport fault
    return new RetryableError(`netease request failed: ${e.message}`);
  }
  const parsed = Failure.safeParse(e);
  const f = parsed.success ? parsed.data : {};
  const status = f.status ?? 0;
  const code = f.body?.code ?? status;
  const msg = f.body?.msg ?? f.body?.message ?? "";
  if (code === 301 || status === 301 || msg.includes("需要登录")) return new NeteaseAuthError();
  if (status >= 500 || code >= 500) return new RetryableError(`netease upstream error ${code}${msg ? `: ${msg}` : ""}`);
  return new Error(`netease api error ${code}${msg ? `: ${msg}` : ""}`);
}

async function call<S extends z.ZodType>(what: string, schema: S, fn: () => Promise<unknown>): Promise<z.infer<S>> {
  return withRetry(async () => {
    let raw: unknown;
    try {
      raw = await fn();
    } catch (e) {
      throw toError(e);
    }
    const env = Envelope.safeParse(raw);
    if (!env.success) throw new Error(`netease ${what}: unexpected response envelope`);
    const code = env.data.body.code;
    if (code !== undefined && code !== 200) throw toError(env.data);
    const body = schema.safeParse(env.data.body);
    if (!body.success) throw new Error(`netease ${what}: unexpected body shape: ${body.error.message}`);
    return body.data;
  });
}

export class NeteaseClient {
  constructor(private readonly cookie: string) {}

  async loginStatus(): Promise<{ uid: number; nickname: string } | null> {
    const body = await call("login_status", LoginStatusBody, () => login_status({ cookie: this.cookie }));
    const profile = body.data?.profile;
    return profile ? { uid: profile.userId, nickname: profile.nickname } : null;
  }

  async userPlaylists(uid: number): Promise<NeteasePlaylistSummary[]> {
    const out: NeteasePlaylistSummary[] = [];
    for (let offset = 0; ; offset += PLAYLIST_PAGE) {
      if (offset > 0) await sleep(REQUEST_GAP_MS);
      const body = await call("user_playlist", UserPlaylistBody, () => user_playlist({ cookie: this.cookie, uid, limit: PLAYLIST_PAGE, offset }));
      for (const p of body.playlist) {
        out.push({
          id: p.id,
          name: p.name,
          creatorId: p.creator?.userId ?? p.userId ?? -1,
          specialType: p.specialType,
          trackCount: p.trackCount,
          updateTime: p.updateTime,
          trackUpdateTime: p.trackUpdateTime ?? p.updateTime,
        });
      }
      if (!body.more || body.playlist.length === 0) return out;
    }
  }

  async playlistTrackIds(id: number): Promise<{ ids: number[]; updateTime: number; trackUpdateTime: number }> {
    const body = await call("playlist_detail", PlaylistDetailBody, () => playlist_detail({ cookie: this.cookie, id }));
    const pl = body.playlist;
    return { ids: pl.trackIds.map((t) => t.id), updateTime: pl.updateTime, trackUpdateTime: pl.trackUpdateTime ?? pl.updateTime };
  }

  /** Fetches song metadata in serial batches of 500 with a 200 ms gap; output order follows `ids`. */
  async songDetails(ids: number[]): Promise<NeteaseSong[]> {
    const byId = new Map<number, NeteaseSong>();
    const batches = chunk(ids, SONG_DETAIL_BATCH);
    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await sleep(REQUEST_GAP_MS);
      const batch = batches[i]!;
      const body = await call("song_detail", SongDetailBody, () => song_detail({ cookie: this.cookie, ids: batch.join(",") }));
      for (const s of body.songs) {
        const artists = (s.ar ?? []).map((a) => a.name ?? "").filter((n) => n.length > 0);
        if (artists.length === 0 && s.pc?.ar) artists.push(s.pc.ar);
        byId.set(s.id, {
          id: s.id,
          name: s.name || s.pc?.sn || "",
          artists,
          album: s.al?.name || s.pc?.alb || "",
          durationMs: s.dt ?? 0,
          aliases: [...(s.alia ?? []), ...(s.tns ?? [])].filter((a): a is string => typeof a === "string" && a.length > 0),
        });
      }
      log.debug("netease song_detail", { batch: i + 1, of: batches.length, requested: batch.length, got: body.songs.length });
    }
    const out: NeteaseSong[] = [];
    for (const id of ids) {
      const s = byId.get(id);
      if (s) out.push(s);
    }
    return out;
  }
}
