import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { log } from "../../util/log.ts";

export interface ScannedFile {
  path: string;
  size: number;
  /** integer milliseconds (sub-ms precision dropped so cached values compare exactly) */
  mtimeMs: number;
}

/**
 * Recursively lists files under `dirs` whose extension is in `extensions` (case-insensitive, with or without the dot).
 * Dot-entries and symlinks are skipped; a missing/unreadable root throws, an unreadable subdirectory is logged and skipped.
 * Result paths are absolute, de-duplicated, and sorted by ordinal comparison.
 */
export async function scanDirs(dirs: string[], extensions: string[]): Promise<ScannedFile[]> {
  const exts = new Set(extensions.map((e) => "." + e.replace(/^\./, "").toLowerCase()));
  const seen = new Set<string>();
  const out: ScannedFile[] = [];
  for (const dir of dirs) {
    const root = resolve(dir);
    await walk(root, await readdir(root, { withFileTypes: true }), exts, seen, out);
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

async function walk(
  dir: string,
  entries: Dirent[],
  exts: Set<string>,
  seen: Set<string>,
  out: ScannedFile[],
): Promise<void> {
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      let children;
      try {
        children = await readdir(full, { withFileTypes: true });
      } catch (e) {
        log.warn(`skipping unreadable directory ${full}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      await walk(full, children, exts, seen, out);
    } else if (ent.isFile() && exts.has(extname(ent.name).toLowerCase()) && !seen.has(full)) {
      seen.add(full);
      const st = await stat(full);
      out.push({ path: full, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    }
  }
}
