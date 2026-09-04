import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import schemaV1 from "./schema.sql" with { type: "text" };

// Append-only. Each entry runs once, in order, inside a transaction; user_version tracks progress.
const MIGRATIONS: readonly string[] = [
  schemaV1,
  // v2: small key/value store (e.g. Spotify rate-limit deadline carried across runs)
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(dir: string): Database {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "state.db"), { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function schemaVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

function migrate(db: Database): void {
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(`state.db schema v${current} is newer than this build (v${SCHEMA_VERSION})`);
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v]!;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}
