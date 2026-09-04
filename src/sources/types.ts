export type SourceKind = "netease" | "local";

export interface SourcePlaylist {
  kind: SourceKind;
  /** netease playlist id, or the fixed "library" id for the local source */
  externalId: string;
  name: string;
  /** source-side modification time (ms); undefined when the source cannot report one */
  sourceUpdatedAt?: number;
}

export interface SourceTrack {
  kind: SourceKind;
  /** netease song id, or the absolute file path for local tracks */
  externalId: string;
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  isrc?: string;
  /** known for netease-source tracks and for .ncm files (header musicId) */
  neteaseId?: number;
  /** alternative titles: netease `alia`/`tns`, ncm `alias`/`transNames` */
  aliases: string[];
  file?: {
    path: string;
    /** blake2b256 of the file as stored on disk (encrypted bytes for .ncm) */
    contentHash: string;
    size: number;
    mtimeMs: number;
  };
}

/**
 * Identity under which match decisions are shared across sources.
 * Priority: netease id > ISRC > file content hash.
 */
export function canonicalKey(t: SourceTrack): string {
  if (t.neteaseId !== undefined) return `netease:${t.neteaseId}`;
  if (t.isrc) return `isrc:${t.isrc.toUpperCase()}`;
  if (t.file) return `local:${t.file.contentHash}`;
  throw new Error(`track ${t.kind}:${t.externalId} has no identity (no neteaseId, isrc, or file)`);
}

/** Pull one source into canonical playlists + ordered tracks. Implementations must be side-effect free. */
export interface Source {
  readonly kind: SourceKind;
  pull(): Promise<{ playlists: Array<{ playlist: SourcePlaylist; tracks: SourceTrack[] }> }>;
}
