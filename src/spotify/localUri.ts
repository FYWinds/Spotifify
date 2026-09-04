/**
 * Spotify desktop derives a local file's identity from its tags and its own duration computation:
 *   spotify:local:{artist}:{album}:{title}:{durationSec}
 * Segments are percent-encoded with spaces as "+". The client normalizes whatever is pasted into this
 * form (a three-segment paste comes back from the API as `…:0`) and only links an entry to a file when
 * every segment — the whole-second duration included — equals what its index computed (see
 * `sync/duration.ts`). Encoding details drift across client versions (it writes "(" as "%28"), so
 * remote URIs are compared via `canonicalLocalUri`.
 */

export interface LocalUriParts {
  artist: string;
  album: string;
  title: string;
  /** null only for a bare three-segment uri, which the client never produces itself */
  durationSec: number | null;
}

const PREFIX = "spotify:local:";

export function buildLocalUri(p: LocalUriParts): string {
  const seg = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
  const base = `${PREFIX}${seg(p.artist)}:${seg(p.album)}:${seg(p.title)}`;
  return p.durationSec === null ? base : `${base}:${p.durationSec}`;
}

export function parseLocalUri(uri: string): LocalUriParts | null {
  if (!uri.startsWith(PREFIX)) return null;
  const segs = uri.slice(PREFIX.length).split(":");
  if (segs.length !== 3 && segs.length !== 4) return null;
  let durationSec: number | null = null;
  if (segs.length === 4) {
    durationSec = Number(segs[3]);
    if (!Number.isInteger(durationSec) || durationSec < 0) return null;
  }
  try {
    const dec = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
    return { artist: dec(segs[0]!), album: dec(segs[1]!), title: dec(segs[2]!), durationSec };
  } catch {
    return null;
  }
}

/** Normal form used for equality between `local_export.local_uri` and remote playlist items. */
export function canonicalLocalUri(uri: string): string | null {
  const parts = parseLocalUri(uri);
  return parts === null ? null : buildLocalUri(parts);
}
