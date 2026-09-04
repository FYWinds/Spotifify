import type { Config } from "../../config.ts";
import { log } from "../../util/log.ts";
import type { Source, SourceKind, SourcePlaylist, SourceTrack } from "../types.ts";
import { NeteaseAuthError, NeteaseClient, type NeteasePlaylistSummary, type NeteaseSong } from "./client.ts";

/** Read-only view of previously pulled netease state (backed by the repo) used to skip unchanged playlists / known songs. */
export interface NeteaseCache {
  /** `sourceUpdatedAt` stored for the playlist on the last pull, undefined if never pulled */
  playlistUpdatedAt(externalId: string): number | undefined;
  /** tracks in stored position order; empty when unknown */
  playlistTracks(externalId: string): SourceTrack[];
  /** already-known songs keyed by externalId (netease song id as string) */
  knownSongs(externalIds: string[]): Map<string, SourceTrack>;
}

/** netease `specialType` of the user's own "我喜欢的音乐" playlist */
const LIKED_SPECIAL_TYPE = 5;

function toSourceTrack(s: NeteaseSong): SourceTrack {
  return {
    kind: "netease",
    externalId: String(s.id),
    title: s.name,
    artists: s.artists,
    album: s.album || undefined,
    durationMs: s.durationMs || undefined,
    neteaseId: s.id,
    aliases: s.aliases,
  };
}

export class NeteaseSource implements Source {
  readonly kind: SourceKind = "netease";

  constructor(
    private readonly client: NeteaseClient,
    private readonly cfg: Config["netease"],
    private readonly cache: NeteaseCache,
  ) {}

  async pull(): Promise<{ playlists: Array<{ playlist: SourcePlaylist; tracks: SourceTrack[] }> }> {
    const me = await this.client.loginStatus();
    if (!me) throw new NeteaseAuthError();
    log.info("netease logged in", { uid: me.uid, nickname: me.nickname });

    const excluded = new Set(this.cfg.exclude_playlists);
    const included = new Set(this.cfg.include_playlists);
    const selected = (p: NeteasePlaylistSummary) => {
      const liked = p.specialType === LIKED_SPECIAL_TYPE;
      if (liked && !this.cfg.include_liked) return false;
      if (excluded.has(p.name) || excluded.has(String(p.id))) return false;
      if (included.size === 0) return true;
      return included.has(p.name) || included.has(String(p.id)) || (liked && included.has("liked"));
    };
    const summaries = (await this.client.userPlaylists(me.uid)).filter((p) => p.creatorId === me.uid && selected(p));

    const playlists: Array<{ playlist: SourcePlaylist; tracks: SourceTrack[] }> = [];
    for (const summary of summaries) {
      const externalId = String(summary.id);
      const playlist: SourcePlaylist = { kind: "netease", externalId, name: summary.name, sourceUpdatedAt: summary.trackUpdateTime };

      if (this.cache.playlistUpdatedAt(externalId) === summary.trackUpdateTime) {
        const cached = this.cache.playlistTracks(externalId);
        if (cached.length > 0 || summary.trackCount === 0) {
          log.info("netease playlist unchanged", { name: summary.name, tracks: cached.length });
          playlists.push({ playlist, tracks: cached });
          continue;
        }
      }

      const detail = await this.client.playlistTrackIds(summary.id);
      const ids = detail.ids.map(String);
      const known = this.cache.knownSongs(ids);
      const missing = detail.ids.filter((id) => !known.has(String(id)));
      const fetched = new Map<string, SourceTrack>();
      if (missing.length > 0) {
        for (const song of await this.client.songDetails(missing)) fetched.set(String(song.id), toSourceTrack(song));
      }

      const tracks: SourceTrack[] = [];
      for (const id of ids) {
        const t = known.get(id) ?? fetched.get(id);
        if (t) tracks.push(t);
        else log.warn("netease song_detail omitted a track", { playlist: summary.name, id });
      }
      log.info("netease playlist pulled", { name: summary.name, tracks: tracks.length, fetched: fetched.size, cached: known.size });
      playlists.push({ playlist, tracks });
    }
    return { playlists };
  }
}
