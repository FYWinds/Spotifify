// Bun text imports: `import s from "./x.sql" with { type: "text" }`
declare module "*.sql" {
  const text: string;
  export default text;
}
declare module "*.toml" {
  const text: string;
  export default text;
}

// NeteaseCloudMusicApi internals used by src/sources/netease/lib.ts (the package ships types only for main.js).
declare namespace NeteaseApi {
  type Request = (uri: string, data: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>;
  type Module = (query: Record<string, unknown>, request: Request) => Promise<unknown>;
}
declare module "NeteaseCloudMusicApi/util/request.js" {
  const request: NeteaseApi.Request;
  export default request;
}
declare module "NeteaseCloudMusicApi/util/index.js" {
  export function cookieToJson(cookie: string): Record<string, string>;
}
declare module "NeteaseCloudMusicApi/module/*.js" {
  const mod: NeteaseApi.Module;
  export default mod;
}
