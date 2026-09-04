import { distance } from "fastest-levenshtein";
import { Converter } from "opencc-js/t2cn";

const toSimplified = Converter({ from: "tw", to: "cn" });

/** NFKC → lowercase → traditional→simplified → drop everything but letters, digits, and combining marks. */
export function normalizeText(s: string): string {
  return toSimplified(s.normalize("NFKC").toLowerCase()).replace(/[^\p{L}\p{N}\p{M}]/gu, "");
}

export interface NormalizedTitle {
  core: string;
  versionTags: Set<string>;
}

/** Keyword → canonical version tag. Tested against a lowercased, simplified annotation segment with spaces intact. */
const VERSION_TAGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\blive\b|现场|演唱会/, "live"],
  [/\bremix\b|混音/, "remix"],
  [/\binstrumental\b|\bkaraoke\b|\boff vocal\b|伴奏|纯音乐|无人声/, "instrumental"],
  [/\bacoustic\b|\bunplugged\b|不插电/, "acoustic"],
  [/\bdemo\b/, "demo"],
  [/\bcover\b|翻唱/, "cover"],
  [/\bdj\b/, "dj"],
  [/\bpiano\b|钢琴/, "piano"],
  [/\bradio edit\b/, "radio"],
  [/\bextended\b/, "extended"],
  [/\bsped up\b|\bspeed up\b/, "spedup"],
  [/\bslowed\b/, "slowed"],
];

const BRACKETS = /\(([^()]*)\)|\[([^[\]]*)\]|【([^【】]*)】|（([^（）]*)）/g;
const DASH_SUFFIX = /\s+[-–—]\s+(.*)$/;
const FEAT_SUFFIX = /\s*\b(?:feat|ft)\.?\s+.*$|\s*\bfeaturing\s+.*$/i;

/**
 * Splits a title into its base text and annotation segments (bracketed groups and the ` - ` suffix).
 * A trailing `feat. X` is dropped from the base (artists are matched separately).
 */
export function splitAnnotations(title: string): { base: string; segments: string[] } {
  const segments: string[] = [];
  let base = title.normalize("NFKC").replace(BRACKETS, (_, a?: string, b?: string, c?: string, d?: string) => {
    segments.push(a ?? b ?? c ?? d ?? "");
    return " ";
  });
  const dash = DASH_SUFFIX.exec(base);
  if (dash) {
    segments.push(dash[1]!);
    base = base.slice(0, dash.index);
  }
  return { base: base.replace(FEAT_SUFFIX, "").trim(), segments };
}

/** Canonical version tags named by an annotation segment such as `Live at Wembley` or `伴奏`. */
export function versionTagsOf(segment: string): string[] {
  const text = toSimplified(segment.toLowerCase());
  const tags: string[] = [];
  for (const [re, tag] of VERSION_TAGS) if (re.test(text)) tags.push(tag);
  return tags;
}

export function normalizeTitle(s: string): NormalizedTitle {
  const { base, segments } = splitAnnotations(s);
  const versionTags = new Set<string>();
  for (const seg of segments) for (const tag of versionTagsOf(seg)) versionTags.add(tag);
  const core = normalizeText(base);
  return { core: core || normalizeText(s), versionTags };
}

const ARTIST_SPLIT = /\s*(?:[/、;,&×]|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s)\s*|\s+x\s+/i;

const normalizedAliasCache = new WeakMap<Record<string, string>, Map<string, string>>();

function normalizedAliases(aliases: Record<string, string>): Map<string, string> {
  let m = normalizedAliasCache.get(aliases);
  if (!m) {
    m = new Map();
    for (const [k, v] of Object.entries(aliases)) m.set(normalizeText(k), normalizeText(v));
    normalizedAliasCache.set(aliases, m);
  }
  return m;
}

/** Raw credit parts (trimmed, non-empty) without normalization; used when a human-readable name is needed. */
export function splitArtists(artists: string[]): string[] {
  return artists.flatMap((a) => a.split(ARTIST_SPLIT)).map((p) => p.trim()).filter((p) => p !== "");
}

/** Splits joint credits, normalizes each name, applies the alias table, and dedupes. */
export function normalizeArtists(artists: string[], aliases: Record<string, string>): string[] {
  const table = normalizedAliases(aliases);
  const out = new Set<string>();
  for (const a of artists) {
    for (const part of a.split(ARTIST_SPLIT)) {
      const n = normalizeText(part);
      if (!n) continue;
      out.add(table.get(n) ?? n);
    }
  }
  return [...out];
}

/** 1 - levenshtein / maxLen, in [0, 1]; two empty strings are identical. */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance(a, b) / maxLen;
}
