/**
 * End-to-end: real local source (ffmpeg-generated files) → real matcher → real plan/apply against an
 * in-process fake of the Spotify Web API. Exercises idempotency (second run = zero writes), drift
 * repair (reorder / re-add), local-file paste reconciliation, and prune semantics.
 * Skipped when ffmpeg is not on PATH.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ConfigSchema, type Config } from "../src/config.ts";
import { parseLocalUri } from "../src/spotify/localUri.ts";
import { SpotifyApi } from "../src/spotify/api.ts";
import { SpotifyClient } from "../src/spotify/client.ts";
import type { SpotifyPlaylist, SpotifyPlaylistItem, SpotifyTrack } from "../src/spotify/types.ts";
import { openDatabase } from "../src/state/db.ts";
import { Repo } from "../src/state/repo.ts";
import { PlaylistDriftError } from "../src/sync/apply.ts";
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
  /** items as they were when each snapshot id was handed out; DELETE validates positions against these */
  history: Map<string, string[]>;
}

/** Snapshot id for the playlist's current state, remembering that state (tests mutate `items` directly). */
function snapshotOf(p: FakePlaylist): string {
  const id = `s${p.snapshot}`;
  p.history.set(id, [...p.items]);
  return id;
}

function bump(p: FakePlaylist): string {
  p.snapshot++;
  return snapshotOf(p);
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
  /** applied to the playlist on the snapshot read that closes an items listing (see the race test) */
  editAfterListing: ((p: FakePlaylist) => void) | null = null;
  private listed = false;
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
    return { id: p.id, name: p.name, description: p.description, snapshot_id: snapshotOf(p), owner: { id: "me" } };
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    const body = method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
    if (method !== "GET") this.writes.push(`${method} ${path}${method === "PUT" && Array.isArray(body.uris) ? " replace" : ""}`);

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
      const p: FakePlaylist = { id: `pl${++this.seq}`, name: String(body.name), description: String(body.description ?? ""), snapshot: 0, items: [], history: new Map() };
      this.playlists.set(p.id, p);
      return json(this.playlistObject(p), 201);
    }

    const pl = path.match(/^\/v1\/playlists\/([^/]+)(\/items)?$/);
    if (pl) {
      const p = this.playlists.get(pl[1]!);
      if (!p) return json({ error: { status: 404, message: "not found" } }, 404);
      if (!pl[2]) {
        if (method === "GET") {
          const res = json(this.playlistObject(p));
          if (this.editAfterListing && this.listed) {
            // a "user edit" landing right after the tool bracketed its listing with this snapshot read
            this.editAfterListing(p);
            bump(p);
            this.editAfterListing = null;
          }
          this.listed = false;
          return res;
        }
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
          if (next === null) this.listed = true;
          return json({ items, next, total: p.items.length });
        }
        if (method === "POST") {
          const uris = body.uris as string[];
          if (uris.some((u) => u.startsWith("spotify:local:"))) return json({ error: { status: 400, message: "Invalid track uri" } }, 400);
          const pos = typeof body.position === "number" ? body.position : p.items.length;
          p.items.splice(pos, 0, ...uris);
          return json({ snapshot_id: bump(p) }, 201);
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
          return json({ snapshot_id: bump(p) });
        }
        if (method === "DELETE") {
          // Like the real API: the snapshot given is the one positions are validated against, even
          // when the playlist has changed since; the matching occurrences are removed from the current state.
          const then = p.history.get(String(body.snapshot_id));
          if (!then) return json({ error: { status: 400, message: "stale snapshot" } }, 400);
          const drop = new Set<number>();
          const occurrence = (list: string[], i: number) => list.slice(0, i).filter((u) => u === list[i]).length;
          if (Array.isArray(body.positions)) {
            for (const i of body.positions as number[]) {
              const uri = then[i];
              if (uri === undefined) return json({ error: { status: 400, message: "Invalid position" } }, 400);
              let k = occurrence(then, i);
              p.items.forEach((u, j) => {
                if (u === uri && k-- === 0) drop.add(j);
              });
            }
          } else {
            for (const s of body.items as Array<{ uri: string }>) {
              // the real endpoint parses every uri as a track id; local files can only be removed by position
              if (s.uri.startsWith("spotify:local:")) return json({ error: { status: 400, message: "Invalid base62 id" } }, 400);
              p.items.forEach((u, i) => u === s.uri && drop.add(i));
            }
          }
          p.items = p.items.filter((_, i) => !drop.has(i));
          return json({ snapshot_id: bump(p) });
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

/** The standard three-file library: two songs the fake catalog knows (t1, t2) and one it does not. */
async function makeLibrary(musicDir: string): Promise<void> {
  await Bun.write(join(musicDir, ".keep"), "");
  await makeAudio(join(musicDir, "Artist A - Song One.mp3"), { title: "Song One", artist: "Artist A", album: "Album" }, ["-c:a", "libmp3lame", "-b:a", "64k"]);
  await makeAudio(join(musicDir, "Artist B - Song Two.mp3"), { title: "Song Two", artist: "Artist B", album: "Album" }, ["-c:a", "libmp3lame", "-b:a", "64k"]);
  await makeAudio(join(musicDir, "Artist C - Unknown Song.flac"), { title: "Unknown Song", artist: "Artist C", album: "Album" }, ["-c:a", "flac"]);
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

    await makeLibrary(musicDir);

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

  test("a concurrent edit after the listing does not make position-based prune delete the wrong item", async () => {
    fake.addTrack("t9", "Nine", "Someone", "Other", 1000);
    playlist().items.unshift("spotify:local:Artist+C:Album:Unknown+Song:0"); // stale entry at position 0
    // The tool reads snapshot, items, snapshot; the user's edit lands right after that.
    fake.editAfterListing = (p) => p.items.unshift("spotify:track:t9");
    const { plan } = await sync({ prune: true });
    expect(plan.playlists[0]?.prune).toEqual([{ uri: "spotify:local:Artist+C:Album:Unknown+Song:0", positions: [0] }]);
    expect(plan.playlists[0]?.moves).toEqual([]);
    // position 0 of the planning snapshot was the stale entry, not the user's new first track
    expect(playlist().items).toEqual(["spotify:track:t9", "spotify:track:t1", "spotify:track:t2", "spotify:local:Artist+C:Album:Unknown+Song:2"]);
    playlist().items.shift(); // restore the shared fixture for the next test
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

  test("a local track that later matches on Spotify: its pasted entry is pruned and the export file is removed with --prune", async () => {
    playlist().items = ["spotify:track:t1", "spotify:local:Artist+C:Album:Unknown+Song:2", "spotify:track:t9"];
    fake.addTrack("t3", "Unknown Song", "Artist C", "Album", 2000);
    const local = repo.listMatches("local");
    expect(local).toHaveLength(1);
    // what `spotifify review` does when the user picks a candidate
    for (const m of local) repo.upsertMatch({ ...m, status: "matched", spotifyId: "t3", spotifyUri: "spotify:track:t3", score: 1, decidedBy: "user", decidedAt: Date.now() });

    const reported = await sync();
    expect(reported.plan.playlists[0]?.prune).toEqual([{ uri: "spotify:local:Artist+C:Album:Unknown+Song:2", positions: [1] }]);
    expect(reported.plan.exportGc.map((e) => basename(e.exportPath))).toEqual(["Artist C - Unknown Song.mp3"]);
    expect(existsSync(join(exportDir, "Artist C - Unknown Song.mp3"))).toBe(true); // report only
    expect(playlist().items).toEqual(["spotify:track:t1", "spotify:track:t3", "spotify:local:Artist+C:Album:Unknown+Song:2", "spotify:track:t9"]);

    const pruned = await sync({ prune: true });
    expect(pruned.summary.apply?.pruned).toBe(1);
    expect(pruned.summary.apply?.exportsRemoved).toBe(1);
    expect(playlist().items).toEqual(["spotify:track:t1", "spotify:track:t3", "spotify:track:t9"]);
    expect(readdirSync(exportDir)).toEqual([]);
    expect(repo.listExports()).toEqual([]);
    expect(pruned.summary.awaiting).toEqual([]);
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

describe.skipIf(!haveFfmpeg)("prune stays within what this run reconciles", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-scope-"));
  const musicDir = join(root, "music");
  const exportDir = join(root, "export");
  const fake = new FakeSpotify();
  let cfg: Config;
  let repo: Repo;
  let api: SpotifyApi;

  const sync = (over: Partial<{ prune: boolean; playlist: string }> = {}) =>
    runSync({ cfg, repo, api }, { dryRun: false, prune: over.prune ?? false, playlist: over.playlist, skipMatch: false });
  const library = () => [...fake.playlists.values()].find((p) => p.name === "Local Library")!;
  const localUri = "spotify:local:Artist+C:Album:Unknown+Song:2";
  const exportFile = join(exportDir, "Artist C - Unknown Song.mp3");

  beforeAll(async () => {
    process.env.SPOTIFIFY_SPOTIFY_API = fake.start();
    fake.addTrack("t1", "Song One", "Artist A", "Album", 2000);
    fake.addTrack("t2", "Song Two", "Artist B", "Album", 2000);
    fake.addTrack("t9", "Song Nine", "Someone", "Other", 1000);
    await makeLibrary(musicDir);
    cfg = ConfigSchema.parse({
      spotify: { client_id: "fake" },
      netease: { enabled: false },
      local: { dirs: [musicDir], like_matched: true },
      export: { dir: exportDir },
      matching: { search_min_interval_ms: 0 },
    });
    repo = new Repo(openDatabase(join(root, "state")));
    repo.setAuth("spotify", { access_token: "tok", refresh_token: "ref", expires_at: Date.now() + 3_600_000, scope: "" }, Date.now());
    // A second mirrored playlist standing in for a netease pull (the source is disabled, so the rows persist across runs).
    repo.savePull(
      "netease",
      [{ playlist: { kind: "netease", externalId: "p1", name: "NE" }, tracks: [{ kind: "netease", externalId: "42", title: "Song Nine", artists: ["Someone"], album: "Other", durationMs: 1000, neteaseId: 42, aliases: [] }] }],
      Date.now(),
    );
    api = new SpotifyApi(new SpotifyClient({ clientId: "fake", store: { load: () => repo.getAuth("spotify"), save: () => {} } }));
    await sync();
    library().items.push(localUri); // the user pasted the export
    await sync(); // records the paste as a reference to the export
    expect(library().items).toEqual(["spotify:track:t1", "spotify:track:t2", localUri]);
    expect([...fake.saved].sort()).toEqual(["t1", "t2", "t9"]);
  });

  afterAll(() => {
    fake.stop();
    repo.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a re-search that only turns up a review candidate keeps the pasted entry and the export", async () => {
    fake.addTrack("t3", "Unknown Song (Live)", "Artist C", "Album", 2000); // same core title, version tag differs: review, not auto
    repo.db.run("UPDATE match SET last_search_at = 0 WHERE status = 'local'"); // retry_unmatched_after_days elapsed
    repo.db.run("DELETE FROM search_cache");
    const { plan } = await sync({ prune: true });
    expect(repo.listMatches("review")).toHaveLength(1);
    expect(plan.playlists.find((p) => p.sourceName === "Local Library")?.prune).toEqual([]);
    expect(plan.exportGc).toEqual([]);
    expect(library().items).toEqual(["spotify:track:t1", "spotify:track:t2", localUri]);
    expect(existsSync(exportFile)).toBe(true);
    // what `spotifify review` does when the user keeps the file
    const m = repo.listMatches("review")[0]!;
    repo.upsertMatch({ ...m, status: "local", decidedBy: "user", decidedAt: Date.now() });
  });

  test("--playlist never unlikes what another mirrored playlist wants", async () => {
    fake.writes.length = 0;
    const { summary } = await sync({ playlist: "Local Library", prune: true });
    expect(summary.plan.unlikes).toBe(0);
    expect(fake.saved.has("t9")).toBe(true);
    expect(fake.writes.filter((w) => w.includes("/v1/me/library"))).toEqual([]);
  });

  test("an export still referenced from a playlist retired from mirroring is kept", async () => {
    cfg.local.mirror_playlist = false;
    const { plan } = await sync({ prune: true });
    expect(plan.playlists.map((p) => p.sourceName)).toEqual(["NE"]);
    expect(plan.exportGc).toEqual([]);
    expect(existsSync(exportFile)).toBe(true);
    expect(repo.listExports()).toHaveLength(1);
    expect(library().items).toContain(localUri);
  });

  test("with nothing mirrored, --prune keeps every like and export", async () => {
    repo.savePull("netease", [], Date.now()); // the netease side now lists no playlist (a typo in include_playlists, say)
    const saved = [...fake.saved].sort();
    fake.writes.length = 0;
    const { summary } = await sync({ prune: true });
    expect(summary.plan).toMatchObject({ prune: 0, unlikes: 0, exportGc: 0 });
    expect([...fake.saved].sort()).toEqual(saved);
    expect(fake.writes).toEqual([]);
    expect(existsSync(exportFile)).toBe(true);
  });

  test("101 stale entries are removed across two batches even when the user inserts at the head meanwhile", async () => {
    cfg.local.mirror_playlist = true;
    const stale = "spotify:local:Artist+C:Album:Unknown+Song:0";
    library().items = [...Array.from({ length: 101 }, () => stale), "spotify:track:t1", "spotify:track:t2", localUri];
    fake.editAfterListing = (p) => p.items.unshift("spotify:track:t9");
    const { plan } = await sync({ prune: true });
    expect(plan.playlists.find((p) => p.sourceName === "Local Library")?.prune[0]?.positions).toHaveLength(101);
    expect(library().items).toEqual(["spotify:track:t9", "spotify:track:t1", "spotify:track:t2", localUri]);
  });
});

describe("reorder strategy on large playlists", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-large-"));
  const fake = new FakeSpotify();
  let cfg: Config;
  let repo: Repo;
  let api: SpotifyApi;

  const sync = () => runSync({ cfg, repo, api }, { dryRun: false, prune: false, skipMatch: true });
  const playlist = (name: string) => [...fake.playlists.values()].find((p) => p.name === name)!;
  const uris = (n: number) => Array.from({ length: n }, (_, i) => `spotify:track:n${i + 1}`);

  beforeAll(() => {
    process.env.SPOTIFIFY_SPOTIFY_API = fake.start();
    cfg = ConfigSchema.parse({ spotify: { client_id: "fake" }, netease: { enabled: false, like_matched: false }, local: { enabled: false } });
    repo = new Repo(openDatabase(join(root, "state")));
    repo.setAuth("spotify", { access_token: "tok", refresh_token: "ref", expires_at: Date.now() + 3_600_000, scope: "" }, Date.now());
    const now = Date.now();
    const track = (i: number) => ({ kind: "netease" as const, externalId: String(i), title: `Song ${i}`, artists: ["A"], album: "Album", durationMs: 1000, neteaseId: i, aliases: [] });
    for (let i = 1; i <= 120; i++) {
      fake.addTrack(`n${i}`, `Song ${i}`, "A", "Album", 1000);
      repo.upsertMatch({ canonicalKey: `netease:${i}`, status: "matched", spotifyId: `n${i}`, spotifyUri: `spotify:track:n${i}`, score: 1, decidedBy: "user", candidates: [], decidedAt: now, lastSearchAt: now, searchCount: 1 });
    }
    repo.savePull(
      "netease",
      [
        { playlist: { kind: "netease", externalId: "big", name: "Big" }, tracks: Array.from({ length: 120 }, (_, i) => track(i + 1)) },
        { playlist: { kind: "netease", externalId: "small", name: "Small" }, tracks: Array.from({ length: 60 }, (_, i) => track(i + 1)) },
      ],
      now,
    );
    api = new SpotifyApi(new SpotifyClient({ clientId: "fake", store: { load: () => repo.getAuth("spotify"), save: () => {} } }));
  });

  afterAll(() => {
    fake.stop();
    repo.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a list that fits one request is replaced atomically; a longer one is moved, never replaced piecewise", async () => {
    await sync();
    expect(playlist("Big").items).toEqual(uris(120));
    expect(playlist("Small").items).toEqual(uris(60));
    playlist("Big").items.reverse();
    playlist("Small").items.reverse();
    fake.writes.length = 0;
    const { summary } = await sync();
    expect(summary.apply?.replaced).toBe(1);
    expect(fake.writes.filter((w) => w.endsWith(" replace"))).toEqual([`PUT /v1/playlists/${playlist("Small").id}/items replace`]);
    expect(summary.apply?.moved).toBeGreaterThan(100);
    expect(playlist("Big").items).toEqual(uris(120));
    expect(playlist("Small").items).toEqual(uris(60));
  });

  test("a playlist edited between listing and apply is refused before anything is written to it", async () => {
    fake.addTrack("x1", "Foreign", "B", "Album", 1000);
    playlist("Big").items.reverse();
    fake.editAfterListing = (p) => p.items.unshift("spotify:track:x1");
    fake.writes.length = 0;
    await expect(sync()).rejects.toBeInstanceOf(PlaylistDriftError);
    expect(fake.writes).toEqual([]);
    await sync();
    expect(playlist("Big").items).toEqual([...uris(120), "spotify:track:x1"]);
  });
});
