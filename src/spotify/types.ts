/** Minimal Web API shapes this tool reads. Field names follow the API verbatim. */

export interface SpotifyArtist {
  id: string | null;
  name: string;
}

export interface SpotifyTrack {
  id: string | null;
  uri: string;
  name: string;
  artists: SpotifyArtist[];
  album: { id: string | null; name: string };
  duration_ms: number;
  is_local: boolean;
  /** present only when the request carried `market` */
  is_playable?: boolean;
  external_ids?: { isrc?: string };
  linked_from?: { id: string; uri: string };
}

/** Entry of `GET /playlists/{id}/items`; the payload lives under `item` (`track` in the retired `/tracks` API). */
export interface SpotifyPlaylistItem {
  added_at: string;
  is_local: boolean;
  item: SpotifyTrack | null;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  snapshot_id: string;
  owner: { id: string };
}

export interface Paging<T> {
  items: T[];
  next: string | null;
  total: number;
}

export interface SpotifyTokens {
  access_token: string;
  refresh_token: string;
  /** unix ms */
  expires_at: number;
  scope: string;
}

export const SCOPES = [
  "playlist-read-private",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-library-read",
  "user-library-modify",
  // `/v1/me.country` and market-restricted search need this; without it search answers 403 "Insufficient client scope".
  "user-read-private",
] as const;

export const MANAGED_DESCRIPTION = "Managed by Spotifify";
