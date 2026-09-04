/**
 * End-to-end: real local source (ffmpeg-generated files) → real matcher → real plan/apply against an
 * in-process fake of the Spotify Web API. Exercises idempotency (second run = zero writes), drift
 * repair (reorder / re-add), local-file paste reconciliation, and prune semantics.
 * Skipped when ffmpeg is not on PATH.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Config } from "../src/config.ts";
import { parseLocalUri } from "../src/spotify/localUri.ts";
import { SpotifyApi } from "../src/spotify/api.ts";
import { SpotifyClient } from "../src/spotify/client.ts";
import type { SpotifyPlaylist, SpotifyPlaylistItem, SpotifyTrack } from "../src/spotify/types.ts";
import { openDatabase } from "../src/state/db.ts";
import { Repo } from "../src/state/repo.ts";
import { runSync } from "../src/sync/run.ts";
import { probeBinary } from "../src/util/bin.ts";
import { buildNcm } from "./helpers/ncm.ts";

// ---- fake Spotify ------------------------------------------------------------

interface FakePlaylist {
  id: string;
  name: string;
  description: string;
  snapshot: number;
  items: string[];
}

class FakeSpotify {
  readonly catalog = new Map<string, SpotifyTrack>();
  readonly playlists = new Map<string, FakePlaylist>();
  readonly saved = new Set<string>();
  readonly writes: string[] = [];
  /** number of /v1/search calls served; beyond `searchQuota` the fake answers 429 with a day-long Retry-After */
  searchCalls = 0;
  searchQuota: number | null = null;
  /** emulate development-mode apps for which /me/tracks/contains answers 403 */
  containsForbidden = false;
  private seq = 0;
  server: ReturnType<typeof Bun.serve> | null = null;

  addTrack(id: string, name: string, artist: string, album: string, durationMs: number): void {
    this.catalog.set(id, {
      id,
      uri: `spotify:track:${id}`,
      name,
      artists: [{ id: `a-${artist}`, name: artist }],
      album: { id: `al-${album}`, name: album },
      duration_ms: durationMs,
      is_local: false,
      is_playable: true,
    });
  }

  start(): string {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server?.stop(true);
  }

  private trackObject(uri: string): SpotifyTrack {
    const local = parseLocalUri(uri);
    if (local) {
      return {
        id: null,
        uri,
        name: local.title,
        artists: [{ id: null, name: local.artist }],
        album: { id: null, name: local.album },
        duration_ms: 0,
        is_local: true,
      };
    }
    const t = this.catalog.get(uri.replace("spotify:track:", ""));
    if (!t) throw new Error(`fake: unknown uri ${uri}`);
    return t;
  }

  private playlistObject(p: FakePlaylist): SpotifyPlaylist {
    return { id: p.id, name: p.name, description: p.description, snapshot_id: `s${p.snapshot}`, owner: { id: "me" } };
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    const body = method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
    if (method !== "GET") this.writes.push(`${method} ${path}`);

    if (path === "/v1/me") return json({ id: "me", country: "US" });

    if (path === "/v1/search") {
      this.searchCalls++;
      if (this.searchQuota !== null && this.searchCalls > this.searchQuota) {
        return new Response(JSON.stringify({ error: { status: 429, message: "quota" } }), { status: 429, headers: { "Retry-After": "86400" } });
      }
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      if (q.startsWith("isrc:")) return json({ tracks: { items: [] } });
      const tokens = q.replace(/\b(track|artist|album):/g, " ").replace(/"/g, " ").split(/\s+/).filter(Boolean);
      const items = [...this.catalog.values()].filter((t) => {
        const hay = `${t.name} ${t.artists.map((a) => a.name).join(" ")}`.toLowerCase();
        return tokens.every((tok) => hay.includes(tok));
      });
      return json({ tracks: { items } });
    }

    const track = path.match(/^\/v1\/tracks\/([^/]+)$/);
    if (track) {
      const t = this.catalog.get(track[1]!);
      return t ? json(t) : json({ error: { status: 404, message: "not found" } }, 404);
    }

    if (path === "/v1/me/playlists" && method === "GET") {
      return json({ items: [...this.playlists.values()].map((p) => this.playlistObject(p)), next: null, total: this.playlists.size });
    }
    if (path === "/v1/me/playlists" && method === "POST") {
      const p: FakePlaylist = { id: `pl${++this.seq}`, name: String(body.name), description: String(body.description ?? ""), snapshot: 0, items: [] };
      this.playlists.set(p.id, p);
      return json(this.playlistObject(p), 201);
    }

    const pl = path.match(/^\/v1\/playlists\/([^/]+)(\/items)?$/);
    if (pl) {
      const p = this.playlists.get(pl[1]!);
      if (!p) return json({ error: { status: 404, message: "not found" } }, 404);
      if (!pl[2]) {
        if (method === "GET") return json(this.playlistObject(p));
        if (method === "PUT") {
          p.name = String(body.name ?? p.name);
          return new Response(null, { status: 200 });
        }
      } else {
        if (method === "GET") {
          const limit = Number(url.searchParams.get("limit") ?? 50);
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const items: SpotifyPlaylistItem[] = p.items.slice(offset, offset + limit).map((uri) => {
            const t = this.trackObject(uri);
            return { added_at: "2026-01-01T00:00:00Z", is_local: t.is_local, item: t };
          });
          const nextOffset = offset + limit;
          const next = nextOffset < p.items.length ? `${url.origin}${path}?limit=${limit}&offset=${nextOffset}` : null;
          return json({ items, next, total: p.items.length });
        }
        if (method === "POST") {
          const uris = body.uris as string[];
          if (uris.some((u) => u.startsWith("spotify:local:"))) return json({ error: { status: 400, message: "Invalid track uri" } }, 400);
          const pos = typeof body.position === "number" ? body.position : p.items.length;
          p.items.splice(pos, 0, ...uris);
          p.snapshot++;
          return json({ snapshot_id: `s${p.snapshot}` }, 201);
        }
        if (method === "PUT") {
          if (Array.isArray(body.uris)) {
            p.items = [...(body.uris as string[])];
          } else {
            if (body.snapshot_id !== `s${p.snapshot}`) return json({ error: { status: 400, message: "stale snapshot" } }, 400);
            const start = body.range_start as number;
            const len = (body.range_length as number | undefined) ?? 1;
            let before = body.insert_before as number;
            const moved = p.items.splice(start, len);
            if (before > start) before -= len;
            p.items.splice(before, 0, ...moved);
          }
          p.snapshot++;
          return json({ snapshot_id: `s${p.snapshot}` });
        }
        if (method === "DELETE") {
          if (body.snapshot_id !== `s${p.snapshot}`) return json({ error: { status: 400, message: "stale snapshot" } }, 400);
          const drop = new Set<number>();
          if (Array.isArray(body.positions)) {
            for (const i of body.positions as number[]) drop.add(i);
          } else {
            for (const s of body.items as Array<{ uri: string }>) {
              // the real endpoint parses every uri as a track id; local files can only be removed by position
              if (s.uri.startsWith("spotify:local:")) return json({ error: { status: 400, message: "Invalid base62 id" } }, 400);
              p.items.forEach((u, i) => u === s.uri && drop.add(i));
            }
          }
          p.items = p.items.filter((_, i) => !drop.has(i));
          p.snapshot++;
          return json({ snapshot_id: `s${p.snapshot}` });
        }
      }
    }

    const uriIds = () => (url.searchParams.get("uris") ?? "").split(",").filter(Boolean).map((u) => u.replace("spotify:track:", ""));
    if (path === "/v1/me/library/contains") {
      if (this.containsForbidden) return json({ error: { status: 403, message: "Forbidden" } }, 403);
      return json(uriIds().map((id) => this.saved.has(id)));
    }
    if (path === "/v1/me/library" && method === "PUT") {
      for (const id of uriIds()) this.saved.add(id);
      return new Response(null, { status: 200 });
    }
    if (path === "/v1/me/library" && method === "DELETE") {
      for (const id of uriIds()) this.saved.delete(id);
      return new Response(null, { status: 200 });
    }
    if (path === "/v1/me/tracks" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const all = [...this.saved];
      const items = all.slice(offset, offset + limit).map((id) => ({ added_at: "2026-01-01T00:00:00Z", track: this.catalog.get(id) ?? null }));
      const next = offset + limit < all.length ? `${url.origin}${path}?limit=${limit}&offset=${offset + limit}` : null;
      return json({ items, next, total: all.length });
    }
    return json({ error: { status: 404, message: `fake: unhandled ${method} ${path}` } }, 404);
  }
}

// ---- fixtures ------------------------------------------------------------------

async function makeAudio(path: string, tags: { title: string; artist: string; album: string }, codec: string[]): Promise<void> {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-map_metadata", "-1"];
  args.push("-metadata", `title=${tags.title}`, "-metadata", `artist=${tags.artist}`, "-metadata", `album=${tags.album}`, ...codec, path);
  const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg fixture failed: ${await new Response(proc.stderr).text()}`);
}

const haveFfmpeg = (await probeBinary("ffmpeg", ["-version"])) !== null;

describe.skipIf(!haveFfmpeg)("end-to-end sync against a fake Spotify", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-e2e-"));
  const musicDir = join(root, "music");
  const exportDir = join(root, "export");
  const stateDir = join(root, "state");
  const fake = new FakeSpotify();
  let cfg: Config;
  let repo: Repo;
  let api: SpotifyApi;

  const sync = (over: Partial<{ prune: boolean; dryRun: boolean }> = {}) =>
    runSync({ cfg, repo, api }, { dryRun: over.dryRun ?? false, prune: over.prune ?? false, skipMatch: false });

  beforeAll(async () => {
    process.env.SPOTIFIFY_SPOTIFY_API = fake.start();

    fake.addTrack("t1", "Song One", "Artist A", "Album", 2000);
    fake.addTrack("t2", "Song Two", "Artist B", "Album", 2000);

    await Bun.write(join(musicDir, ".keep"), "");
    await makeAudio(join(musicDir, "Artist A - Song One.mp3"), { title: "Song One", artist: "Artist A", album: "Album" }, ["-c:a", "libmp3lame", "-b:a", "64k"]);
    await makeAudio(join(musicDir, "Artist B - Song Two.mp3"), { title: "Song Two", artist: "Artist B", album: "Album" }, ["-c:a", "libmp3lame", "-b:a", "64k"]);
    await makeAudio(join(musicDir, "Artist C - Unknown Song.flac"), { title: "Unknown Song", artist: "Artist C", album: "Album" }, ["-c:a", "flac"]);

    cfg = ConfigSchema.parse({
      spotify: { client_id: "fake" },
      netease: { enabled: false },
      local: { dirs: [musicDir], like_matched: true },
      export: { dir: exportDir },
    });
    repo = new Repo(openDatabase(stateDir));
    repo.setAuth("spotify", { access_token: "tok", refresh_token: "ref", expires_at: Date.now() + 3_600_000, scope: "" }, Date.now());
    api = new SpotifyApi(new SpotifyClient({ clientId: "fake", store: { load: () => repo.getAuth("spotify"), save: () => {} } }));
  });

  afterAll(() => {
    fake.stop();
    repo.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const playlist = () => [...fake.playlists.values()][0]!;

  test("first sync: creates the playlist in source order, likes matches, exports the unmatched file", async () => {
    const { summary } = await sync();
    expect(summary.pulled.local.tracks).toBe(3);
    expect(summary.matched).toEqual({ searched: 3, matched: 2, review: 0, local: 1, remaining: 0, blockedUntil: null, budgetExhausted: false });
    expect(fake.playlists.size).toBe(1);
    expect(playlist().name).toBe("Local Library");
    expect(playlist().description).toBe("Managed by Spotifify");
    expect(playlist().items).toEqual(["spotify:track:t1", "spotify:track:t2"]);
    expect([...fake.saved].sort()).toEqual(["t1", "t2"]);
    expect(summary.apply?.exported).toBe(1);
    expect(readdirSync(exportDir)).toEqual(["Artist C - Unknown Song.mp3"]);
    expect(summary.awaiting).toEqual([{ playlist: "Local Library", uris: ["spotify:local:Artist+C:Album:Unknown+Song:2"] }]);
  });

  test("second sync is a no-op: no write requests", async () => {
    fake.writes.length = 0;
    const { summary, plan } = await sync();
    expect(fake.writes).toEqual([]);
    expect(summary.matched.searched).toBe(0);
    expect(plan.playlists[0]?.adds).toEqual([]);
    expect(plan.playlists[0]?.moves).toEqual([]);
    expect(plan.exports).toEqual([]);
  });

  test("likes are still reconciled when /me/tracks/contains is forbidden (library listing fallback)", async () => {
    fake.containsForbidden = true;
    fake.saved.delete("t2"); // user unliked one match by hand
    fake.writes.length = 0;
    const { plan } = await sync();
    expect(plan.likes.add).toEqual(["t2"]);
    expect(fake.saved.has("t2")).toBe(true);
    expect(fake.writes).toEqual(["PUT /v1/me/library"]);
    fake.containsForbidden = false;
  });

  test("remote drift is repaired: manual reorder is undone and a manually removed track is re-added", async () => {
    playlist().items = ["spotify:track:t2"]; // user removed t1
    fake.saved.delete("t1"); // and unliked it
    await sync();
    expect(playlist().items).toEqual(["spotify:track:t1", "spotify:track:t2"]);
    expect(fake.saved.has("t1")).toBe(true);

    playlist().items = ["spotify:track:t2", "spotify:track:t1"]; // user reordered
    const { summary } = await sync();
    expect(summary.apply?.moved).toBe(1);
    expect(playlist().items).toEqual(["spotify:track:t1", "spotify:track:t2"]);
  });

  test("a pasted entry the client normalised to `:0` is stale: pruned with --prune, while the timed identity is recognised", async () => {
    playlist().items.unshift("spotify:local:Artist+C:Album:Unknown+Song:0"); // what a bare three-segment paste becomes
    const reported = await sync();
    expect(reported.plan.playlists[0]?.prune).toEqual([{ uri: "spotify:local:Artist+C:Album:Unknown+Song:0", positions: [0] }]);
    expect(reported.summary.awaiting).toEqual([{ playlist: "Local Library", uris: ["spotify:local:Artist+C:Album:Unknown+Song:2"] }]);
    expect(playlist().items).toContain("spotify:local:Artist+C:Album:Unknown+Song:0"); // report only: kept (moved to the tail)

    await sync({ prune: true });
    expect(playlist().items).toEqual(["spotify:track:t1", "spotify:track:t2"]);

    // The user pastes the correct identity (the client re-encodes "(" as "%28", canonically equal); it keeps its source position.
    playlist().items.unshift("spotify:local:Artist+C:Album:Unknown+Song:2");
    const { summary } = await sync();
    expect(summary.awaiting).toEqual([]);
    expect(playlist().items).toEqual(["spotify:track:t1", "spotify:track:t2", "spotify:local:Artist+C:Album:Unknown+Song:2"]);
  });

  test("foreign items are never removed and stay at the tail", async () => {
    fake.addTrack("t9", "Nine", "Someone", "Other", 1000);
    playlist().items.splice(1, 0, "spotify:track:t9"); // user inserted their own track in the middle
    const { plan } = await sync();
    expect(plan.playlists[0]?.foreign).toEqual(["spotify:track:t9"]);
    expect(plan.playlists[0]?.prune).toEqual([]);
    expect(playlist().items).toEqual(["spotify:track:t1", "spotify:track:t2", "spotify:local:Artist+C:Album:Unknown+Song:2", "spotify:track:t9"]);
  });

  test("a track removed from the source is only reported until --prune, then removed and unliked", async () => {
    rmSync(join(musicDir, "Artist B - Song Two.mp3"));
    const reported = await sync();
    expect(reported.summary.plan.prune).toBe(1);
    expect(reported.summary.plan.unlikes).toBe(1);
    expect(playlist().items).toContain("spotify:track:t2");
    expect(fake.saved.has("t2")).toBe(true);

    const pruned = await sync({ prune: true });
    expect(pruned.summary.apply?.pruned).toBe(1);
    expect(pruned.summary.apply?.unliked).toBe(1);
    expect(playlist().items).toEqual(["spotify:track:t1", "spotify:local:Artist+C:Album:Unknown+Song:2", "spotify:track:t9"]);
    expect(fake.saved.has("t2")).toBe(false);
  });

  test("dry run plans but never writes", async () => {
    playlist().items = ["spotify:track:t9", "spotify:track:t1", "spotify:local:Artist+C:Album:Unknown+Song:2"];
    fake.writes.length = 0;
    const { plan, summary } = await sync({ dryRun: true });
    expect(plan.playlists[0]?.moves.length).toBeGreaterThan(0);
    expect(summary.apply).toBeNull();
    expect(fake.writes).toEqual([]);
  });
});

describe.skipIf(!haveFfmpeg)("search quota handling", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-quota-"));
  const musicDir = join(root, "music");
  const fake = new FakeSpotify();
  let cfg: Config;
  let repo: Repo;
  let api: SpotifyApi;

  const sync = () => runSync({ cfg, repo, api }, { dryRun: false, prune: false, skipMatch: false });

  beforeAll(async () => {
    process.env.SPOTIFIFY_SPOTIFY_API = fake.start();
    mkdirSync(musicDir, { recursive: true });
    for (const n of ["One", "Two", "Three", "Four"]) {
      fake.addTrack(`t${n}`, `Song ${n}`, `Artist ${n}`, "Album", 2000);
      await makeAudio(join(musicDir, `Artist ${n} - Song ${n}.mp3`), { title: `Song ${n}`, artist: `Artist ${n}`, album: "Album" }, ["-c:a", "libmp3lame", "-b:a", "64k"]);
    }
    cfg = ConfigSchema.parse({
      spotify: { client_id: "fake" },
      netease: { enabled: false },
      local: { dirs: [musicDir] },
      export: { dir: join(root, "export") },
      matching: { max_searches_per_run: 2, search_concurrency: 1, search_min_interval_ms: 0 },
    });
    repo = new Repo(openDatabase(join(root, "state")));
    repo.setAuth("spotify", { access_token: "tok", refresh_token: "ref", expires_at: Date.now() + 3_600_000, scope: "" }, Date.now());
    api = new SpotifyApi(new SpotifyClient({ clientId: "fake", store: { load: () => repo.getAuth("spotify"), save: () => {} } }));
  });

  afterAll(() => {
    fake.stop();
    repo.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("per-run budget stops matching early, applies what was matched, and resumes next run", async () => {
    const first = (await sync()).summary;
    expect(first.matched.budgetExhausted).toBe(true);
    expect(first.matched.searched).toBe(2);
    expect(first.matched.remaining).toBe(2);
    expect(fake.searchCalls).toBe(2);
    expect([...fake.playlists.values()][0]?.items.length).toBe(2);

    const second = (await sync()).summary;
    expect(second.matched.searched).toBe(2);
    expect(second.matched.remaining).toBe(0);
    expect([...fake.playlists.values()][0]?.items.length).toBe(4);
  });

  test("a day-long Retry-After aborts the phase and is remembered until it expires", async () => {
    cfg.matching.max_searches_per_run = 0;
    fake.addTrack("tFive", "Song Five", "Artist Five", "Album", 2000);
    await makeAudio(join(musicDir, "Artist Five - Song Five.mp3"), { title: "Song Five", artist: "Artist Five", album: "Album" }, ["-c:a", "libmp3lame", "-b:a", "64k"]);
    fake.searchQuota = fake.searchCalls; // every further search is refused

    const blocked = (await sync()).summary;
    expect(blocked.matched.blockedUntil).toBeGreaterThan(Date.now() + 80_000_000);
    expect(blocked.matched.searched).toBe(0);
    expect(blocked.matched.remaining).toBe(1);
    expect(repo.metaGet("spotify_search_blocked_until")).not.toBeNull();

    const calls = fake.searchCalls;
    const skipped = (await sync()).summary;
    expect(skipped.matched.blockedUntil).toBe(blocked.matched.blockedUntil);
    expect(fake.searchCalls).toBe(calls); // no search attempted while blocked

    repo.metaSet("spotify_search_blocked_until", String(Date.now() - 1)); // deadline passed
    fake.searchQuota = null;
    const resumed = (await sync()).summary;
    expect(resumed.matched.blockedUntil).toBeNull();
    expect(resumed.matched.searched).toBe(1);
    expect(repo.metaGet("spotify_search_blocked_until")).toBeNull();
  });
});

describe.skipIf(!haveFfmpeg)("netease track backed by a local .ncm (mirror_playlist = false)", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-ncm-"));
  const musicDir = join(root, "music");
  const exportDir = join(root, "export");
  const fake = new FakeSpotify();
  let cfg: Config;
  let repo: Repo;
  let api: SpotifyApi;

  beforeAll(async () => {
    process.env.SPOTIFIFY_SPOTIFY_API = fake.start();
    mkdirSync(musicDir, { recursive: true });
    // Real mp3 bytes inside a synthetic .ncm whose header names netease song 424242.
    await makeAudio(join(root, "raw.mp3"), { title: "Unknown Song", artist: "Artist C", album: "Album" }, ["-c:a", "libmp3lame", "-b:a", "64k"]);
    const meta = { musicId: 424242, musicName: "Unknown Song", artist: [["Artist C", 7]], album: "Album", format: "mp3", duration: 2000 };
    writeFileSync(
      join(musicDir, "Artist C - Unknown Song.ncm"),
      buildNcm({ rc4Key: Buffer.from("e2e-key"), metaText: "music:" + JSON.stringify(meta), cover: Buffer.alloc(0), audio: readFileSync(join(root, "raw.mp3")) }),
    );
    // A second local file that belongs to no mirrored playlist: must be neither searched nor exported.
    await makeAudio(join(musicDir, "Artist Z - Other.mp3"), { title: "Other", artist: "Artist Z", album: "Album" }, ["-c:a", "libmp3lame", "-b:a", "64k"]);

    cfg = ConfigSchema.parse({
      spotify: { client_id: "fake" },
      netease: { enabled: false },
      local: { dirs: [musicDir], mirror_playlist: false },
      export: { dir: exportDir },
      matching: { search_min_interval_ms: 0 },
    });
    repo = new Repo(openDatabase(join(root, "state")));
    repo.setAuth("spotify", { access_token: "tok", refresh_token: "ref", expires_at: Date.now() + 3_600_000, scope: "" }, Date.now());
    // Stand in for a netease pull: one playlist whose only track has no Spotify counterpart.
    repo.savePull(
      "netease",
      [
        {
          playlist: { kind: "netease", externalId: "p1", name: "我喜欢的音乐" },
          tracks: [{ kind: "netease", externalId: "424242", title: "Unknown Song", artists: ["Artist C"], album: "Album", durationMs: 2000, neteaseId: 424242, aliases: [] }],
        },
      ],
      Date.now(),
    );
    api = new SpotifyApi(new SpotifyClient({ clientId: "fake", store: { load: () => repo.getAuth("spotify"), save: () => {} } }));
  });

  afterAll(() => {
    fake.stop();
    repo.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the .ncm supplies the audio: exported once, listed as awaiting paste for the netease playlist, no Local Library mirrored", async () => {
    const { summary, plan } = await runSync({ cfg, repo, api }, { dryRun: false, prune: false, skipMatch: false });
    expect(summary.matched.searched).toBe(1); // only the netease track's key; "Other" is not in any mirrored playlist
    expect([...fake.playlists.values()].map((p) => p.name)).toEqual(["我喜欢的音乐"]);
    expect(readdirSync(exportDir)).toEqual(["Artist C - Unknown Song.mp3"]);
    expect(plan.playlists[0]?.awaiting.map((a) => a.uri)).toEqual(["spotify:local:Artist+C:Album:Unknown+Song:2"]);
    expect(summary.awaiting).toEqual([{ playlist: "我喜欢的音乐", uris: ["spotify:local:Artist+C:Album:Unknown+Song:2"] }]);

    const again = await runSync({ cfg, repo, api }, { dryRun: false, prune: false, skipMatch: false });
    expect(again.summary.matched.searched).toBe(0);
    expect(again.summary.apply?.exported).toBe(0);
  });
});
