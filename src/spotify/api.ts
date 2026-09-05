import { chunk } from "../util/retry.ts";
import { SpotifyHttpError, type SpotifyClient } from "./client.ts";
import type { SpotifyPlaylist, SpotifyPlaylistItem, SpotifyTrack } from "./types.ts";

// Spotify moved playlist entries to `/playlists/{id}/items` (entry field `item`) and the library to
// `/me/library?uris=`; the legacy `/tracks` and `/me/tracks/contains` paths answer 403 for newer apps.
const ITEM_FIELDS = "next,total,items(added_at,is_local,item(id,uri,name,is_local,duration_ms,artists(id,name),album(id,name)))";

/** Playlist item batch limit for add/remove/replace. */
const ITEMS_BATCH = 100;
/** `/me/library` batch limit (probed: 41+ uris → 400 "Too many uris requested"). */
const LIBRARY_BATCH = 40;

/** Typed façade over the ~15 endpoints this tool needs. Every write returns the resulting snapshot_id. */
export class SpotifyApi {
  constructor(readonly client: SpotifyClient) {}

  async me(): Promise<{ id: string; country: string }> {
    const { id, country } = await this.client.request<{ id: string; country?: string }>("GET", "/v1/me");
    if (!country) throw new Error("Spotify profile has no country: the token lacks user-read-private; run `spotifify auth spotify`");
    return { id, country };
  }

  /** Concrete ISO market for search: config value, or the account country when configured as "from_token". */
  async resolveMarket(configured: string): Promise<string> {
    return configured === "from_token" ? (await this.me()).country : configured;
  }

  async searchTracks(q: string, market: string, limit = 10): Promise<SpotifyTrack[]> {
    const res = await this.client.request<{ tracks: { items: SpotifyTrack[] } }>("GET", "/v1/search", {
      query: { q, type: "track", market, limit },
    });
    return res.tracks.items;
  }

  /** null on 404 (deleted / never existed). */
  async getTrack(id: string, market: string): Promise<SpotifyTrack | null> {
    try {
      return await this.client.request<SpotifyTrack>("GET", `/v1/tracks/${id}`, { query: { market } });
    } catch (e) {
      if (e instanceof SpotifyHttpError && e.status === 404) return null;
      throw e;
    }
  }

  listMyPlaylists(): Promise<SpotifyPlaylist[]> {
    return this.client.paginate<SpotifyPlaylist>("/v1/me/playlists", { limit: 50 });
  }

  /** null on 404 (deleted playlist). */
  async getPlaylist(id: string): Promise<SpotifyPlaylist | null> {
    try {
      return await this.client.request<SpotifyPlaylist>("GET", `/v1/playlists/${id}`);
    } catch (e) {
      if (e instanceof SpotifyHttpError && e.status === 404) return null;
      throw e;
    }
  }

  /** Always private. Uses `/me/playlists`: the legacy `/users/{id}/playlists` path answers 403 for development-mode apps. */
  createPlaylist(name: string, description: string): Promise<SpotifyPlaylist> {
    return this.client.request<SpotifyPlaylist>("POST", "/v1/me/playlists", { body: { name, public: false, description } });
  }

  async renamePlaylist(id: string, name: string): Promise<void> {
    await this.client.request<void>("PUT", `/v1/playlists/${id}`, { body: { name } });
  }

  getPlaylistItems(id: string): Promise<SpotifyPlaylistItem[]> {
    return this.client.paginate<SpotifyPlaylistItem>(`/v1/playlists/${id}/items`, { limit: 50, fields: ITEM_FIELDS });
  }

  /** Current snapshot id only (used to bracket an items listing). */
  async getPlaylistSnapshot(id: string): Promise<string> {
    const res = await this.client.request<{ snapshot_id: string }>("GET", `/v1/playlists/${id}`, { query: { fields: "snapshot_id" } });
    return res.snapshot_id;
  }

  /** ≤100 per request; `position` advances by batch size so the whole run lands contiguously. Returns the last snapshot_id. */
  async addPlaylistItems(id: string, uris: string[], position?: number): Promise<string> {
    let snapshot = "";
    let at = position;
    for (const batch of chunk(uris, ITEMS_BATCH)) {
      const res = await this.client.request<{ snapshot_id: string }>("POST", `/v1/playlists/${id}/items`, {
        body: at === undefined ? { uris: batch } : { uris: batch, position: at },
      });
      snapshot = res.snapshot_id;
      if (at !== undefined) at += batch.length;
    }
    return snapshot;
  }

  /**
   * ≤100 per request. Catalog tracks are removed by URI; local files must be removed by position only
   * (`/items` answers 400 "Invalid base62 id" for a `spotify:local:` URI). Positions are removed highest
   * first with chained snapshot ids, so earlier indexes never shift underneath later batches.
   */
  async removePlaylistItems(id: string, items: Array<{ uri: string; positions?: number[] }>, snapshotId: string): Promise<string> {
    let snapshot = snapshotId;
    const positions = items.flatMap((x) => x.positions ?? []).sort((a, b) => b - a);
    const uris = items.filter((x) => x.positions === undefined).map((x) => ({ uri: x.uri }));
    for (const batch of chunk(positions, ITEMS_BATCH)) {
      const res = await this.client.request<{ snapshot_id: string }>("DELETE", `/v1/playlists/${id}/items`, {
        body: { positions: batch, snapshot_id: snapshot },
      });
      snapshot = res.snapshot_id;
    }
    for (const batch of chunk(uris, ITEMS_BATCH)) {
      const res = await this.client.request<{ snapshot_id: string }>("DELETE", `/v1/playlists/${id}/items`, {
        body: { items: batch, snapshot_id: snapshot },
      });
      snapshot = res.snapshot_id;
    }
    return snapshot;
  }

  async reorderPlaylistItems(id: string, rangeStart: number, insertBefore: number, snapshotId: string, rangeLength = 1): Promise<string> {
    const res = await this.client.request<{ snapshot_id: string }>("PUT", `/v1/playlists/${id}/items`, {
      body: { range_start: rangeStart, insert_before: insertBefore, range_length: rangeLength, snapshot_id: snapshotId },
    });
    return res.snapshot_id;
  }

  /** PUT the first ≤100 (which also clears the playlist), then append the rest. */
  async replacePlaylistItems(id: string, uris: string[]): Promise<string> {
    const res = await this.client.request<{ snapshot_id: string }>("PUT", `/v1/playlists/${id}/items`, {
      body: { uris: uris.slice(0, ITEMS_BATCH) },
    });
    const rest = uris.slice(ITEMS_BATCH);
    return rest.length === 0 ? res.snapshot_id : this.addPlaylistItems(id, rest);
  }

  /** ≤50 per request; result aligns with `ids` order. */
  async checkSaved(ids: string[]): Promise<boolean[]> {
    const out: boolean[] = [];
    for (const batch of chunk(ids, LIBRARY_BATCH)) {
      out.push(...(await this.client.request<boolean[]>("GET", "/v1/me/library/contains", { query: { uris: batch.map(trackUri).join(",") } })));
    }
    return out;
  }

  /** Every saved track id, paginated 50 at a time. Fallback for accounts where `contains` is unavailable. */
  async listSavedTrackIds(): Promise<Set<string>> {
    const items = await this.client.paginate<{ track: { id: string | null } | null }>("/v1/me/tracks", { limit: LIBRARY_BATCH });
    const ids = new Set<string>();
    for (const it of items) if (it.track?.id) ids.add(it.track.id);
    return ids;
  }

  async saveTracks(ids: string[]): Promise<void> {
    for (const batch of chunk(ids, LIBRARY_BATCH)) await this.client.request<void>("PUT", "/v1/me/library", { query: { uris: batch.map(trackUri).join(",") } });
  }

  async removeSavedTracks(ids: string[]): Promise<void> {
    for (const batch of chunk(ids, LIBRARY_BATCH)) await this.client.request<void>("DELETE", "/v1/me/library", { query: { uris: batch.map(trackUri).join(",") } });
  }
}

function trackUri(id: string): string {
  return id.startsWith("spotify:") ? id : `spotify:track:${id}`;
}
