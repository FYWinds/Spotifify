import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { SpotifyClient, SpotifyHttpError } from "../src/spotify/client.ts";

describe("SpotifyClient retry policy", () => {
  const hits: string[] = [];
  let server: Server<undefined>;
  const client = new SpotifyClient({
    clientId: "x",
    store: { load: () => ({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3_600_000, scope: "" }), save: () => {} },
  });

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(req.method);
        // reads recover on the third try; writes fail every time
        if (req.method === "GET" && hits.filter((m) => m === "GET").length >= 3) return Response.json({ ok: true });
        return Response.json({ error: { status: 502, message: "Bad gateway" } }, { status: 502 });
      },
    });
    process.env.SPOTIFIFY_SPOTIFY_API = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test("a 5xx on a write is not retried: the request may already have been applied", async () => {
    hits.length = 0;
    await expect(client.request("POST", "/v1/playlists/p/items", { body: { uris: [] } })).rejects.toBeInstanceOf(SpotifyHttpError);
    expect(hits).toEqual(["POST"]);
  });

  test("a 5xx on a read is retried", async () => {
    hits.length = 0;
    await expect(client.request("GET", "/v1/me")).resolves.toEqual({ ok: true });
    expect(hits).toEqual(["GET", "GET", "GET"]);
  });
});
