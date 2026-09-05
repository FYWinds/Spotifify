import { createReadStream } from "node:fs";

/** Longest base name (without extension) an export file gets, in UTF-16 units (NTFS's limit is 255). */
export const MAX_FILENAME = 150;

/** Replace characters Windows/NTFS rejects and trim trailing dots/spaces. */
export function sanitizeFilename(name: string, max = MAX_FILENAME): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return (cleaned || "untitled").slice(0, max);
}

/** blake2b256 hex digest of a file, streamed. */
export async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("blake2b256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hasher.update(chunk as Buffer);
  return hasher.digest("hex");
}
