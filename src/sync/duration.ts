/**
 * Whole-second duration exactly as the Spotify desktop client computes it for its local-file index —
 * the value it writes into the last `spotify:local:` segment. Verified against the client's index for
 * 81 CBR mp3 files (ffmpeg-written Info frame): floor((xingFrames + 1) * samplesPerFrame / sampleRate),
 * which for CBR equals floor(audioBytes * 8 / bitrate). ffprobe's duration (gapless-trimmed, Info frame
 * excluded) is up to ~0.05 s shorter and floors differently for 4 of those 81 files, so it cannot be used.
 * VBR mp3 ("Xing" rather than "Info") is not verified; `exportTrack` re-encodes such files to CBR.
 * m4a: floor(mvhd duration / timescale) [unverified against the client; no m4a in the sample].
 */

export interface Mp3Probe {
  durationSec: number;
  /** "Xing" frame present: variable bitrate, duration formula unverified */
  vbr: boolean;
}

// index: [MPEG1, MPEG2, MPEG2.5] × sample-rate index
const SAMPLE_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
// kbit/s by layer for MPEG1 and MPEG2/2.5
const BITRATES_V1: Record<number, readonly number[]> = {
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const BITRATES_V2: Record<number, readonly number[]> = {
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

interface FrameHeader {
  sampleRate: number;
  samplesPerFrame: number;
  bitrateKbps: number;
  /** offset of the Xing/Info tag inside the frame (after side info) */
  xingOffset: number;
}

function parseFrameHeader(b: Uint8Array, at: number): FrameHeader | null {
  if (at + 4 > b.length) return null;
  const b1 = b[at + 1]!;
  const b2 = b[at + 2]!;
  const b3 = b[at + 3]!;
  if (b[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3; // 3 MPEG1, 2 MPEG2, 0 MPEG2.5, 1 reserved
  const layer = (b1 >> 1) & 3; // 3 Layer I, 2 Layer II, 1 Layer III, 0 reserved
  const bitrateIdx = b2 >> 4;
  const srIdx = (b2 >> 2) & 3;
  if (version === 1 || layer === 0 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
  const sampleRate = SAMPLE_RATES[version]![srIdx]!;
  const bitrateKbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[layer]![bitrateIdx]!;
  const samplesPerFrame = layer === 3 ? 384 : layer === 2 || version === 3 ? 1152 : 576;
  const mono = (b3 >> 6) === 3;
  const xingOffset = 4 + (version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17);
  return { sampleRate, samplesPerFrame, bitrateKbps, xingOffset };
}

function id3v2End(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
  return 10 + size + (b[5]! & 0x10 ? 10 : 0);
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

export function probeMp3(b: Uint8Array): Mp3Probe | null {
  let at = id3v2End(b);
  let hdr: FrameHeader | null = null;
  for (; at + 4 <= b.length; at++) {
    hdr = parseFrameHeader(b, at);
    if (hdr) break;
  }
  if (!hdr) return null;
  const tag = ascii(b, at + hdr.xingOffset, 4);
  const vbr = tag === "Xing";
  if (vbr || tag === "Info") {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const flags = view.getUint32(at + hdr.xingOffset + 4);
    if (flags & 1) {
      const frames = view.getUint32(at + hdr.xingOffset + 8);
      return { durationSec: Math.floor(((frames + 1) * hdr.samplesPerFrame) / hdr.sampleRate), vbr };
    }
  }
  const tail = b.length >= 128 && ascii(b, b.length - 128, 3) === "TAG" ? 128 : 0;
  const audioBytes = b.length - at - tail;
  return { durationSec: Math.floor((audioBytes * 8) / (hdr.bitrateKbps * 1000)), vbr };
}

/** floor(mvhd.duration / mvhd.timescale); null when no movie header is found. */
export function probeMp4DurationSec(b: Uint8Array): number | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const walk = (start: number, end: number): number | null => {
    let at = start;
    while (at + 8 <= end) {
      let size = view.getUint32(at);
      const type = ascii(b, at + 4, 4);
      let header = 8;
      if (size === 1) {
        size = Number(view.getBigUint64(at + 8));
        header = 16;
      } else if (size === 0) size = end - at;
      if (size < header) return null;
      if (type === "moov") return walk(at + header, at + size);
      if (type === "mvhd") {
        const version = b[at + header]!;
        const timescale = view.getUint32(at + header + (version === 1 ? 20 : 12));
        const duration = version === 1 ? Number(view.getBigUint64(at + header + 24)) : view.getUint32(at + header + 16);
        return timescale > 0 ? Math.floor(duration / timescale) : null;
      }
      at += size;
    }
    return null;
  };
  return walk(0, b.length);
}
