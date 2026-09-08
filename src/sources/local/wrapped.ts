import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

/**
 * NetEase file names lie about their containers. The client saves some AAC downloads as `.mp3`: an ID3v2 tag
 * (title, artist, 163 key) followed by a complete m4a container — music-metadata reads the tag but measures
 * nonsense for the duration, and ffmpeg / fpcalc refuse the whole file ("moov atom not found"); the bare payload
 * is an ordinary m4a. The cloud drive hands uploads back as `.mp3` whatever they hold (a plain m4a, an ogg…).
 */

export type Container = "mp3" | "m4a" | "flac" | "ogg" | "wav";

/** Container by magic bytes; null when unrecognised or behind an ID3v2 tag (then trust the extension, or see wrappedM4aOffset). */
export async function sniffContainer(path: string): Promise<Container | null> {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(12);
    if ((await fh.read(head, 0, 12, 0)).bytesRead < 12) return null;
    const at = (start: number, end: number) => head.toString("latin1", start, end);
    if (at(0, 4) === "OggS") return "ogg";
    if (at(0, 4) === "fLaC") return "flac";
    if (at(0, 4) === "RIFF" && at(8, 12) === "WAVE") return "wav";
    if (at(4, 8) === "ftyp") return "m4a";
    if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return "mp3"; // bare MPEG audio frame sync
    return null;
  } finally {
    await fh.close();
  }
}

/** Byte offset of the m4a payload behind a leading ID3v2 tag; null for any other file. */
export async function wrappedM4aOffset(path: string): Promise<number | null> {
  const fh = await open(path, "r");
  try {
    const head = new Uint8Array(10);
    if ((await fh.read(head, 0, 10, 0)).bytesRead < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null; // "ID3"
    // syncsafe size excludes the 10-byte header; the footer flag adds another 10 bytes
    const size = ((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f);
    const offset = 10 + size + (head[5]! & 0x10 ? 10 : 0);
    const box = new Uint8Array(8);
    if ((await fh.read(box, 0, 8, offset)).bytesRead < 8) return null;
    return box[4] === 0x66 && box[5] === 0x74 && box[6] === 0x79 && box[7] === 0x70 ? offset : null; // "ftyp"
  } finally {
    await fh.close();
  }
}

/** Copies the m4a payload (everything from `offset`) to `out`. */
export function unwrapM4a(path: string, offset: number, out: string): Promise<void> {
  return pipeline(createReadStream(path, { start: offset }), createWriteStream(out));
}
