/**
 * Export one unmatched local track into the Spotify desktop "Local Files" folder.
 * Every file goes through ffmpeg so tags are canonical and the resulting `spotify:local:` URI is
 * predictable. mp3/m4a keep their codec; everything else is transcoded to mp3. See DESIGN.md §6.5.
 */
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Config } from "../config.ts";
import { decryptNcm } from "../sources/local/ncm.ts";
import type { SourceTrackRow } from "../state/repo.ts";
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

export class ExportError extends Error {}

export async function exportTrack(plan: ExportPlan, track: SourceTrackRow, cfg: Config["export"]): Promise<ExportResult> {
  const tmpBase = join(tmpdir(), `spotifify-${track.file?.contentHash.slice(0, 16) ?? Date.now()}`);
  const cleanup: string[] = [];
  try {
    let input = plan.sourcePath;
    let inputExt = extname(plan.sourcePath).slice(1).toLowerCase();
    let coverPath: string | null = null;
    let tags = { artist: track.artists.join(", "), album: track.album ?? "", title: track.title };

    if (plan.decryptNcm) {
      const { meta, cover } = await decryptNcm(plan.sourcePath, `${tmpBase}.${"audio"}`);
      input = `${tmpBase}.audio`;
      cleanup.push(input);
      inputExt = meta.format.toLowerCase();
      tags = { artist: meta.artist.map(([name]) => name).join(", "), album: meta.album, title: meta.musicName };
      if (cover && cover.length > 0) {
        coverPath = `${tmpBase}.cover`;
        await writeFile(coverPath, cover);
        cleanup.push(coverPath);
      }
    }
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
  await withRetry(
    async () => {
      try {
        await rm(exportPath, { force: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EBUSY") throw new RetryableError(`${code} replacing ${exportPath}`);
        throw e;
      }
    },
    { attempts: 6, baseMs: 500 },
  );
  try {
    await link(partPath, exportPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOSYS" && code !== "ENOTSUP") throw e;
    log.warn("hard link unavailable, renaming instead; the desktop client will only index the file after a restart", { path: exportPath });
    await rename(partPath, exportPath);
  }
}

/** null: unparsable, or a VBR mp3 whose client duration is not predictable. */
async function probeDuration(path: string, ext: "mp3" | "m4a"): Promise<number | null> {
  const buf = await readFile(path);
  if (ext === "m4a") return probeMp4DurationSec(buf);
  const p = probeMp3(buf);
  return p === null || p.vbr ? null : p.durationSec;
}

async function runFfmpeg(
  ffmpeg: string,
  input: string,
  inputExt: string,
  coverPath: string | null,
  tags: ExportResult["tags"],
  codec: string[],
  outExt: string,
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
  args.push(...codec);
  if (outExt === "mp3") args.push("-id3v2_version", "3", "-write_id3v1", "1");
  if (outExt === "m4a") args.push("-movflags", "+faststart");
  args.push("-f", outExt === "m4a" ? "mp4" : "mp3", outPath);

  const proc = Bun.spawn([ffmpeg, ...args], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, stderr: stderr.trim() };
}
