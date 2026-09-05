import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromaprint } from "../src/match/fingerprint.ts";
import { probeBinary } from "../src/util/bin.ts";
import { buildNcm } from "./helpers/ncm.ts";

const haveTools = (await probeBinary("ffmpeg", ["-version"])) !== null && (await probeBinary("fpcalc", ["-version"])) !== null;

describe.skipIf(!haveTools)("chromaprint", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-fp-"));

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("an .ncm is fingerprinted from its decrypted audio", async () => {
    const mp3 = join(root, "tone.mp3");
    const proc = Bun.spawn(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:a", "libmp3lame", "-b:a", "64k", mp3], { stdout: "ignore", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    const meta = { musicId: 1, musicName: "Tone", artist: [["A", 1]], album: "Al", format: "mp3", duration: 5000 };
    const ncm = join(root, "tone.ncm");
    writeFileSync(ncm, buildNcm({ rc4Key: Buffer.from("k"), metaText: "music:" + JSON.stringify(meta), cover: Buffer.alloc(0), audio: readFileSync(mp3) }));

    const plain = await chromaprint("fpcalc", mp3, "h1");
    const wrapped = await chromaprint("fpcalc", ncm, "h2");
    expect(wrapped?.fingerprint).toBe(plain!.fingerprint);
    expect(wrapped?.duration).toBe(plain!.duration);
  });
});
