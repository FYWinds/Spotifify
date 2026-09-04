/**
 * Bundle-safe entry to NeteaseCloudMusicApi. Its `main.js` discovers endpoints with
 * `readdirSync(__dirname/module)` + dynamic `require` at load time, which only works with node_modules on
 * disk and breaks inside a compiled binary. The endpoint modules are plain `(query, request) => …`
 * functions, so import the ones we use statically and reproduce main.js's cookie handling here.
 */
import "./anonymousToken.ts";
import loginQrCheck from "NeteaseCloudMusicApi/module/login_qr_check.js";
import loginQrCreate from "NeteaseCloudMusicApi/module/login_qr_create.js";
import loginQrKey from "NeteaseCloudMusicApi/module/login_qr_key.js";
import loginStatus from "NeteaseCloudMusicApi/module/login_status.js";
import playlistDetail from "NeteaseCloudMusicApi/module/playlist_detail.js";
import songDetail from "NeteaseCloudMusicApi/module/song_detail.js";
import userPlaylist from "NeteaseCloudMusicApi/module/user_playlist.js";
import { cookieToJson } from "NeteaseCloudMusicApi/util/index.js";
import request from "NeteaseCloudMusicApi/util/request.js";

export type NeteaseApiCall = (data?: Record<string, unknown>) => Promise<unknown>;

function wrap(mod: NeteaseApi.Module): NeteaseApiCall {
  return (data = {}) => {
    const cookie = typeof data.cookie === "string" ? cookieToJson(data.cookie) : (data.cookie ?? {});
    return mod({ ...data, cookie }, request);
  };
}

export const login_status = wrap(loginStatus);
export const user_playlist = wrap(userPlaylist);
export const playlist_detail = wrap(playlistDetail);
export const song_detail = wrap(songDetail);
export const login_qr_key = wrap(loginQrKey);
export const login_qr_create = wrap(loginQrCreate);
export const login_qr_check = wrap(loginQrCheck);
