import type { Database } from "bun:sqlite";
import type { Candidate, DecidedBy, MatchRow, MatchStatus } from "../match/types.ts";
import { canonicalKey, type SourceKind, type SourcePlaylist, type SourceTrack } from "../sources/types.ts";

export interface SourcePlaylistRow {
  id: number;
  kind: SourceKind;
  externalId: string;
  name: string;
  sourceUpdatedAt: number | null;
  lastSeenAt: number;
}

export interface SourceTrackRow extends SourceTrack {
  id: number;
  canonicalKey: string;
  lastSeenAt: number;
}

export interface SpotifyPlaylistRow {
  sourcePlaylistId: number;
  spotifyId: string;
  name: string;
  snapshotId: string | null;
  lastSyncedAt: number | null;
}

export interface LocalExportRow {
  canonicalKey: string;
  exportPath: string;
  localUri: string;
  contentHash: string;
  exportedAt: number;
}

export interface FingerprintRow {
  contentHash: string;
  fp: string;
  durationS: number;
  acoustid: unknown;
  isrcs: string[];
  fetchedAt: number;
}

export interface PulledPlaylist {
  playlist: SourcePlaylist;
  tracks: SourceTrack[];
}

interface DbSourceTrack {
  id: number;
  kind: SourceKind;
  external_id: string;
  canonical_key: string;
  title: string;
  artists: string;
  album: string | null;
  duration_ms: number | null;
  isrc: string | null;
  netease_id: number | null;
  aliases: string;
  file_path: string | null;
  content_hash: string | null;
  file_size: number | null;
  file_mtime: number | null;
  last_seen_at: number;
}

interface DbMatch {
  canonical_key: string;
  status: MatchStatus;
  spotify_id: string | null;
  spotify_uri: string | null;
  score: number | null;
  decided_by: DecidedBy | null;
  candidates: string;
  decided_at: number | null;
  last_search_at: number | null;
  search_count: number;
}

function toTrackRow(r: DbSourceTrack): SourceTrackRow {
  return {
    id: r.id,
    kind: r.kind,
    externalId: r.external_id,
    canonicalKey: r.canonical_key,
    title: r.title,
    artists: JSON.parse(r.artists) as string[],
    album: r.album ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    isrc: r.isrc ?? undefined,
    neteaseId: r.netease_id ?? undefined,
    aliases: JSON.parse(r.aliases) as string[],
    file:
      r.file_path !== null && r.content_hash !== null
        ? { path: r.file_path, contentHash: r.content_hash, size: r.file_size ?? 0, mtimeMs: r.file_mtime ?? 0 }
        : undefined,
    lastSeenAt: r.last_seen_at,
  };
}

function toMatchRow(r: DbMatch): MatchRow {
  return {
    canonicalKey: r.canonical_key,
    status: r.status,
    spotifyId: r.spotify_id,
    spotifyUri: r.spotify_uri,
    score: r.score,
    decidedBy: r.decided_by,
    candidates: JSON.parse(r.candidates) as Candidate[],
    decidedAt: r.decided_at,
    lastSearchAt: r.last_search_at,
    searchCount: r.search_count,
  };
}

const TRACK_COLS =
  "id, kind, external_id, canonical_key, title, artists, album, duration_ms, isrc, netease_id, aliases, file_path, content_hash, file_size, file_mtime, last_seen_at";

export class Repo {
  constructor(readonly db: Database) {}

  // ---- meta -------------------------------------------------------------

  metaGet(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  metaSet(key: string, value: string | null): void {
    if (value === null) this.db.run("DELETE FROM meta WHERE key = ?", [key]);
    else this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  // ---- runs -------------------------------------------------------------

  startRun(now: number): number {
    return this.db.query<{ id: number }, [number]>("INSERT INTO run (started_at) VALUES (?) RETURNING id").get(now)!.id;
  }

  finishRun(id: number, ok: boolean, summary: unknown, now: number): void {
    this.db.run("UPDATE run SET finished_at = ?, ok = ?, summary = ? WHERE id = ?", [now, ok ? 1 : 0, JSON.stringify(summary), id]);
  }

  lastRun(): { id: number; startedAt: number; finishedAt: number | null; ok: boolean | null; summary: unknown } | null {
    const r = this.db
      .query<{ id: number; started_at: number; finished_at: number | null; ok: number | null; summary: string | null }, []>(
        "SELECT id, started_at, finished_at, ok, summary FROM run ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (!r) return null;
    return { id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok === null ? null : r.ok === 1, summary: r.summary ? JSON.parse(r.summary) : null };
  }

  // ---- auth -------------------------------------------------------------

  getAuth<T>(provider: "spotify" | "netease"): T | null {
    const r = this.db.query<{ payload: string }, [string]>("SELECT payload FROM auth WHERE provider = ?").get(provider);
    return r ? (JSON.parse(r.payload) as T) : null;
  }

  setAuth(provider: "spotify" | "netease", payload: unknown, now: number): void {
    this.db.run(
      "INSERT INTO auth (provider, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT (provider) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
      [provider, JSON.stringify(payload), now],
    );
  }

  deleteAuth(provider: "spotify" | "netease"): void {
    this.db.run("DELETE FROM auth WHERE provider = ?", [provider]);
  }

  // ---- sources ----------------------------------------------------------

  /**
   * Persist one source's full pull: upsert playlists/tracks, rewrite playlist membership,
   * drop rows of this kind not seen in this pull, and register pending match rows.
   */
  savePull(kind: SourceKind, pulled: PulledPlaylist[], now: number): void {
    const upsertPlaylist = this.db.query<{ id: number }, [SourceKind, string, string, number | null, number]>(
      `INSERT INTO source_playlist (kind, external_id, name, source_updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (kind, external_id) DO UPDATE SET name = excluded.name, source_updated_at = excluded.source_updated_at, last_seen_at = excluded.last_seen_at
       RETURNING id`,
    );
    const upsertTrack = this.db.query<{ id: number }, (string | number | null)[]>(
      `INSERT INTO source_track (kind, external_id, canonical_key, title, artists, album, duration_ms, isrc, netease_id, aliases,
                                 file_path, content_hash, file_size, file_mtime, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, external_id) DO UPDATE SET
         canonical_key = excluded.canonical_key, title = excluded.title, artists = excluded.artists, album = excluded.album,
         duration_ms = excluded.duration_ms, isrc = excluded.isrc, netease_id = excluded.netease_id, aliases = excluded.aliases,
         file_path = excluded.file_path, content_hash = excluded.content_hash, file_size = excluded.file_size,
         file_mtime = excluded.file_mtime, last_seen_at = excluded.last_seen_at
       RETURNING id`,
    );
    const clearMembers = this.db.query("DELETE FROM playlist_track WHERE source_playlist_id = ?");
    const addMember = this.db.query("INSERT INTO playlist_track (source_playlist_id, source_track_id, position) VALUES (?, ?, ?)");
    const ensureMatch = this.db.query("INSERT OR IGNORE INTO match (canonical_key, status) VALUES (?, 'pending')");

    this.db.transaction(() => {
      for (const { playlist, tracks } of pulled) {
        const pid = upsertPlaylist.get(kind, playlist.externalId, playlist.name, playlist.sourceUpdatedAt ?? null, now)!.id;
        clearMembers.run(pid);
        const seen = new Set<number>();
        let position = 0;
        for (const t of tracks) {
          const key = canonicalKey(t);
          const tid = upsertTrack.get(
            kind, t.externalId, key, t.title, JSON.stringify(t.artists), t.album ?? null, t.durationMs ?? null,
            t.isrc ?? null, t.neteaseId ?? null, JSON.stringify(t.aliases),
            t.file?.path ?? null, t.file?.contentHash ?? null, t.file?.size ?? null, t.file?.mtimeMs ?? null, now, now,
          )!.id;
          if (seen.has(tid)) continue;
          seen.add(tid);
          addMember.run(pid, tid, position++);
          ensureMatch.run(key);
        }
      }
      this.db.run("DELETE FROM source_playlist WHERE kind = ? AND last_seen_at < ?", [kind, now]);
      this.db.run("DELETE FROM source_track WHERE kind = ? AND last_seen_at < ?", [kind, now]);
    })();
  }

  listSourcePlaylists(kind?: SourceKind): SourcePlaylistRow[] {
    const sql = "SELECT id, kind, external_id, name, source_updated_at, last_seen_at FROM source_playlist" + (kind ? " WHERE kind = ?" : "") + " ORDER BY kind, name";
    const rows = kind ? this.db.query<DbPlaylist, [SourceKind]>(sql).all(kind) : this.db.query<DbPlaylist, []>(sql).all();
    return rows.map((r) => ({ id: r.id, kind: r.kind, externalId: r.external_id, name: r.name, sourceUpdatedAt: r.source_updated_at, lastSeenAt: r.last_seen_at }));
  }

  /** Ordered tracks of one source playlist. */
  playlistTracks(sourcePlaylistId: number): SourceTrackRow[] {
    return this.db
      .query<DbSourceTrack, [number]>(
        `SELECT ${TRACK_COLS.replace(/(^|, )/g, "$1t.")} FROM playlist_track pt JOIN source_track t ON t.id = pt.source_track_id
         WHERE pt.source_playlist_id = ? ORDER BY pt.position`,
      )
      .all(sourcePlaylistId)
      .map(toTrackRow);
  }

  sourceTracksByExternalIds(kind: SourceKind, externalIds: string[]): Map<string, SourceTrackRow> {
    const out = new Map<string, SourceTrackRow>();
    const q = this.db.query<DbSourceTrack, [SourceKind, string]>(`SELECT ${TRACK_COLS} FROM source_track WHERE kind = ? AND external_id = ?`);
    for (const id of externalIds) {
      const r = q.get(kind, id);
      if (r) out.set(id, toTrackRow(r));
    }
    return out;
  }

  /** All local tracks keyed by absolute path (for change detection / tag cache). */
  localTracksByPath(): Map<string, SourceTrackRow> {
    const out = new Map<string, SourceTrackRow>();
    for (const r of this.db.query<DbSourceTrack, []>(`SELECT ${TRACK_COLS} FROM source_track WHERE kind = 'local' AND file_path IS NOT NULL`).all()) {
      out.set(r.file_path!, toTrackRow(r));
    }
    return out;
  }

  tracksByCanonicalKey(key: string): SourceTrackRow[] {
    return this.db.query<DbSourceTrack, [string]>(`SELECT ${TRACK_COLS} FROM source_track WHERE canonical_key = ?`).all(key).map(toTrackRow);
  }

  /** Names of source playlists containing any track with this canonical key. */
  playlistNamesForKey(key: string): string[] {
    return this.db
      .query<{ name: string }, [string]>(
        `SELECT DISTINCT p.name FROM source_playlist p JOIN playlist_track pt ON pt.source_playlist_id = p.id
         JOIN source_track t ON t.id = pt.source_track_id WHERE t.canonical_key = ? ORDER BY p.name`,
      )
      .all(key)
      .map((r) => r.name);
  }

  /** One representative source track per canonical key (prefers rows with a local file). */
  representativeTracks(keys: string[]): Map<string, SourceTrackRow> {
    const out = new Map<string, SourceTrackRow>();
    const q = this.db.query<DbSourceTrack, [string]>(
      `SELECT ${TRACK_COLS} FROM source_track WHERE canonical_key = ? ORDER BY (file_path IS NULL), id LIMIT 1`,
    );
    for (const k of keys) {
      const r = q.get(k);
      if (r) out.set(k, toTrackRow(r));
    }
    return out;
  }

  // ---- match ------------------------------------------------------------

  getMatch(key: string): MatchRow | null {
    const r = this.db.query<DbMatch, [string]>("SELECT * FROM match WHERE canonical_key = ?").get(key);
    return r ? toMatchRow(r) : null;
  }

  upsertMatch(m: MatchRow): void {
    this.db.run(
      `INSERT INTO match (canonical_key, status, spotify_id, spotify_uri, score, decided_by, candidates, decided_at, last_search_at, search_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (canonical_key) DO UPDATE SET status = excluded.status, spotify_id = excluded.spotify_id, spotify_uri = excluded.spotify_uri,
         score = excluded.score, decided_by = excluded.decided_by, candidates = excluded.candidates, decided_at = excluded.decided_at,
         last_search_at = excluded.last_search_at, search_count = excluded.search_count`,
      [m.canonicalKey, m.status, m.spotifyId, m.spotifyUri, m.score, m.decidedBy, JSON.stringify(m.candidates), m.decidedAt, m.lastSearchAt, m.searchCount],
    );
  }

  listMatches(status?: MatchStatus): MatchRow[] {
    const sql = "SELECT * FROM match" + (status ? " WHERE status = ?" : "");
    const rows = status ? this.db.query<DbMatch, [MatchStatus]>(sql).all(status) : this.db.query<DbMatch, []>(sql).all();
    return rows.map(toMatchRow);
  }

  /** Match rows for canonical keys that are still referenced by some source track. */
  matchesForKeys(keys: string[]): Map<string, MatchRow> {
    const out = new Map<string, MatchRow>();
    const q = this.db.query<DbMatch, [string]>("SELECT * FROM match WHERE canonical_key = ?");
    for (const k of keys) {
      const r = q.get(k);
      if (r) out.set(k, toMatchRow(r));
    }
    return out;
  }

  /** Keys needing a search: pending, or auto-decided `local` older than the retry window. Only keys still referenced by a source. */
  matchesDue(now: number, retryAfterMs: number): MatchRow[] {
    return this.db
      .query<DbMatch, [number]>(
        `SELECT m.* FROM match m WHERE EXISTS (SELECT 1 FROM source_track t WHERE t.canonical_key = m.canonical_key)
         AND (m.status = 'pending' OR (m.status = 'local' AND m.decided_by = 'auto' AND COALESCE(m.last_search_at, 0) < ?))`,
      )
      .all(now - retryAfterMs)
      .map(toMatchRow);
  }

  countMatches(): Record<MatchStatus, number> {
    const counts: Record<MatchStatus, number> = { pending: 0, matched: 0, review: 0, local: 0, skipped: 0 };
    for (const r of this.db
      .query<{ status: MatchStatus; n: number }, []>(
        "SELECT m.status, COUNT(*) AS n FROM match m WHERE EXISTS (SELECT 1 FROM source_track t WHERE t.canonical_key = m.canonical_key) GROUP BY m.status",
      )
      .all()) {
      counts[r.status] = r.n;
    }
    return counts;
  }

  // ---- spotify playlists ------------------------------------------------

  getSpotifyPlaylist(sourcePlaylistId: number): SpotifyPlaylistRow | null {
    const r = this.db
      .query<{ source_playlist_id: number; spotify_id: string; name: string; snapshot_id: string | null; last_synced_at: number | null }, [number]>(
        "SELECT * FROM spotify_playlist WHERE source_playlist_id = ?",
      )
      .get(sourcePlaylistId);
    return r ? { sourcePlaylistId: r.source_playlist_id, spotifyId: r.spotify_id, name: r.name, snapshotId: r.snapshot_id, lastSyncedAt: r.last_synced_at } : null;
  }

  setSpotifyPlaylist(row: SpotifyPlaylistRow): void {
    this.db.run(
      `INSERT INTO spotify_playlist (source_playlist_id, spotify_id, name, snapshot_id, last_synced_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source_playlist_id) DO UPDATE SET spotify_id = excluded.spotify_id, name = excluded.name, snapshot_id = excluded.snapshot_id, last_synced_at = excluded.last_synced_at`,
      [row.sourcePlaylistId, row.spotifyId, row.name, row.snapshotId, row.lastSyncedAt],
    );
  }

  deleteSpotifyPlaylist(sourcePlaylistId: number): void {
    this.db.run("DELETE FROM spotify_playlist WHERE source_playlist_id = ?", [sourcePlaylistId]);
  }

  // ---- managed items / liked -------------------------------------------

  managedUris(spotifyPlaylistId: string): Set<string> {
    return new Set(this.db.query<{ uri: string }, [string]>("SELECT uri FROM managed_item WHERE spotify_playlist_id = ?").all(spotifyPlaylistId).map((r) => r.uri));
  }

  addManaged(spotifyPlaylistId: string, uris: string[], now: number): void {
    const q = this.db.query("INSERT OR IGNORE INTO managed_item (spotify_playlist_id, uri, added_at) VALUES (?, ?, ?)");
    this.db.transaction(() => {
      for (const u of uris) q.run(spotifyPlaylistId, u, now);
    })();
  }

  removeManaged(spotifyPlaylistId: string, uris: string[]): void {
    const q = this.db.query("DELETE FROM managed_item WHERE spotify_playlist_id = ? AND uri = ?");
    this.db.transaction(() => {
      for (const u of uris) q.run(spotifyPlaylistId, u);
    })();
  }

  likedIds(): Set<string> {
    return new Set(this.db.query<{ spotify_id: string }, []>("SELECT spotify_id FROM liked").all().map((r) => r.spotify_id));
  }

  addLiked(ids: string[], now: number): void {
    const q = this.db.query("INSERT OR IGNORE INTO liked (spotify_id, added_at) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const id of ids) q.run(id, now);
    })();
  }

  removeLiked(ids: string[]): void {
    const q = this.db.query("DELETE FROM liked WHERE spotify_id = ?");
    this.db.transaction(() => {
      for (const id of ids) q.run(id);
    })();
  }

  // ---- local export -----------------------------------------------------

  getExport(key: string): LocalExportRow | null {
    const r = this.db.query<DbExport, [string]>("SELECT * FROM local_export WHERE canonical_key = ?").get(key);
    return r ? toExportRow(r) : null;
  }

  listExports(): LocalExportRow[] {
    return this.db.query<DbExport, []>("SELECT * FROM local_export").all().map(toExportRow);
  }

  setExport(row: LocalExportRow): void {
    this.db.run(
      `INSERT INTO local_export (canonical_key, export_path, local_uri, content_hash, exported_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (canonical_key) DO UPDATE SET export_path = excluded.export_path, local_uri = excluded.local_uri, content_hash = excluded.content_hash, exported_at = excluded.exported_at`,
      [row.canonicalKey, row.exportPath, row.localUri, row.contentHash, row.exportedAt],
    );
  }

  deleteExport(key: string): void {
    this.db.run("DELETE FROM local_export WHERE canonical_key = ?", [key]);
  }

  // ---- caches -----------------------------------------------------------

  cacheGet<T>(key: string, now: number, ttlMs: number): T | null {
    const r = this.db.query<{ response: string; fetched_at: number }, [string]>("SELECT response, fetched_at FROM search_cache WHERE key = ?").get(key);
    if (!r || r.fetched_at < now - ttlMs) return null;
    return JSON.parse(r.response) as T;
  }

  cacheSet(key: string, value: unknown, now: number): void {
    this.db.run(
      "INSERT INTO search_cache (key, response, fetched_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at",
      [key, JSON.stringify(value), now],
    );
  }

  getFingerprint(contentHash: string): FingerprintRow | null {
    const r = this.db
      .query<{ content_hash: string; fp: string; duration_s: number; acoustid: string | null; isrcs: string; fetched_at: number }, [string]>(
        "SELECT * FROM fingerprint WHERE content_hash = ?",
      )
      .get(contentHash);
    return r
      ? { contentHash: r.content_hash, fp: r.fp, durationS: r.duration_s, acoustid: r.acoustid ? JSON.parse(r.acoustid) : null, isrcs: JSON.parse(r.isrcs) as string[], fetchedAt: r.fetched_at }
      : null;
  }

  setFingerprint(row: FingerprintRow): void {
    this.db.run(
      `INSERT INTO fingerprint (content_hash, fp, duration_s, acoustid, isrcs, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_hash) DO UPDATE SET fp = excluded.fp, duration_s = excluded.duration_s, acoustid = excluded.acoustid, isrcs = excluded.isrcs, fetched_at = excluded.fetched_at`,
      [row.contentHash, row.fp, row.durationS, row.acoustid === null ? null : JSON.stringify(row.acoustid), JSON.stringify(row.isrcs), row.fetchedAt],
    );
  }
}

interface DbPlaylist {
  id: number;
  kind: SourceKind;
  external_id: string;
  name: string;
  source_updated_at: number | null;
  last_seen_at: number;
}

interface DbExport {
  canonical_key: string;
  export_path: string;
  local_uri: string;
  content_hash: string;
  exported_at: number;
}

function toExportRow(r: DbExport): LocalExportRow {
  return { canonicalKey: r.canonical_key, exportPath: r.export_path, localUri: r.local_uri, contentHash: r.content_hash, exportedAt: r.exported_at };
}
