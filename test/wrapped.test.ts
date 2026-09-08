/**
 * NetEase file names that lie about their container. The client's "ID3v2 tag + m4a payload saved as .mp3"
 * downloads: the tag must still yield the 163 key, the duration must come from the payload, and
 * export/fingerprint must see a plain m4a. The cloud drive's "plain m4a saved as .mp3": read and exported
 * by content. Skipped when ffmpeg is not on PATH.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.ts";
import { readTags } from "../src/sources/local/tags.ts";
import { sniffContainer, wrappedM4aOffset } from "../src/sources/local/wrapped.ts";
import type { SourceTrackRow } from "../src/state/repo.ts";
import { exportTrack } from "../src/sync/export.ts";
import { probeBinary } from "../src/util/bin.ts";
import { aesEcbEncrypt, META_KEY } from "./helpers/ncm.ts";

const haveFfmpeg = (await probeBinary("ffmpeg", ["-version"])) !== null;

const META_JSON = JSON.stringify({ musicId: 1866873377, musicName: "セカイ", artist: [["DECO*27", 1]], album: "セカイ", format: "m4a", duration: 3000 });
const KEY_163 = "163 key(Don't modify):" + aesEcbEncrypt(META_KEY, Buffer.from("music:" + META_JSON, "utf8")).toString("base64");

async function ffmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

describe.skipIf(!haveFfmpeg)("m4a behind an ID3v2 tag", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-wrapped-"));
  const wrapped = join(root, "DECO_27 - セカイ.mp3");
  let tagLength = 0;

  beforeAll(async () => {
    const sine = ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-map_metadata", "-1"];
    // ID3v2.4: ffmpeg's v2.3 writer splits a value on "/" into several frames, which base64 keys contain
    await ffmpeg([...sine, "-metadata", "title=セカイ", "-metadata", "artist=DECO*27", "-metadata", `comment=${KEY_163}`, "-c:a", "libmp3lame", "-b:a", "32k", "-id3v2_version", "4", join(root, "tagged.mp3")]);
    await ffmpeg([...sine, "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", join(root, "payload.m4a")]);
    const tagged = readFileSync(join(root, "tagged.mp3"));
    tagLength = 10 + ((tagged[6]! << 21) | (tagged[7]! << 14) | (tagged[8]! << 7) | tagged[9]!);
    writeFileSync(wrapped, Buffer.concat([tagged.subarray(0, tagLength), readFileSync(join(root, "payload.m4a"))]));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("is detected by its payload offset; plain mp3 and m4a are not", async () => {
    expect(await wrappedM4aOffset(wrapped)).toBe(tagLength);
    expect(await wrappedM4aOffset(join(root, "tagged.mp3"))).toBeNull();
    expect(await wrappedM4aOffset(join(root, "payload.m4a"))).toBeNull();
  });

  test("tags come from the ID3 header, the duration from the payload", async () => {
    const tags = await readTags(wrapped);
    expect(tags.netease?.musicId).toBe(1866873377);
    expect(tags.title).toBe("セカイ");
    expect(tags.durationMs).toBeGreaterThan(2900);
    expect(tags.durationMs).toBeLessThan(3200);
  });

  test("exports as a copied m4a with the payload's whole-second duration in the uri", async () => {
    const cfg = ConfigSchema.parse({ export: { dir: join(root, "export") } }).export;
    const track: SourceTrackRow = {
      id: 1,
      kind: "local",
      externalId: wrapped,
      canonicalKey: "netease:1866873377",
      title: "セカイ",
      artists: ["DECO*27"],
      album: "セカイ",
      aliases: [],
      file: { path: wrapped, contentHash: "abc", size: 1, mtimeMs: 1 },
      lastSeenAt: 1,
    };
    const r = await exportTrack({ canonicalKey: track.canonicalKey, sourcePath: wrapped, baseName: "DECO_27 - セカイ" }, track, cfg);
    expect(r.exportPath.endsWith(".m4a")).toBe(true);
    expect(existsSync(r.exportPath)).toBe(true);
    expect(r.localUri).toBe("spotify:local:DECO*27:%E3%82%BB%E3%82%AB%E3%82%A4:%E3%82%BB%E3%82%AB%E3%82%A4:3");
  });

  test("a plain m4a saved as .mp3 (cloud drive download) is read and exported by its content", async () => {
    const cloud = join(root, "Moonglow.mp3");
    writeFileSync(cloud, readFileSync(join(root, "payload.m4a")));
    expect(await sniffContainer(cloud)).toBe("m4a");
    expect(await sniffContainer(join(root, "tagged.mp3"))).toBeNull();
    const tags = await readTags(cloud);
    expect(tags.durationMs).toBeGreaterThan(2900);
    expect(tags.durationMs).toBeLessThan(3200);
    const cfg = ConfigSchema.parse({ export: { dir: join(root, "export") } }).export;
    const track: SourceTrackRow = { id: 2, kind: "local", externalId: cloud, canonicalKey: "local:x", title: "Moonglow", artists: ["X"], aliases: [], file: { path: cloud, contentHash: "x", size: 1, mtimeMs: 1 }, lastSeenAt: 1 };
    const r = await exportTrack({ canonicalKey: track.canonicalKey, sourcePath: cloud, baseName: "X - Moonglow" }, track, cfg);
    expect(r.exportPath.endsWith(".m4a")).toBe(true);
    expect(r.durationSec).toBe(3);
  });
});
