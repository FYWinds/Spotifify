import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.ts";
import { LocalSource } from "../src/sources/local/source.ts";
import type { NeteaseClient, NeteasePlaylistSummary, NeteaseSong } from "../src/sources/netease/client.ts";
import { NeteaseSource } from "../src/sources/netease/source.ts";
import type { SourceTrack } from "../src/sources/types.ts";
import { openDatabase } from "../src/state/db.ts";
import { Repo } from "../src/state/repo.ts";
import { probeBinary } from "../src/util/bin.ts";
import { aesEcbEncrypt, buildNcm, META_KEY } from "./helpers/ncm.ts";

describe("local source: a file that cannot be read is not a file that left the library", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-source-"));
  const repo = new Repo(openDatabase(join(root, "state")));
  const cfg = ConfigSchema.parse({ local: { dirs: [root] } }).local;
  const path = join(root, "song.ncm");

  afterAll(() => {
    repo.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the previous row stands until the file is readable again", async () => {
    const meta = { musicId: 4242, musicName: "Song", artist: [["Artist", 1]], album: "Album", format: "mp3", duration: 1000 };
    writeFileSync(path, buildNcm({ rc4Key: Buffer.from("k"), metaText: "music:" + JSON.stringify(meta), cover: Buffer.alloc(0), audio: Buffer.alloc(64, 1) }));
    const first = await new LocalSource(cfg, new Map()).pull();
    expect(first.playlists[0]?.tracks.map((t) => t.title)).toEqual(["Song"]);
    repo.savePull("local", first.playlists, 1);

    writeFileSync(path, Buffer.from("not an ncm container at all, e.g. a download that was truncated")); // size and mtime differ → re-read
    const second = await new LocalSource(cfg, repo.localTracksByPath()).pull();
    expect(second.playlists[0]?.tracks.map((t) => [t.title, t.neteaseId])).toEqual([["Song", 4242]]);

    const unknown = await new LocalSource(cfg, new Map()).pull(); // never seen before: nothing to keep, nothing lost
    expect(unknown.playlists[0]?.tracks).toEqual([]);
  });
});

const haveFfmpeg = (await probeBinary("ffmpeg", ["-version"])) !== null;

describe.skipIf(!haveFfmpeg)("local source: a NetEase download far shorter than its 163 key says is a stub, not a track", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-stub-"));
  const cfg = ConfigSchema.parse({ local: { dirs: [root] } }).local;
  const key = (duration: number) =>
    "163 key(Don't modify):" + aesEcbEncrypt(META_KEY, Buffer.from("music:" + JSON.stringify({ musicId: 7, musicName: "Song", artist: [["A", 1]], album: "Al", format: "mp3", duration }), "utf8")).toString("base64");
  const make = async (name: string, duration: number) => {
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-metadata", `comment=${key(duration)}`, "-c:a", "libmp3lame", "-b:a", "32k", "-id3v2_version", "4", join(root, name)];
    const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  };

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("2 s of a 4-minute song is skipped; 2 s of a 2 s song is kept", async () => {
    await make("stub.mp3", 251_000);
    await make("whole.mp3", 2_000);
    const { playlists } = await new LocalSource(cfg, new Map()).pull();
    expect(playlists[0]?.tracks.map((t) => t.externalId)).toEqual([join(root, "whole.mp3")]);
  });
});

describe("netease source: a partially answered song_detail does not freeze the playlist", () => {
  const summary: NeteasePlaylistSummary = { id: 7, name: "P", creatorId: 1, specialType: 0, trackCount: 2, updateTime: 5, trackUpdateTime: 5 };
  const song = (id: number): NeteaseSong => ({ id, name: `S${id}`, artists: ["A"], album: "Al", durationMs: 1000, aliases: [] });
  const known = new Map<string, SourceTrack>();
  let detailCalls = 0;
  let omitSecond = true;
  const client = {
    loginStatus: async () => ({ uid: 1, nickname: "n" }),
    userPlaylists: async () => [summary],
    playlistTrackIds: async () => ({ ids: [1, 2], updateTime: 5, trackUpdateTime: 5 }),
    songDetails: async (ids: number[]) => {
      detailCalls++;
      return ids.filter((id) => !(omitSecond && id === 2)).map(song);
    },
  } as unknown as NeteaseClient;
  let stored: number | undefined;
  const source = new NeteaseSource(client, ConfigSchema.parse({}).netease, {
    playlistUpdatedAt: () => stored,
    playlistTracks: () => [...known.values()],
    knownSongs: (ids) => new Map(ids.filter((id) => known.has(id)).map((id) => [id, known.get(id)!])),
  });

  test("the short list is returned but the playlist is left unpulled, so the next run fetches the rest", async () => {
    const first = await source.pull();
    expect(first.playlists[0]?.tracks.map((t) => t.externalId)).toEqual(["1"]);
    expect(first.playlists[0]?.playlist.sourceUpdatedAt).toBeUndefined();
    for (const t of first.playlists[0]!.tracks) known.set(t.externalId, t);
    stored = first.playlists[0]?.playlist.sourceUpdatedAt;

    omitSecond = false;
    const second = await source.pull();
    expect(detailCalls).toBe(2);
    expect(second.playlists[0]?.tracks.map((t) => t.externalId)).toEqual(["1", "2"]);
    expect(second.playlists[0]?.playlist.sourceUpdatedAt).toBe(5);
  });
});
