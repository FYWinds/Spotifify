import { describe, expect, test } from "bun:test";
import { probeMp3, probeMp4DurationSec } from "../src/sync/duration.ts";

/** ID3v2.3 header (payload `tagBytes`) + one MPEG1 Layer III 44.1 kHz stereo frame carrying an Info/Xing tag + `audioBytes` of filler. */
function mp3(opts: { tag: "Info" | "Xing" | null; frames: number; audioBytes: number; tagBytes?: number; id3v1?: boolean; bitrateIdx?: number }): Uint8Array {
  const tagBytes = opts.tagBytes ?? 0;
  const bitrateIdx = opts.bitrateIdx ?? 14; // 320 kbit/s
  const id3 = new Uint8Array(10 + tagBytes);
  id3.set([0x49, 0x44, 0x33, 3, 0, 0, (tagBytes >> 21) & 0x7f, (tagBytes >> 14) & 0x7f, (tagBytes >> 7) & 0x7f, tagBytes & 0x7f]);
  const audio = new Uint8Array(opts.audioBytes);
  audio.set([0xff, 0xfb, (bitrateIdx << 4) | 0x00, 0x00]); // sync, MPEG1 L3 no-CRC, 44.1 kHz, stereo
  if (opts.tag) {
    const at = 4 + 32;
    audio.set([...opts.tag].map((c) => c.charCodeAt(0)), at);
    new DataView(audio.buffer).setUint32(at + 4, 1); // flags: frames present
    new DataView(audio.buffer).setUint32(at + 8, opts.frames);
  }
  const tail = opts.id3v1 ? new Uint8Array([0x54, 0x41, 0x47, ...new Array<number>(125).fill(0)]) : new Uint8Array(0);
  const out = new Uint8Array(id3.length + audio.length + tail.length);
  out.set(id3);
  out.set(audio, id3.length);
  out.set(tail, id3.length + audio.length);
  return out;
}

describe("client-compatible duration", () => {
  test("Info frame: floor((frames + 1) × 1152 / 44100) — values observed in the desktop client's index", () => {
    // 156.79 s per ffprobe, 6004 frames: the client indexes 156 (rounding would give 157)
    expect(probeMp3(mp3({ tag: "Info", frames: 6004, audioBytes: 6_274_611 }))).toEqual({ durationSec: 156, vbr: false });
    // 207.94 s per ffprobe, 7962 frames: the client indexes 208 (floor of the frame count alone would give 207)
    expect(probeMp3(mp3({ tag: "Info", frames: 7962, audioBytes: 8_319_654 }))).toEqual({ durationSec: 208, vbr: false });
  });

  test("Xing frame is reported as VBR", () => {
    expect(probeMp3(mp3({ tag: "Xing", frames: 6004, audioBytes: 100 }))?.vbr).toBe(true);
  });

  test("no Xing/Info frame: CBR estimate from audio bytes and bitrate, ID3v1 tail and ID3v2 header excluded", () => {
    // 6_274_611 bytes at 320 kbit/s = 156.87 s
    expect(probeMp3(mp3({ tag: null, frames: 0, audioBytes: 6_274_611, tagBytes: 93_718, id3v1: true }))).toEqual({ durationSec: 156, vbr: false });
    // 128 kbit/s: 1_600_000 bytes = 100 s exactly
    expect(probeMp3(mp3({ tag: null, frames: 0, audioBytes: 1_600_000, bitrateIdx: 9 }))).toEqual({ durationSec: 100, vbr: false });
  });

  test("garbage is not a duration", () => {
    expect(probeMp3(new Uint8Array(64))).toBeNull();
    expect(probeMp4DurationSec(new Uint8Array(64))).toBeNull();
  });

  test("mp4: floor(mvhd duration / timescale), version 0 and version 1 headers, nested in moov", () => {
    const atom = (type: string, payload: Uint8Array): Uint8Array => {
      const out = new Uint8Array(8 + payload.length);
      new DataView(out.buffer).setUint32(0, out.length);
      out.set([...type].map((c) => c.charCodeAt(0)), 4);
      out.set(payload, 8);
      return out;
    };
    const cat = (...parts: Uint8Array[]) => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    };
    const mvhd0 = new Uint8Array(100);
    new DataView(mvhd0.buffer).setUint32(12, 1000);
    new DataView(mvhd0.buffer).setUint32(16, 182_999);
    expect(probeMp4DurationSec(cat(atom("ftyp", new Uint8Array(4)), atom("moov", cat(atom("udta", new Uint8Array(2)), atom("mvhd", mvhd0)))))).toBe(182);
    const mvhd1 = new Uint8Array(112);
    mvhd1[0] = 1;
    new DataView(mvhd1.buffer).setUint32(20, 44100);
    new DataView(mvhd1.buffer).setBigUint64(24, 44100n * 301n + 44099n);
    expect(probeMp4DurationSec(cat(atom("moov", atom("mvhd", mvhd1)), atom("mdat", new Uint8Array(8))))).toBe(301);
  });
});
