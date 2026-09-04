import { parseFile, type IAudioMetadata } from "music-metadata";
import { decode163Key, type NcmMeta } from "./ncm.ts";

export interface FileTags {
  title?: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  isrc?: string;
  /** decoded `163 key(Don't modify):…` comment written by the NetEase client into mp3/flac/m4a downloads */
  netease?: NcmMeta;
}

export async function readTags(path: string): Promise<FileTags> {
  // The cheap header-only pass covers most formats; only scan the whole file when duration is still unknown.
  let meta = await parseFile(path, { skipCovers: true });
  if (meta.format.duration === undefined) meta = await parseFile(path, { skipCovers: true, duration: true });
  const { common, format } = meta;
  const artists = (common.artists ?? (common.artist === undefined ? [] : [common.artist])).map((a) => a.trim()).filter((a) => a !== "");
  const isrc = common.isrc?.[0]?.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return {
    title: common.title?.trim() || undefined,
    artists,
    album: common.album?.trim() || undefined,
    durationMs: format.duration === undefined ? undefined : Math.round(format.duration * 1000),
    isrc: isrc !== undefined && isrc.length === 12 ? isrc : undefined,
    netease: findNeteaseKey(meta, path),
  };
}

/** The NetEase key lives in ID3 COMM (mp3), Vorbis DESCRIPTION/COMMENT (flac/ogg) or ©cmt (m4a); music-metadata folds most into `common.comment`. */
function findNeteaseKey(meta: IAudioMetadata, path: string): NcmMeta | undefined {
  const texts: string[] = [];
  for (const c of meta.common.comment ?? []) {
    const text = typeof c === "string" ? c : c.text;
    if (text) texts.push(text);
  }
  for (const tags of Object.values(meta.native)) {
    for (const t of tags) {
      if (!/^(DESCRIPTION|COMMENT|COMM|TXXX:comment|©cmt)$/i.test(t.id)) continue;
      const v = t.value as unknown;
      if (typeof v === "string") texts.push(v);
      else if (typeof v === "object" && v !== null && "text" in v && typeof v.text === "string") texts.push(v.text);
    }
  }
  for (const text of texts) {
    const m = decode163Key(text, path);
    if (m) return m;
  }
  return undefined;
}

/** Leading track numbers: `01. `, `01.`, `01 - `, `1 - ` (a dot must not be followed by another digit, e.g. `1.5 - x`). */
const TRACK_NO = /^\d{1,3}(?:\.(?!\d)\s*|\s*-\s+)/;
/** First ` - ` (or en/em dash) surrounded by whitespace splits the two halves. */
const SEPARATOR = /^(.*?)\s+[-\u2013\u2014]\s+(.*)$/;
const ARTIST_SEP = /[/、;&,]/;

export function parseFilename(basenameWithoutExt: string, pattern: "artist-title" | "title-artist"): { title: string; artists: string[] } {
  const name = basenameWithoutExt.replace(TRACK_NO, "").trim();
  const m = SEPARATOR.exec(name);
  if (!m) return { title: name, artists: [] };
  const left = m[1]!.trim();
  const right = m[2]!.trim();
  const [artistPart, title] = pattern === "artist-title" ? [left, right] : [right, left];
  return { title, artists: artistPart.split(ARTIST_SEP).map((a) => a.trim()).filter((a) => a !== "") };
}
