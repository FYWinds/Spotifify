import { basename, extname } from "node:path";
import type { Config } from "../../config.ts";
import type { SourceTrackRow } from "../../state/repo.ts";
import { hashFile } from "../../util/fs.ts";
import { log } from "../../util/log.ts";
import { mapLimit } from "../../util/retry.ts";
import type { Source, SourcePlaylist, SourceTrack } from "../types.ts";
import { readNcmMeta } from "./ncm.ts";
import { scanDirs, type ScannedFile } from "./scan.ts";
import { parseFilename, readTags, type FileTags } from "./tags.ts";

export const LOCAL_LIBRARY_ID = "library";

const CONCURRENCY = 8;

type Described = Pick<SourceTrack, "title" | "artists" | "album" | "durationMs" | "isrc" | "neteaseId" | "aliases">;

async function describe(path: string, pattern: Config["local"]["filename_pattern"]): Promise<Described> {
  if (extname(path).toLowerCase() === ".ncm") {
    const m = await readNcmMeta(path);
    return {
      title: m.musicName,
      artists: m.artist.map(([name]) => name),
      album: m.album || undefined,
      durationMs: m.duration,
      // 0 shows up in NCMs of locally-uploaded songs; it is not a real song id
      neteaseId: m.musicId > 0 ? m.musicId : undefined,
      aliases: [...(m.alias ?? []), ...(m.transNames ?? [])],
    };
  }
  let tags: FileTags;
  try {
    tags = await readTags(path);
  } catch (e) {
    // Odd containers (fragmented m4a, truncated files) still deserve a best-effort entry from the file name.
    log.debug(`tags unreadable, using file name: ${path}`, { error: e instanceof Error ? e.message : String(e) });
    tags = { artists: [] };
  }
  const ne = tags.netease;
  if (ne && ne.musicId > 0) {
    // NetEase download with its "163 key" comment: the song id makes it share a canonical key with the playlist track.
    return {
      title: tags.title || ne.musicName,
      artists: tags.artists.length > 0 ? splitNeteaseArtists(tags.artists) : ne.artist.map(([name]) => name),
      album: tags.album || ne.album || undefined,
      durationMs: tags.durationMs ?? ne.duration,
      isrc: tags.isrc,
      neteaseId: ne.musicId,
      aliases: [...(ne.alias ?? []), ...(ne.transNames ?? [])],
    };
  }
  let title = tags.title;
  let artists = tags.artists;
  if (title === undefined || artists.length === 0) {
    const fromName = parseFilename(basename(path, extname(path)), pattern);
    title ??= fromName.title;
    if (artists.length === 0) artists = fromName.artists;
  }
  return { title, artists, album: tags.album, durationMs: tags.durationMs, isrc: tags.isrc, aliases: [] };
}

/** The NetEase client writes all artists into one tag joined by "/" (e.g. "DECO*27/初音ミク"). */
function splitNeteaseArtists(artists: string[]): string[] {
  return artists.flatMap((a) => a.split("/")).map((a) => a.trim()).filter((a) => a !== "");
}

/** Every configured directory merged into a single fixed playlist, tracks in absolute-path order. */
export class LocalSource implements Source {
  readonly kind = "local" as const;

  constructor(
    private readonly cfg: Config["local"],
    /** previous pull keyed by absolute path (repo.localTracksByPath()); unchanged (size, mtime) skips hashing and tag reads */
    private readonly cache: Map<string, SourceTrackRow>,
    private readonly onProgress?: (done: number, total: number) => void,
  ) {}

  async pull(): Promise<{ playlists: Array<{ playlist: SourcePlaylist; tracks: SourceTrack[] }> }> {
    const files = await scanDirs(this.cfg.dirs, this.cfg.extensions);
    let done = 0;
    const tracks = await mapLimit(files, CONCURRENCY, async (file) => {
      const track = await this.track(file);
      this.onProgress?.(++done, files.length);
      return track;
    });
    const playlist: SourcePlaylist = { kind: "local", externalId: LOCAL_LIBRARY_ID, name: this.cfg.playlist_name };
    return { playlists: [{ playlist, tracks: tracks.filter((t) => t !== null) }] };
  }

  private async track(file: ScannedFile): Promise<SourceTrack | null> {
    const cached = this.cache.get(file.path);
    if (cached?.file !== undefined && cached.file.size === file.size && cached.file.mtimeMs === file.mtimeMs) return stripRow(cached);
    try {
      const contentHash = await hashFile(file.path);
      const meta = await describe(file.path, this.cfg.filename_pattern);
      return { kind: "local", externalId: file.path, ...meta, file: { path: file.path, contentHash, size: file.size, mtimeMs: file.mtimeMs } };
    } catch (e) {
      // A file that cannot be read right now (half-downloaded, locked, damaged) is not a file that left the
      // library: the previous row stands until it can be read again, so the track is never treated as removed.
      const error = e instanceof Error ? e.message : String(e);
      if (cached?.file !== undefined) {
        log.warn(`cannot read ${file.path}; keeping its previous metadata: ${error}`);
        return stripRow(cached);
      }
      log.warn(`skipping unreadable file ${file.path}: ${error}`);
      return null;
    }
  }
}

function stripRow(row: SourceTrackRow): SourceTrack {
  const { id: _id, canonicalKey: _key, lastSeenAt: _seen, ...track } = row;
  return track;
}
