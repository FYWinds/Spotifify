import { createReadStream } from "node:fs";

/** Replace characters Windows/NTFS rejects and trim trailing dots/spaces. */
export function sanitizeFilename(name: string, max = 150): string {
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
