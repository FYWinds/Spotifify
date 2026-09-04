import { createCipheriv } from "node:crypto";
import { keyBox } from "../../src/sources/local/ncm.ts";

export const CORE_KEY = Buffer.from("687A4852416D736F356B496E62617857", "hex");
export const META_KEY = Buffer.from("2331346C6A6B5F215C5D2630553C2728", "hex");

export function aesEcbEncrypt(key: Buffer, data: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(data), c.final()]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

/** Encrypts a container exactly as the format describes; the audio XOR is symmetric so the reference formula is reused. */
export function buildNcm(opts: { rc4Key: Buffer; metaText: string; cover: Buffer; audio: Buffer }): Buffer {
  const keyField = aesEcbEncrypt(CORE_KEY, Buffer.concat([Buffer.from("neteasecloudmusic"), opts.rc4Key])).map((b) => b ^ 0x64);
  const metaB64 = aesEcbEncrypt(META_KEY, Buffer.from(opts.metaText, "utf8")).toString("base64");
  const metaField = Buffer.from("163 key(Don't modify):" + metaB64, "latin1").map((b) => b ^ 0x63);
  const box = keyBox(opts.rc4Key);
  const audio = Buffer.from(opts.audio);
  for (let i = 0; i < audio.length; i++) {
    const j = (i + 1) & 0xff;
    audio[i] = audio[i]! ^ box[(box[j]! + box[(box[j]! + j) & 0xff]!) & 0xff]!;
  }
  return Buffer.concat([
    Buffer.from("CTENFDAM"),
    Buffer.alloc(2),
    u32(keyField.length),
    keyField,
    u32(metaField.length),
    metaField,
    Buffer.alloc(4), // crc32 (unchecked)
    Buffer.alloc(5),
    u32(opts.cover.length),
    opts.cover,
    audio,
  ]);
}
