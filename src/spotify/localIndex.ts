/**
 * Reader for the desktop client's local-file index (`local-files.bnk`), the source of truth for which
 * files it knows and which identity (tags + its own duration) it computed for each. `spotifify doctor`
 * compares it with `local_export` so a broken index (half-written file, dropped entry, duration
 * mismatch) is diagnosed instead of showing up as grey playlist rows.
 *
 * The format is undocumented ("SPCO" container, protobuf-like records); this parser only walks the
 * repeating record shape observed in the wild and gives up quietly when it does not match:
 *   09 <len> title  09 <len> artist  09 <len> album  10 <varint seconds> … 2c 01 <len> path … 08 01 78 78 04
 * The file is written when the client flushes (shutdown, rescan), so it may lag the live index.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { LocalExportRow } from "../state/repo.ts";
import { parseLocalUri } from "./localUri.ts";

export interface LocalIndexEntry {
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  path: string;
}

const RECORD_SEPARATOR = [0x08, 0x01, 0x78, 0x78, 0x04];

/** Every `Users/<id>-user/local-files.bnk` of every known client install location. */
export function findLocalFilesIndexes(): string[] {
  const home = homedir();
  const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const roots =
    process.platform === "win32"
      ? [join(local, "Packages", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0", "LocalState", "Spotify", "Users"), join(local, "Spotify", "Users")]
      : process.platform === "darwin"
        ? [join(home, "Library", "Application Support", "Spotify", "Users")]
        : [join(home, ".config", "spotify", "Users"), join(home, ".var", "app", "com.spotify.Client", "config", "spotify", "Users")];
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const user of readdirSync(root)) {
      const file = join(root, user, "local-files.bnk");
      if (user.endsWith("-user") && existsSync(file)) out.push(file);
    }
  }
  return out;
}

function readVarint(b: Uint8Array, at: number): [value: number, next: number] | null {
  let value = 0;
  let shift = 0;
  for (let i = at; i < b.length && shift <= 35; i++, shift += 7) {
    const c = b[i]!;
    value += (c & 0x7f) * 2 ** shift;
    if (c < 0x80) return [value, i + 1];
  }
  return null;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
/** paths occasionally carry stray bytes in the file (seen once in 81 records); identity fields never did */
const lenientDecoder = new TextDecoder("utf-8");

/** `09 <varint len> <utf-8>` */
function readString(b: Uint8Array, at: number): [value: string, next: number] | null {
  if (b[at] !== 0x09) return null;
  const len = readVarint(b, at + 1);
  if (!len) return null;
  const [n, start] = len;
  if (start + n > b.length) return null;
  try {
    return [decoder.decode(b.subarray(start, start + n)), start + n];
  } catch {
    return null;
  }
}

function indexOfSeq(b: Uint8Array, seq: readonly number[], from: number): number {
  outer: for (let i = from; i + seq.length <= b.length; i++) {
    for (let j = 0; j < seq.length; j++) if (b[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

export function parseLocalFilesIndex(b: Uint8Array): LocalIndexEntry[] {
  const out: LocalIndexEntry[] = [];
  let at = indexOfSeq(b, RECORD_SEPARATOR, 0);
  while (at !== -1) {
    const next = indexOfSeq(b, RECORD_SEPARATOR, at + RECORD_SEPARATOR.length);
    const end = next === -1 ? b.length : next;
    const entry = parseRecord(b, at + RECORD_SEPARATOR.length, end);
    if (entry) out.push(entry);
    at = next;
  }
  return out;
}

function parseRecord(b: Uint8Array, at: number, end: number): LocalIndexEntry | null {
  const title = readString(b, at);
  if (!title) return null;
  const artist = readString(b, title[1]);
  if (!artist) return null;
  const album = readString(b, artist[1]);
  if (!album) return null;
  if (b[album[1]] !== 0x10) return null;
  const duration = readVarint(b, album[1] + 1);
  if (!duration) return null;
  // the path follows further down the record: 2c 01 <varint len> <utf-8>
  const p = indexOfSeq(b, [0x2c, 0x01], duration[1]);
  if (p === -1 || p >= end) return null;
  const len = readVarint(b, p + 2);
  if (!len) return null;
  const [n, start] = len;
  if (n === 0 || start + n > end) return null;
  return { title: title[0], artist: artist[0], album: album[0], durationSec: duration[0], path: lenientDecoder.decode(b.subarray(start, start + n)) };
}

export interface IndexComparison {
  /** exports the client has not indexed at all (file names) */
  missing: string[];
  /** exports the client indexed with a different duration: the pasted uri will never link */
  mismatched: Array<{ file: string; ours: number; client: number }>;
  /** exports found with the identical identity */
  matched: number;
}

/** Compare `local_export` identities with the client's index, keyed by tags (the client's own key); paths are not compared. */
export function compareExports(entries: readonly LocalIndexEntry[], exports: readonly LocalExportRow[]): IndexComparison {
  const key = (title: string, artist: string, album: string) => `${title}\u0000${artist}\u0000${album}`;
  const byIdentity = new Map(entries.map((e) => [key(e.title, e.artist, e.album), e]));
  const out: IndexComparison = { missing: [], mismatched: [], matched: 0 };
  for (const e of exports) {
    const p = parseLocalUri(e.localUri);
    if (!p) continue;
    const file = basename(e.exportPath);
    const hit = byIdentity.get(key(p.title, p.artist, p.album));
    if (!hit) out.missing.push(file);
    else if (hit.durationSec !== p.durationSec) out.mismatched.push({ file, ours: p.durationSec ?? -1, client: hit.durationSec });
    else out.matched++;
  }
  return out;
}
