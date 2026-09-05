/**
 * Bundle-safe entry to NeteaseCloudMusicApi. Its `main.js` discovers endpoints with
 * `readdirSync(__dirname/module)` + dynamic `require` at load time, which only works with node_modules on
 * disk and breaks inside a compiled binary. The endpoint modules are plain `(query, request) => …`
 * functions, so load the ones we use explicitly and reproduce main.js's cookie handling here.
 *
 * `util/request.js` reads `<tmpdir>/anonymous_token` synchronously while loading and throws when it is
 * missing (main.js normally creates it). Bun evaluates CommonJS dependencies before any ESM module body
 * runs, so a side-effect `import` cannot create the file first; the modules are pulled in with `require`
 * after the file exists. The string-literal requires are still bundled statically by `bun build`.
 */
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const anonymousTokenPath = join(tmpdir(), "anonymous_token");
if (!existsSync(anonymousTokenPath)) writeFileSync(anonymousTokenPath, "", "utf-8");

const request = require("NeteaseCloudMusicApi/util/request.js") as NeteaseApi.Request;
const { cookieToJson } = require("NeteaseCloudMusicApi/util/index.js") as { cookieToJson: (cookie: string) => Record<string, string> };
const asModule = (m: unknown): NeteaseApi.Module => m as NeteaseApi.Module;

export type NeteaseApiCall = (data?: Record<string, unknown>) => Promise<unknown>;

function wrap(mod: NeteaseApi.Module): NeteaseApiCall {
  return (data = {}) => {
    const cookie = typeof data.cookie === "string" ? cookieToJson(data.cookie) : (data.cookie ?? {});
    return mod({ ...data, cookie }, request);
  };
}

export const login_status = wrap(asModule(require("NeteaseCloudMusicApi/module/login_status.js")));
export const user_playlist = wrap(asModule(require("NeteaseCloudMusicApi/module/user_playlist.js")));
export const playlist_detail = wrap(asModule(require("NeteaseCloudMusicApi/module/playlist_detail.js")));
export const song_detail = wrap(asModule(require("NeteaseCloudMusicApi/module/song_detail.js")));
export const login_qr_key = wrap(asModule(require("NeteaseCloudMusicApi/module/login_qr_key.js")));
export const login_qr_create = wrap(asModule(require("NeteaseCloudMusicApi/module/login_qr_create.js")));
export const login_qr_check = wrap(asModule(require("NeteaseCloudMusicApi/module/login_qr_check.js")));
