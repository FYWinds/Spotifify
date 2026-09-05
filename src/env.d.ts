// Bun text imports: `import s from "./x.sql" with { type: "text" }`
declare module "*.sql" {
  const text: string;
  export default text;
}
declare module "*.toml" {
  const text: string;
  export default text;
}

// NeteaseCloudMusicApi internals loaded by src/sources/netease/lib.ts (the package ships types only for main.js).
declare namespace NeteaseApi {
  type Request = (uri: string, data: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>;
  type Module = (query: Record<string, unknown>, request: Request) => Promise<unknown>;
}
