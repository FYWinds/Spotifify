import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.ts";
import { Matcher } from "../src/match/matcher.ts";
import type { SpotifyApi } from "../src/spotify/api.ts";
import type { SpotifyTrack } from "../src/spotify/types.ts";
import { openDatabase } from "../src/state/db.ts";
import { Repo, type SourceTrackRow } from "../src/state/repo.ts";

describe("Matcher identity hits", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-matcher-"));
  const repo = new Repo(openDatabase(join(root, "state")));
  // Same title and artist, but 50 s longer: scores 0.8 — under the auto gate, so a text search alone ends in review.
  const candidate: SpotifyTrack = { id: "X", uri: "spotify:track:X", name: "Song", artists: [{ id: "a", name: "Artist" }], album: { id: "al", name: "Album" }, duration_ms: 250_000, is_local: false, is_playable: true };
  const queries: string[] = [];
  const api = { searchTracks: async (q: string) => (queries.push(q), [candidate]) } as unknown as SpotifyApi;
  const track: SourceTrackRow = {
    id: 1,
    kind: "local",
    externalId: "/music/song.mp3",
    canonicalKey: "local:h",
    title: "Song",
    artists: ["Artist"],
    durationMs: 200_000,
    aliases: [],
    file: { path: "/music/song.mp3", contentHash: "h", size: 1, mtimeMs: 1 },
    lastSeenAt: 1,
  };
  const cfg = ConfigSchema.parse({ matching: { fingerprint: true, search_min_interval_ms: 0 } });

  afterAll(() => {
    repo.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a fingerprint ISRC that names a track the text search already pooled still decides the match", async () => {
    const matcher = new Matcher({ api, repo, cfg, market: "US", isrcLookup: async () => ["USABC1234567"] });
    const row = await matcher.matchOne(track, null, Date.now());
    expect(queries.at(-1)).toBe("isrc:USABC1234567");
    expect(row.status).toBe("matched");
    expect(row.decidedBy).toBe("fingerprint");
    expect(row.spotifyId).toBe("X");
  });

  test("without an identity hit the same candidate only reaches review", async () => {
    const matcher = new Matcher({ api, repo, cfg, market: "US", isrcLookup: async () => [] });
    const row = await matcher.matchOne(track, null, Date.now());
    expect(row.status).toBe("review");
  });
});
