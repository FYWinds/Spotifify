-- Spotifify state schema v1. Timestamps are unix epoch milliseconds.

CREATE TABLE IF NOT EXISTS source_playlist (
  id                INTEGER PRIMARY KEY,
  kind              TEXT    NOT NULL CHECK (kind IN ('netease', 'local')),
  external_id       TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  source_updated_at INTEGER,
  last_seen_at      INTEGER NOT NULL,
  UNIQUE (kind, external_id)
);

CREATE TABLE IF NOT EXISTS source_track (
  id            INTEGER PRIMARY KEY,
  kind          TEXT    NOT NULL CHECK (kind IN ('netease', 'local')),
  external_id   TEXT    NOT NULL,          -- netease song id | local relative path key
  canonical_key TEXT    NOT NULL,          -- netease:{id} | isrc:{ISRC} | local:{blake2b256}
  title         TEXT    NOT NULL,
  artists       TEXT    NOT NULL,          -- JSON string[]
  album         TEXT,
  duration_ms   INTEGER,
  isrc          TEXT,
  netease_id    INTEGER,
  aliases       TEXT    NOT NULL DEFAULT '[]', -- JSON string[]
  file_path     TEXT,
  content_hash  TEXT,
  file_size     INTEGER,
  file_mtime    INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE (kind, external_id)
);
CREATE INDEX IF NOT EXISTS source_track_canonical ON source_track (canonical_key);
CREATE INDEX IF NOT EXISTS source_track_hash ON source_track (content_hash);

CREATE TABLE IF NOT EXISTS playlist_track (
  source_playlist_id INTEGER NOT NULL REFERENCES source_playlist (id) ON DELETE CASCADE,
  source_track_id    INTEGER NOT NULL REFERENCES source_track (id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  PRIMARY KEY (source_playlist_id, source_track_id)
);
CREATE INDEX IF NOT EXISTS playlist_track_order ON playlist_track (source_playlist_id, position);

CREATE TABLE IF NOT EXISTS match (
  canonical_key  TEXT    PRIMARY KEY,
  status         TEXT    NOT NULL CHECK (status IN ('pending', 'matched', 'review', 'local', 'skipped')),
  spotify_id     TEXT,
  spotify_uri    TEXT,
  score          REAL,
  decided_by     TEXT    CHECK (decided_by IN ('auto', 'isrc', 'fingerprint', 'user')),
  candidates     TEXT    NOT NULL DEFAULT '[]', -- JSON Candidate[]
  decided_at     INTEGER,
  last_search_at INTEGER,
  search_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS match_status ON match (status);

CREATE TABLE IF NOT EXISTS spotify_playlist (
  source_playlist_id INTEGER PRIMARY KEY REFERENCES source_playlist (id) ON DELETE CASCADE,
  spotify_id         TEXT    NOT NULL UNIQUE,
  name               TEXT    NOT NULL,
  snapshot_id        TEXT,
  last_synced_at     INTEGER
);

-- Items this tool added to a Spotify playlist; anything else in the remote playlist is "foreign".
CREATE TABLE IF NOT EXISTS managed_item (
  spotify_playlist_id TEXT    NOT NULL,
  uri                 TEXT    NOT NULL,
  added_at            INTEGER NOT NULL,
  PRIMARY KEY (spotify_playlist_id, uri)
);

-- Tracks this tool liked. Tracks already liked before we touched them are never recorded, hence never unliked.
CREATE TABLE IF NOT EXISTS liked (
  spotify_id TEXT    PRIMARY KEY,
  added_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_export (
  canonical_key TEXT    PRIMARY KEY,
  export_path   TEXT    NOT NULL,
  local_uri     TEXT    NOT NULL,           -- canonical spotify:local:... (see spotify/localUri.ts)
  content_hash  TEXT    NOT NULL,
  exported_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS search_cache (
  key        TEXT    PRIMARY KEY,            -- sha1(query + market)
  response   TEXT    NOT NULL,               -- JSON
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fingerprint (
  content_hash TEXT    PRIMARY KEY,
  fp           TEXT    NOT NULL,
  duration_s   INTEGER NOT NULL,
  acoustid     TEXT,                         -- JSON
  isrcs        TEXT    NOT NULL DEFAULT '[]',-- JSON string[]
  fetched_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth (
  provider   TEXT    PRIMARY KEY CHECK (provider IN ('spotify', 'netease')),
  payload    TEXT    NOT NULL,               -- JSON
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  id          INTEGER PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  ok          INTEGER,
  summary     TEXT                           -- JSON
);
