import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptNcm, keyBox, type NcmMeta, readNcmMeta } from "../src/sources/local/ncm.ts";
import { buildNcm } from "./helpers/ncm.ts";

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

const META: NcmMeta = {
  musicId: 186016,
  musicName: "晴天",
  artist: [["周杰伦", 6452]],
  albumId: 18896,
  album: "葉惠美",
  alias: ["Sunny Day"],
  transNames: ["Qing Tian"],
  format: "flac",
  duration: 269000,
  albumPic: "https://p3.music.126.net/x.jpg",
};

// > 1 MiB and not a multiple of 256 so the decrypt loop crosses a chunk boundary mid-keystream.
const AUDIO = Buffer.alloc((1 << 20) + 777);
for (let i = 0; i < AUDIO.length; i++) AUDIO[i] = (i * 31 + (i >> 8)) & 0xff;
const COVER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const RC4_KEY = Buffer.from("E7fT49x7Dof9OKCgg9cdvhEuezy3iZCL1nFvBFd1T4uSktAJKmwZXsijPbijliionVUXXg9plTbXEclAE9Lb");

let dir: string;
let ncmPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "spotifify-ncm-"));
  ncmPath = join(dir, "song.ncm");
  await writeFile(ncmPath, buildNcm({ rc4Key: RC4_KEY, metaText: "music:" + JSON.stringify(META), cover: COVER, audio: AUDIO }));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ncm", () => {
  test("key schedule matches RC4 (Wikipedia vector: Key/Plaintext)", () => {
    const s = Uint8Array.from(keyBox(Buffer.from("Key")));
    const plain = Buffer.from("Plaintext");
    const out = Buffer.alloc(plain.length);
    let i = 0;
    let j = 0;
    for (let k = 0; k < plain.length; k++) {
      i = (i + 1) & 0xff;
      j = (j + s[i]!) & 0xff;
      [s[i], s[j]] = [s[j]!, s[i]!];
      out[k] = plain[k]! ^ s[(s[i]! + s[j]!) & 0xff]!;
    }
    expect(out.toString("hex")).toBe("bbf316e8d940af0ad3");
  });

  test("readNcmMeta parses the header without touching audio", async () => {
    const meta = await readNcmMeta(ncmPath);
    expect(meta).toEqual(META);
  });

  test("decryptNcm restores the audio bytes and returns the cover", async () => {
    const outPath = join(dir, "nested", "out", "song.flac");
    const { meta, cover } = await decryptNcm(ncmPath, outPath);
    expect(meta.musicId).toBe(META.musicId);
    expect(Buffer.from(cover!).equals(COVER)).toBe(true);
    expect((await readFile(outPath)).equals(AUDIO)).toBe(true);
  });

  test("dj payloads unwrap mainMusic and coerce string ids", async () => {
    const path = join(dir, "dj.ncm");
    const dj = { mainMusic: { ...META, musicId: "186016", artist: [["周杰伦", "6452"]] }, programId: 1 };
    await writeFile(path, buildNcm({ rc4Key: RC4_KEY, metaText: "dj:" + JSON.stringify(dj), cover: Buffer.alloc(0), audio: Buffer.from("x") }));
    expect(await readNcmMeta(path)).toEqual(META);
  });

  test("rejects bad magic and missing metadata", async () => {
    const bad = join(dir, "bad.ncm");
    await writeFile(bad, Buffer.from("not an ncm file at all"));
    await expect(readNcmMeta(bad)).rejects.toThrow(/bad magic/);

    const noMeta = join(dir, "nometa.ncm");
    const withMeta = buildNcm({ rc4Key: RC4_KEY, metaText: "music:{}", cover: Buffer.alloc(0), audio: Buffer.alloc(0) });
    const keyLen = withMeta.readUInt32LE(10);
    await writeFile(noMeta, Buffer.concat([withMeta.subarray(0, 14 + keyLen), u32(0), Buffer.alloc(13)]));
    await expect(readNcmMeta(noMeta)).rejects.toThrow(/no embedded metadata/);
  });
});
