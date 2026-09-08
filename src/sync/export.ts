/**
 * Export one unmatched local track into the Spotify desktop "Local Files" folder.
 * Every file goes through ffmpeg so tags are canonical and the resulting `spotify:local:` URI is
 * predictable. mp3/m4a keep their codec; everything else is transcoded to mp3. See DESIGN.md §6.5.
 */
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Config } from "../config.ts";
import { decryptNcm, type NcmMeta } from "../sources/local/ncm.ts";
import { sniffContainer, unwrapM4a, wrappedM4aOffset } from "../sources/local/wrapped.ts";
import type { LocalExportRow, Repo, SourceTrackRow } from "../state/repo.ts";
import { buildLocalUri } from "../spotify/localUri.ts";
import { probeMp3, probeMp4DurationSec } from "./duration.ts";
import { log } from "../util/log.ts";
import type { ExportPlan } from "./plan.ts";
import { RetryableError, withRetry } from "../util/retry.ts";

export interface ExportResult {
  exportPath: string;
  localUri: string;
  /** tag values actually written */
  tags: { artist: string; album: string; title: string };
  /** whole seconds as the desktop client will index them (last uri segment) */
  durationSec: number;
}

const COPY_EXT: Record<string, "mp3" | "m4a"> = { mp3: "mp3", m4a: "m4a", mp4: "m4a", aac: "m4a" };

/** Containers this module writes and the ffmpeg muxer for each. */
const MUXER = { mp3: "mp3", m4a: "mp4", flac: "flac", ogg: "ogg", wav: "wav" } as const;

export type OutputExt = keyof typeof MUXER;

export interface FfmpegTags {
  title: string;
  artist: string;
  album: string;
  comment?: string;
}

export interface StagedInput {
  /** what ffmpeg opens */
  input: string;
  inputExt: string;
  coverPath: string | null;
  /** header metadata when the source is an .ncm */
  ncm: NcmMeta | null;
}

export class ExportError extends Error {}

/**
 * Turn a library file into something ffmpeg opens: `.ncm` is decrypted (audio + cover to temp files),
 * an m4a behind an ID3v2 tag is unwrapped, anything else is used as is — under the container its bytes
 * say it is, not the one its name claims (see wrapped.ts). Temp paths are appended to `cleanup` before
 * they are written so a failure mid-way still removes them.
 */
export async function stageInput(sourcePath: string, tmpBase: string, cleanup: string[]): Promise<StagedInput> {
  const ext = extname(sourcePath).slice(1).toLowerCase();
  if (ext === "ncm") {
    const input = `${tmpBase}.audio`;
    cleanup.push(input);
    const { meta, cover } = await decryptNcm(sourcePath, input);
    let coverPath: string | null = null;
    if (cover && cover.length > 0) {
      coverPath = `${tmpBase}.cover`;
      cleanup.push(coverPath);
      await writeFile(coverPath, cover);
    }
    return { input, inputExt: meta.format.toLowerCase(), coverPath, ncm: meta };
  }
  const wrapped = await wrappedM4aOffset(sourcePath);
  if (wrapped !== null) {
    const input = `${tmpBase}.m4a`;
    cleanup.push(input);
    await unwrapM4a(sourcePath, wrapped, input);
    return { input, inputExt: "m4a", coverPath: null, ncm: null };
  }
  return { input: sourcePath, inputExt: (await sniffContainer(sourcePath)) ?? ext, coverPath: null, ncm: null };
}

export async function exportTrack(plan: ExportPlan, track: SourceTrackRow, cfg: Config["export"]): Promise<ExportResult> {
  const tmpBase = join(tmpdir(), `spotifify-${track.file?.contentHash.slice(0, 16) ?? Date.now()}`);
  const cleanup: string[] = [];
  try {
    const { input, inputExt, coverPath, ncm } = await stageInput(plan.sourcePath, tmpBase, cleanup);
    const tags = ncm
      ? { artist: ncm.artist.map(([name]) => name).join(", "), album: ncm.album, title: ncm.musicName }
      : { artist: track.artists.join(", "), album: track.album ?? "", title: track.title };
    const outExt = COPY_EXT[inputExt] ?? "mp3";
    const mode: "copy" | "mp3" = COPY_EXT[inputExt] ? "copy" : "mp3";
    const exportPath = join(cfg.dir, `${plan.baseName}.${outExt}`);
    // The desktop client watches export.dir: it parses a path once when the entry is created and drops it
    // when the entry disappears, never re-reading in between. So ffmpeg must not write the final name
    // (a half-written file is indexed with an unknown duration and never plays); the finished file is
    // produced under a non-audio extension and then placed as a new, complete entry (see placeExport).
    const partPath = `${exportPath}.part`;
    cleanup.push(partPath);
    await mkdir(cfg.dir, { recursive: true });

    const encode = ["-c:a", "libmp3lame", "-b:a", cfg.bitrate];
    const codec = mode === "copy" ? ["-c:a", "copy"] : encode;
    let withCover = await runFfmpeg(cfg.ffmpeg, input, inputExt, coverPath, tags, codec, outExt, partPath);
    if (!withCover.ok) {
      // Cover muxing is the fragile part (odd picture streams, mp4 attached_pic quirks): retry audio-only.
      const audioOnly = await runFfmpeg(cfg.ffmpeg, input, inputExt, null, tags, codec, outExt, partPath, false);
      if (!audioOnly.ok) throw new ExportError(`ffmpeg failed for ${plan.sourcePath}: ${audioOnly.stderr}`);
      log.warn("exported without cover art", { path: exportPath });
    }
    let durationSec = await probeDuration(partPath, outExt);
    if (durationSec === null && outExt === "mp3" && mode === "copy") {
      // A copied VBR stream: the client's duration for "Xing" files is unverified, so re-encode to CBR.
      withCover = await runFfmpeg(cfg.ffmpeg, input, inputExt, coverPath, tags, encode, outExt, partPath);
      if (!withCover.ok) throw new ExportError(`ffmpeg re-encode failed for ${plan.sourcePath}: ${withCover.stderr}`);
      durationSec = await probeDuration(partPath, outExt);
    }
    if (durationSec === null) throw new ExportError(`cannot determine the client duration of ${exportPath}`);
    await placeExport(partPath, exportPath);

    return { exportPath, localUri: buildLocalUri({ ...tags, durationSec }), tags, durationSec };
  } finally {
    await Promise.all(cleanup.map((p) => rm(p, { force: true })));
  }
}

/**
 * Make the finished file appear at `exportPath` as a freshly created, complete entry. A hard link to the
 * `.part` file is atomic and raises the watcher's "added" event with the whole content already there;
 * a rename is only the fallback for filesystems without hard links (the client then sees the file at its
 * next restart or folder toggle). An existing file is removed first so the client drops its old entry;
 * that fails with EPERM/EBUSY while the client has it open (playing), which clears within seconds.
 */
async function placeExport(partPath: string, exportPath: string): Promise<void> {
  await removeFile(exportPath);
  try {
    await link(partPath, exportPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOSYS" && code !== "ENOTSUP") throw e;
    log.warn("hard link unavailable, renaming instead; the desktop client will only index the file after a restart", { path: exportPath });
    await rename(partPath, exportPath);
  }
}

/** Delete with retries: the desktop client holds an exported file open while it plays it (EPERM/EBUSY on Windows). */
async function removeFile(path: string): Promise<void> {
  await withRetry(
    async () => {
      try {
        await rm(path, { force: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EBUSY") throw new RetryableError(`${code} removing ${path}`);
        throw e;
      }
    },
    { attempts: 6, baseMs: 500 },
  );
}

/** Garbage-collect exports (file + record). A file that cannot be deleted keeps its record so the next run retries. Returns the number removed. */
export async function removeExports(rows: readonly LocalExportRow[], repo: Repo): Promise<number> {
  let removed = 0;
  for (const e of rows) {
    try {
      await removeFile(e.exportPath);
      repo.deleteExport(e.canonicalKey);
      removed++;
      log.info("removed export", { path: e.exportPath });
    } catch (err) {
      log.error("export removal failed", { path: e.exportPath, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return removed;
}

/** null: unparsable, or a VBR mp3 whose client duration is not predictable. */
async function probeDuration(path: string, ext: "mp3" | "m4a"): Promise<number | null> {
  const buf = await readFile(path);
  if (ext === "m4a") return probeMp4DurationSec(buf);
  const p = probeMp3(buf);
  return p === null || p.vbr ? null : p.durationSec;
}

/**
 * Write `input` to `outPath` carrying exactly `tags` (every other tag dropped) and, when `includeCover`, the cover art.
 * `comment` lands in the container's comment field; for mp3 that is a COMM frame written here (what the NetEase client
 * writes and reads), because ffmpeg stores it as TXXX, which ID3v2.3 readers split on "/" — a base64 key never survives that.
 */
export async function runFfmpeg(
  ffmpeg: string,
  input: string,
  inputExt: string,
  coverPath: string | null,
  tags: FfmpegTags,
  codec: string[],
  outExt: OutputExt,
  outPath: string,
  includeCover = true,
): Promise<{ ok: boolean; stderr: string }> {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  // Raw decrypted ncm audio has no extension; tell ffmpeg the container explicitly.
  if (input.endsWith(".audio")) args.push("-f", inputExt === "mp3" ? "mp3" : inputExt);
  args.push("-i", input);
  if (coverPath) args.push("-i", coverPath);
  args.push("-map", "0:a:0");
  if (includeCover) {
    if (coverPath) args.push("-map", "1:v:0");
    else args.push("-map", "0:v:0?");
    args.push("-c:v", "copy", "-disposition:v:0", "attached_pic");
  }
  args.push("-map_metadata", "-1", "-map_chapters", "-1");
  args.push("-metadata", `title=${tags.title}`, "-metadata", `artist=${tags.artist}`, "-metadata", `album=${tags.album}`);
  if (tags.comment !== undefined && outExt !== "mp3") args.push("-metadata", `comment=${tags.comment}`);
  args.push(...codec);
  if (outExt === "mp3") args.push("-id3v2_version", "3", "-write_id3v1", "1");
  if (outExt === "m4a") args.push("-movflags", "+faststart");
  args.push("-f", MUXER[outExt], outPath);

  const proc = Bun.spawn([ffmpeg, ...args], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code === 0 && tags.comment !== undefined && outExt === "mp3") await prependId3Comment(outPath, tags.comment);
  return { ok: code === 0, stderr: stderr.trim() };
}

/** Insert a COMM frame (ISO-8859-1, language "eng", no description) at the front of the file's ID3v2 tag. */
async function prependId3Comment(path: string, text: string): Promise<void> {
  const file = await readFile(path);
  // ffmpeg writes a plain tag: no extended header (flag 0x40), which would have to precede any frame.
  if (file.length < 10 || file.toString("latin1", 0, 3) !== "ID3" || file[5]! & 0x40) throw new ExportError(`${path}: no plain ID3v2 tag to extend`);
  const body = Buffer.from(text, "latin1");
  const size = 5 + body.length; // encoding + language + description terminator + text
  const frame = Buffer.alloc(10 + size);
  frame.write("COMM", 0, "latin1");
  // v2.4 frame sizes are syncsafe, v2.3 plain big-endian
  frame.writeUInt32BE(file[3]! >= 4 ? syncsafe(size) : size, 4);
  frame.write("eng", 11, "latin1");
  body.copy(frame, 15);
  const tagSize = ((file[6]! & 0x7f) << 21) | ((file[7]! & 0x7f) << 14) | ((file[8]! & 0x7f) << 7) | (file[9]! & 0x7f);
  const header = Buffer.from(file.subarray(0, 10));
  header.writeUInt32BE(syncsafe(tagSize + frame.length), 6);
  await writeFile(path, Buffer.concat([header, frame, file.subarray(10)]));
}

function syncsafe(n: number): number {
  return (n & 0x7f) | ((n & 0x3f80) << 1) | ((n & 0x1fc000) << 2) | ((n & 0xfe00000) << 3);
}
