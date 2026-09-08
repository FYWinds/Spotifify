/**
 * Give a playlist track that has no usable local file one by hand (`spotifify attach`, `l` in the review TUI).
 * The file is copied into the first `local.dirs` directory with canonical tags plus the NetEase "163 key"
 * comment naming the song — what the NetEase client itself writes for a download. The next pull links the
 * copy to the playlist track through the shared `netease:{id}` key, the NetEase client recognises it as that
 * song, and the export step turns it into the Spotify local file. See DESIGN.md §4.3.
 */
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { encode163Key } from "../sources/local/ncm.ts";
import { describeFile, TruncatedDownloadError } from "../sources/local/source.ts";
import { readTags } from "../sources/local/tags.ts";
import type { SourceTrackRow } from "../state/repo.ts";
import { MAX_FILENAME, sanitizeFilename } from "../util/fs.ts";
import { log } from "../util/log.ts";
import { type OutputExt, runFfmpeg, stageInput } from "./export.ts";

export class AttachError extends Error {}

export interface AttachResult {
  /** where the tagged copy landed */
  path: string;
  /** earlier downloads of the same song under that name (a truncated preview, a damaged file) that were replaced */
  replaced: string[];
}

export type AttachTrack = Pick<SourceTrackRow, "neteaseId" | "title" | "artists" | "album" | "durationMs" | "aliases">;

/** Containers kept as they are (Opus/WebM audio is rewrapped as Ogg); anything else is encoded to mp3 like the export step does. */
const KEEP_EXT: Record<string, OutputExt> = { mp3: "mp3", m4a: "m4a", mp4: "m4a", aac: "m4a", flac: "flac", ogg: "ogg", oga: "ogg", opus: "ogg", webm: "ogg", wav: "wav" };

export async function attachFile(track: AttachTrack, sourcePath: string, cfg: Pick<Config, "local" | "export">): Promise<AttachResult> {
  if (track.neteaseId === undefined) throw new AttachError("only tracks known by NetEase id can be given a file this way");
  const dir = cfg.local.dirs[0];
  if (!cfg.local.enabled || dir === undefined) throw new AttachError("local.enabled must be on and local.dirs non-empty: the file is placed in local.dirs[0]");
  // Windows "Copy as path" and shell completion quote the path.
  const source = sourcePath.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!(await stat(source).catch(() => null))?.isFile()) throw new AttachError(`not a file: ${source}`);

  const tmpBase = join(tmpdir(), `spotifify-attach-${process.pid}-${Date.now()}`);
  const cleanup: string[] = [];
  try {
    const { input, inputExt, coverPath } = await stageInput(source, tmpBase, cleanup);
    const outExt = KEEP_EXT[inputExt] ?? "mp3";
    if (!cfg.local.extensions.includes(outExt)) throw new AttachError(`local.extensions does not include "${outExt}"; the scanner would ignore the file`);
    const codec = KEEP_EXT[inputExt] ? ["-c:a", "copy"] : ["-c:a", "libmp3lame", "-b:a", cfg.export.bitrate];
    const album = track.album ?? "";
    const tags = {
      title: track.title,
      // The NetEase client joins artists with "/" and the scanner splits that back (see source.ts).
      artist: track.artists.join("/"),
      album,
      comment: encode163Key({
        musicId: track.neteaseId,
        musicName: track.title,
        artist: track.artists.map((name) => [name, 0]),
        album,
        alias: track.aliases,
        format: outExt,
        duration: track.durationMs ?? 0,
      }),
    };
    const staged = `${tmpBase}.${outExt}`;
    cleanup.push(staged);
    let r = await runFfmpeg(cfg.export.ffmpeg, input, inputExt, coverPath, tags, codec, outExt, staged);
    if (!r.ok) {
      r = await runFfmpeg(cfg.export.ffmpeg, input, inputExt, null, tags, codec, outExt, staged, false);
      if (!r.ok) throw new AttachError(`ffmpeg failed for ${source}: ${r.stderr}`);
      log.warn("attached without cover art", { path: source });
    }
    // The scanner is the judge: the copy must read back as this song, whole.
    let described;
    try {
      described = await describeFile(staged, cfg.local.filename_pattern);
    } catch (e) {
      if (e instanceof TruncatedDownloadError) throw new AttachError(`${source} ${e.message}; not attached`);
      throw e;
    }
    if (described.neteaseId !== track.neteaseId) throw new AttachError(`the tagged copy does not read back as netease:${track.neteaseId} (${outExt} comment tags unsupported?)`);

    await mkdir(dir, { recursive: true });
    const base = sanitizeFilename(`${track.artists.join(", ") || "Unknown Artist"} - ${track.title}`);
    const replaced = await removeSameSong(dir, base, track.neteaseId, cfg.local.extensions);
    const target = await freeName(dir, base, outExt);
    await moveFile(staged, target);
    return { path: target, replaced };
  } finally {
    await Promise.all(cleanup.map((p) => rm(p, { force: true })));
  }
}

/**
 * Delete `{base}.{ext}` for every scanned extension when the file carries this song's 163 key — the
 * stub or damaged download the new file stands in for. Files of other songs, or unreadable ones whose
 * identity cannot be proven, stay. Returns the paths removed.
 */
async function removeSameSong(dir: string, base: string, neteaseId: number, extensions: readonly string[]): Promise<string[]> {
  const wanted: Record<string, true> = {};
  for (const ext of extensions) if (ext !== "ncm") wanted[`${base}.${ext}`.toLowerCase()] = true;
  const removed: string[] = [];
  for (const name of await readdir(dir)) {
    if (!wanted[name.toLowerCase()]) continue;
    const path = join(dir, name);
    const tags = await readTags(path).catch(() => null);
    if (tags?.netease?.musicId !== neteaseId) continue;
    await rm(path);
    removed.push(path);
  }
  return removed;
}

/** `{base}.{ext}` in `dir`, with a ` (n)` suffix while the name is taken (suffix appended after truncation, as export names are). */
async function freeName(dir: string, base: string, ext: OutputExt): Promise<string> {
  let path = join(dir, `${base}.${ext}`);
  for (let n = 2; await stat(path).catch(() => null); n++) {
    const suffix = ` (${n})`;
    path = join(dir, `${base.slice(0, MAX_FILENAME - suffix.length)}${suffix}.${ext}`);
  }
  return path;
}

/** rename, or across volumes copy under a `.part` name (ignored by the scanner) and rename into place. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  const part = `${to}.part`;
  await copyFile(from, part);
  await rename(part, to);
}
