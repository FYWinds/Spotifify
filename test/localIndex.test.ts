import { describe, expect, test } from "bun:test";
import { compareExports, parseLocalFilesIndex } from "../src/spotify/localIndex.ts";

const enc = new TextEncoder();
const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    out.push(n > 0 ? b | 0x80 : b);
  } while (n > 0);
  return out;
};
const str = (s: string): number[] => {
  const b = enc.encode(s);
  return [0x09, ...varint(b.length), ...b];
};
/** One record in the layout observed in local-files.bnk (unknown fields carry the bytes seen in the wild). */
const record = (title: string, artist: string, album: string, seconds: number, path: string): number[] => {
  const p = enc.encode(path);
  return [
    0x08, 0x01, 0x78, 0x78, 0x04,
    ...str(title), ...str(artist), ...str(album),
    0x10, ...varint(seconds),
    0xb0, 0x01, 0x00, 0x08, 0x00, 0x08, 0x00, 0x08, ...varint(1_757_000_000),
    0x2c, 0x01, ...varint(p.length), ...p,
    0x08, 0x00, 0x08, 0x00, 0x08, ...varint(6_368_467),
  ];
};
const header = [...enc.encode("SPCO"), 0x13, 0, 0, 0, 0, 0x11, ...enc.encode("LocalFilesStorage"), 0x0a, 0x00];

describe("desktop client local-files index", () => {
  test("parses title/artist/album/duration/path records, including a 2-byte varint duration", () => {
    const buf = new Uint8Array([
      ...header,
      ...record("夏至又至", "WOVOP, 洛天依", "夏至又至", 156, "D:\\Files\\SpotitifyLocal\\WOVOP, 洛天依 - 夏至又至.mp3"),
      ...record("ナイト･オブ･ナイツ 10周年 ver.", "まらしぃ", "album", 1117, "D:\\Files\\SpotitifyLocal\\まらしぃ - ナイト.mp3"),
      0x08, 0x01, 0x78, 0x78, 0x00, 0x00,
    ]);
    expect(parseLocalFilesIndex(buf)).toEqual([
      { title: "夏至又至", artist: "WOVOP, 洛天依", album: "夏至又至", durationSec: 156, path: "D:\\Files\\SpotitifyLocal\\WOVOP, 洛天依 - 夏至又至.mp3" },
      { title: "ナイト･オブ･ナイツ 10周年 ver.", artist: "まらしぃ", album: "album", durationSec: 1117, path: "D:\\Files\\SpotitifyLocal\\まらしぃ - ナイト.mp3" },
    ]);
  });

  test("an empty or foreign file yields no records instead of garbage", () => {
    expect(parseLocalFilesIndex(new Uint8Array(header))).toEqual([]);
    expect(parseLocalFilesIndex(new Uint8Array([0x08, 0x01, 0x78, 0x78, 0x04, 0x09, 0xff]))).toEqual([]);
  });

  test("compares exports by identity: matched, wrong duration, not indexed", () => {
    const entries = parseLocalFilesIndex(
      new Uint8Array([...header, ...record("A", "X", "Al", 100, "p1"), ...record("B", "Y", "Al", 200, "p2")]),
    );
    const row = (key: string, path: string, uri: string) => ({ canonicalKey: key, exportPath: path, localUri: uri, contentHash: "h", exportedAt: 0 });
    const result = compareExports(entries, [
      row("k1", "D:/x/X - A.mp3", "spotify:local:X:Al:A:100"),
      row("k2", "D:/x/Y - B.mp3", "spotify:local:Y:Al:B:201"),
      row("k3", "D:/x/Z - C.mp3", "spotify:local:Z:Al:C:5"),
    ]);
    expect(result).toEqual({ matched: 1, mismatched: [{ file: "Y - B.mp3", ours: 201, client: 200 }], missing: ["Z - C.mp3"] });
  });
});
