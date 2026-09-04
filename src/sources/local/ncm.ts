import { createDecipheriv } from "node:crypto";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Netease `.ncm` container (layout as implemented by ncmdump):
 *
 *   "CTENFDAM" | 2 reserved | u32le keyLen | key (XOR 0x64, AES-128-ECB[CORE_KEY], "neteasecloudmusic" + rc4Key)
 *   u32le metaLen | meta (XOR 0x63, "163 key(Don't modify):" + base64(AES-128-ECB[META_KEY]("music:" + json)))
 *   u32le crc32 | 5 reserved | u32le imageSize | image | audio (XOR stream derived from RC4 S-box of rc4Key)
 */

const MAGIC = "CTENFDAM";
const CORE_KEY = Buffer.from("687A4852416D736F356B496E62617857", "hex");
const META_KEY = Buffer.from("2331346C6A6B5F215C5D2630553C2728", "hex");
const KEY_PREFIX = "neteasecloudmusic".length;
const META_PREFIX = "163 key(Don't modify):".length;
/** Upper bound for any length-prefixed header field; real files stay far below this. */
const MAX_FIELD = 16 << 20;
const CHUNK = 1 << 20;

export interface NcmMeta {
  musicId: number;
  musicName: string;
  artist: Array<[string, number]>;
  album: string;
  albumId?: number;
  alias?: string[];
  transNames?: string[];
  format: string;
  /** milliseconds */
  duration: number;
  albumPic?: string;
}

const MetaSchema = z.object({
  musicId: z.coerce.number(),
  musicName: z.string(),
  artist: z.array(z.tuple([z.string(), z.coerce.number()])).default([]),
  album: z.string().default(""),
  albumId: z.coerce.number().optional(),
  alias: z.array(z.string()).optional(),
  transNames: z.array(z.string()).optional(),
  format: z.string(),
  duration: z.number(),
  albumPic: z.string().optional(),
});
/** "dj:" payloads (radio programs) nest the song under mainMusic. */
const DjMetaSchema = z.object({ mainMusic: MetaSchema }).transform((o) => o.mainMusic);

/** Standard RC4 key scheduling; the resulting S-box drives the audio XOR stream. Exported for tests. */
export function keyBox(key: Uint8Array): Uint8Array {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    const s = box[i]!;
    j = (j + s + key[i % key.length]!) & 0xff;
    box[i] = box[j]!;
    box[j] = s;
  }
  return box;
}

/** 256-byte XOR stream: audio byte at offset k is XORed with `stream[k & 0xff]`. */
function xorStream(box: Uint8Array): Uint8Array {
  const stream = new Uint8Array(256);
  for (let k = 0; k < 256; k++) {
    const j = (k + 1) & 0xff;
    const bj = box[j]!;
    stream[k] = box[(bj + box[(bj + j) & 0xff]!) & 0xff]!;
  }
  return stream;
}

function aesEcbDecrypt(key: Buffer, data: Uint8Array): Buffer {
  const d = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([d.update(data), d.final()]);
}

class Cursor {
  pos = 0;

  constructor(
    private readonly fh: FileHandle,
    private readonly path: string,
  ) {}

  async bytes(n: number): Promise<Buffer> {
    if (n > MAX_FIELD) throw new Error(`${this.path}: implausible NCM field length ${n}`);
    const buf = Buffer.allocUnsafe(n);
    for (let done = 0; done < n; ) {
      const { bytesRead } = await this.fh.read(buf, done, n - done, this.pos + done);
      if (bytesRead === 0) throw new Error(`${this.path}: truncated NCM header (EOF at byte ${this.pos + done})`);
      done += bytesRead;
    }
    this.pos += n;
    return buf;
  }
}

function parseMeta(text: string, path: string): NcmMeta {
  const colon = text.indexOf(":");
  if (colon < 0) throw new Error(`${path}: malformed NCM metadata (no type prefix)`);
  const parsed = (text.startsWith("dj:") ? DjMetaSchema : MetaSchema).safeParse(JSON.parse(text.slice(colon + 1)));
  if (!parsed.success) throw new Error(`${path}: unexpected NCM metadata shape: ${parsed.error.message}`);
  return parsed.data;
}

const KEY_163 = "163 key(Don't modify):";

/**
 * Plain mp3/flac downloaded by the NetEase client carry the same encrypted metadata as an NCM header in a
 * comment tag (`163 key(Don't modify):<base64>`). Returns null when the text is not such a key or does not decode.
 */
export function decode163Key(comment: string, path: string): NcmMeta | null {
  const text = comment.trim();
  if (!text.startsWith(KEY_163)) return null;
  try {
    return parseMeta(aesEcbDecrypt(META_KEY, Buffer.from(text.slice(KEY_163.length), "base64")).toString("utf8"), path);
  } catch {
    return null;
  }
}

interface Header {
  meta: NcmMeta;
  stream: Uint8Array;
  cover: Buffer | null;
  audioOffset: number;
}

async function readHeader(fh: FileHandle, path: string, withCover: boolean): Promise<Header> {
  const r = new Cursor(fh, path);
  const head = await r.bytes(14);
  if (head.toString("latin1", 0, 8) !== MAGIC) throw new Error(`${path}: not an NCM file (bad magic)`);

  const keyRaw = await r.bytes(head.readUInt32LE(10));
  for (let i = 0; i < keyRaw.length; i++) keyRaw[i] = keyRaw[i]! ^ 0x64;
  const rc4Key = aesEcbDecrypt(CORE_KEY, keyRaw).subarray(KEY_PREFIX);
  if (rc4Key.length === 0) throw new Error(`${path}: NCM key block is empty`);

  const metaLen = (await r.bytes(4)).readUInt32LE(0);
  if (metaLen === 0) throw new Error(`${path}: NCM file carries no embedded metadata`);
  const metaRaw = await r.bytes(metaLen);
  for (let i = 0; i < metaRaw.length; i++) metaRaw[i] = metaRaw[i]! ^ 0x63;
  const metaCipher = Buffer.from(metaRaw.toString("latin1", META_PREFIX), "base64");
  const meta = parseMeta(aesEcbDecrypt(META_KEY, metaCipher).toString("utf8"), path);

  r.pos += 9; // crc32 + 5 reserved bytes
  const imageSize = (await r.bytes(4)).readUInt32LE(0);
  let cover: Buffer | null = null;
  if (withCover && imageSize > 0) cover = await r.bytes(imageSize);
  else r.pos += imageSize;

  return { meta, stream: xorStream(keyBox(rc4Key)), cover, audioOffset: r.pos };
}

/** Parses only the header (key + metadata); never touches the audio or cover bytes. */
export async function readNcmMeta(path: string): Promise<NcmMeta> {
  const fh = await open(path, "r");
  try {
    return (await readHeader(fh, path, false)).meta;
  } finally {
    await fh.close();
  }
}

async function writeAll(fh: FileHandle, buf: Buffer, length: number): Promise<void> {
  for (let off = 0; off < length; ) off += (await fh.write(buf, off, length - off)).bytesWritten;
}

/** Streams the decrypted audio to `outPath` (parent dir created) and returns the metadata plus embedded cover. */
export async function decryptNcm(path: string, outPath: string): Promise<{ meta: NcmMeta; cover: Uint8Array | null }> {
  const fh = await open(path, "r");
  try {
    const { meta, stream, cover, audioOffset } = await readHeader(fh, path, true);
    await mkdir(dirname(outPath), { recursive: true });
    const out = await open(outPath, "w");
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (let pos = audioOffset; ; ) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
        if (bytesRead === 0) break;
        const base = pos - audioOffset;
        for (let i = 0; i < bytesRead; i++) buf[i] = buf[i]! ^ stream[(base + i) & 0xff]!;
        await writeAll(out, buf, bytesRead);
        pos += bytesRead;
      }
    } finally {
      await out.close();
    }
    return { meta, cover };
  } finally {
    await fh.close();
  }
}
