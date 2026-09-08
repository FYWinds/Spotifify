import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.ts";
import { LocalSource } from "../src/sources/local/source.ts";
import { AttachError, attachFile } from "../src/sync/attach.ts";
import { probeBinary } from "../src/util/bin.ts";
import { aesEcbEncrypt, META_KEY } from "./helpers/ncm.ts";

const haveFfmpeg = (await probeBinary("ffmpeg", ["-version"])) !== null;

describe.skipIf(!haveFfmpeg)("attach: a hand-picked file becomes the NetEase download of a track", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-attach-"));
  const lib = join(root, "lib");
  mkdirSync(lib);
  const cfg = ConfigSchema.parse({ local: { dirs: [lib] } });
  const track = { neteaseId: 7, title: "Song", artists: ["A", "B"], album: "Al", durationMs: 2000, aliases: ["S"] };

  const make = async (path: string, codec: string[], comment?: string) => {
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2"];
    if (comment !== undefined) args.push("-metadata", `comment=${comment}`);
    const proc = Bun.spawn(["ffmpeg", ...args, ...codec, path], { stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
    return path;
  };
  const key = (musicId: number, duration: number) =>
    "163 key(Don't modify):" + aesEcbEncrypt(META_KEY, Buffer.from("music:" + JSON.stringify({ musicId, musicName: "Song", artist: [["A", 1]], album: "Al", format: "mp3", duration }), "utf8")).toString("base64");
  const pull = async () => (await new LocalSource(cfg.local, new Map()).pull()).playlists[0]!.tracks;

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("an untagged mp3 scans as the track, whole, under netease:{id}", async () => {
    const r = await attachFile(track, `"${await make(join(root, "found.mp3"), ["-c:a", "libmp3lame", "-b:a", "32k"])}"`, cfg);
    expect(r).toEqual({ path: join(lib, "A, B - Song.mp3"), replaced: [] });
    const [t] = await pull();
    expect(t).toMatchObject({ neteaseId: 7, title: "Song", artists: ["A", "B"], album: "Al", aliases: ["S"], file: { path: r.path } });
    expect(t!.durationMs).toBeGreaterThan(1900);
    rmSync(r.path);
  });

  test("a stub of the same song under that name gives way, even in another container", async () => {
    await make(join(lib, "A, B - Song.mp3"), ["-c:a", "libmp3lame", "-b:a", "32k"], key(7, 251_000));
    const r = await attachFile(track, await make(join(root, "found.flac"), ["-c:a", "flac"]), cfg);
    expect(r).toEqual({ path: join(lib, "A, B - Song.flac"), replaced: [join(lib, "A, B - Song.mp3")] });
    expect(readdirSync(lib)).toEqual(["A, B - Song.flac"]);
    expect((await pull()).map((t) => t.neteaseId)).toEqual([7]);
    rmSync(r.path);
  });

  test("another song's file under that name stays; the copy takes the next free name", async () => {
    const other = await make(join(lib, "A, B - Song.mp3"), ["-c:a", "libmp3lame", "-b:a", "32k"], key(8, 2_000));
    const r = await attachFile(track, await make(join(root, "found2.mp3"), ["-c:a", "libmp3lame", "-b:a", "32k"]), cfg);
    expect(r).toEqual({ path: join(lib, "A, B - Song (2).mp3"), replaced: [] });
    expect((await pull()).map((t) => t.neteaseId).sort()).toEqual([7, 8]);
    rmSync(other);
    rmSync(r.path);
  });

  test("a file far shorter than the song is refused and leaves nothing behind", async () => {
    const short = await make(join(root, "short.mp3"), ["-c:a", "libmp3lame", "-b:a", "32k"]);
    await expect(attachFile({ ...track, durationMs: 251_000 }, short, cfg)).rejects.toThrow(AttachError);
    expect(readdirSync(lib)).toEqual([]);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith(`spotifify-attach-${process.pid}-`))).toEqual([]);
    expect(existsSync(short)).toBe(true);
  });

  test("tracks without a NetEase id and libraries without a directory are refused up front", async () => {
    await expect(attachFile({ ...track, neteaseId: undefined }, join(root, "found.mp3"), cfg)).rejects.toThrow(/NetEase id/);
    await expect(attachFile(track, join(root, "found.mp3"), { ...cfg, local: { ...cfg.local, dirs: [] } })).rejects.toThrow(/local\.dirs/);
    await expect(attachFile(track, join(root, "missing.mp3"), cfg)).rejects.toThrow(/not a file/);
  });
});
