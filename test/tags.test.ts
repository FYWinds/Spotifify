import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode163Key } from "../src/sources/local/ncm.ts";
import { parseFilename, readTags } from "../src/sources/local/tags.ts";
import { probeBinary } from "../src/util/bin.ts";
import { aesEcbEncrypt, META_KEY } from "./helpers/ncm.ts";

const META_JSON = JSON.stringify({ musicId: 1866873377, musicName: "セカイ", artist: [["DECO*27", 1], ["初音ミク", 2]], album: "セカイ", format: "flac", duration: 213000, transNames: ["世界"] });
const KEY_163 = "163 key(Don't modify):" + aesEcbEncrypt(META_KEY, Buffer.from("music:" + META_JSON, "utf8")).toString("base64");

describe("decode163Key", () => {
  test("decodes the NetEase comment blob into song metadata", () => {
    const m = decode163Key(KEY_163, "x");
    expect(m?.musicId).toBe(1866873377);
    expect(m?.artist.map(([n]) => n)).toEqual(["DECO*27", "初音ミク"]);
    expect(m?.transNames).toEqual(["世界"]);
  });

  test("ignores ordinary comments and corrupt blobs", () => {
    expect(decode163Key("just a comment", "x")).toBeNull();
    expect(decode163Key("163 key(Don't modify):not-base64-of-anything", "x")).toBeNull();
  });
});

const haveFfmpeg = (await probeBinary("ffmpeg", ["-version"])) !== null;

describe.skipIf(!haveFfmpeg)("readTags picks up the NetEase key from real containers", () => {
  const dir = mkdtempSync(join(tmpdir(), "spotifify-tags-"));
  const make = async (name: string, codec: string[]) => {
    const path = join(dir, name);
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-metadata", "title=セカイ", "-metadata", "artist=DECO*27/初音ミク", "-metadata", `comment=${KEY_163}`, ...codec, path];
    const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
    return path;
  };

  test("mp3 (ID3 COMM) and flac (Vorbis comment)", async () => {
    try {
      const mp3 = await readTags(await make("a.mp3", ["-c:a", "libmp3lame", "-b:a", "32k", "-id3v2_version", "4"]));
      expect(mp3.netease?.musicId).toBe(1866873377);
      const flac = await readTags(await make("a.flac", ["-c:a", "flac"]));
      expect(flac.netease?.musicId).toBe(1866873377);
      expect(flac.artists).toEqual(["DECO*27/初音ミク"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseFilename", () => {
  test("artist-title splits on the first ' - '", () => {
    expect(parseFilename("周杰伦 - 晴天", "artist-title")).toEqual({ title: "晴天", artists: ["周杰伦"] });
    expect(parseFilename("Daft Punk - Harder - Better", "artist-title")).toEqual({ title: "Harder - Better", artists: ["Daft Punk"] });
  });

  test("title-artist flips the halves", () => {
    expect(parseFilename("晴天 - 周杰伦", "title-artist")).toEqual({ title: "晴天", artists: ["周杰伦"] });
  });

  test("strips leading track numbers", () => {
    expect(parseFilename("01. 周杰伦 - 晴天", "artist-title")).toEqual({ title: "晴天", artists: ["周杰伦"] });
    expect(parseFilename("01 - 周杰伦 - 晴天", "artist-title")).toEqual({ title: "晴天", artists: ["周杰伦"] });
    expect(parseFilename("7.Artist - Title", "artist-title")).toEqual({ title: "Title", artists: ["Artist"] });
    // a leading number that is part of the name stays
    expect(parseFilename("2 Become 1 - Spice Girls", "title-artist")).toEqual({ title: "2 Become 1", artists: ["Spice Girls"] });
  });

  test("splits multiple artists on / 、 ; & ,", () => {
    expect(parseFilename("周杰伦/費玉清、方文山; A & B, C - 千里之外", "artist-title")).toEqual({
      title: "千里之外",
      artists: ["周杰伦", "費玉清", "方文山", "A", "B", "C"],
    });
  });

  test("hyphenated names without surrounding spaces are not separators", () => {
    expect(parseFilename("Jean-Michel Jarre - Oxygène", "artist-title")).toEqual({ title: "Oxygène", artists: ["Jean-Michel Jarre"] });
    expect(parseFilename("Winter-Wonderland", "artist-title")).toEqual({ title: "Winter-Wonderland", artists: [] });
  });

  test("no separator yields the whole name as title and no artists", () => {
    expect(parseFilename("晴天", "artist-title")).toEqual({ title: "晴天", artists: [] });
    expect(parseFilename("03. 晴天", "title-artist")).toEqual({ title: "晴天", artists: [] });
  });
});
