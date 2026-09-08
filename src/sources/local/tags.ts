import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseBlob, parseBuffer, parseFile, type IAudioMetadata, type IOptions } from "music-metadata";
import { decode163Key, type NcmMeta } from "./ncm.ts";
import { type Container, sniffContainer, wrappedM4aOffset } from "./wrapped.ts";

export interface FileTags {
  title?: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  isrc?: string;
  /** decoded `163 key(Don't modify):…` comment written by the NetEase client into mp3/flac/m4a downloads */
  netease?: NcmMeta;
}

/** Extensions music-metadata would pick the right parser for anyway, and the MIME type that forces it otherwise. */
const CONTAINER: Record<Container, { ext: readonly string[]; mime: string }> = {
  mp3: { ext: ["mp3"], mime: "audio/mpeg" },
  m4a: { ext: ["m4a", "mp4", "m4b"], mime: "audio/mp4" },
  flac: { ext: ["flac"], mime: "audio/flac" },
  ogg: { ext: ["ogg", "oga", "opus", "spx"], mime: "audio/ogg" },
  wav: { ext: ["wav", "wave"], mime: "audio/wav" },
};

export async function readTags(path: string): Promise<FileTags> {
  // music-metadata picks its parser by extension; a file whose content says otherwise (see wrapped.ts) is parsed
  // by content instead — by name it would read nonsense (an m4a as mp3: no tags, duration 0).
  const container = await sniffContainer(path);
  const parse =
    container === null || CONTAINER[container].ext.includes(extname(path).slice(1).toLowerCase())
      ? (opts: IOptions) => parseFile(path, opts)
      : (opts: IOptions) => parseBlob(Bun.file(path, { type: CONTAINER[container].mime }), opts);
  // The cheap header-only pass covers most formats; only scan the whole file when duration is still unknown.
  let meta = await parse({ skipCovers: true });
  const wrapped = await wrappedM4aOffset(path);
  if (wrapped !== null) {
    // The ID3 tags stay authoritative; the duration must come from the m4a payload the mp3 parser cannot see.
    const payload = await parseBuffer((await readFile(path)).subarray(wrapped), { mimeType: "audio/mp4" }, { skipCovers: true });
    meta = { ...meta, format: { ...meta.format, duration: payload.format.duration } };
  } else if (meta.format.duration === undefined) meta = await parse({ skipCovers: true, duration: true });
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
