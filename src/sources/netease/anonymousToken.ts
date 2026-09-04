/**
 * NeteaseCloudMusicApi's util/request.js reads <tmp>/anonymous_token synchronously while loading and
 * throws when it is missing; main.js normally creates it. Imported first by lib.ts so it runs before.
 */
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const anonymousTokenPath = join(tmpdir(), "anonymous_token");
if (!existsSync(anonymousTokenPath)) writeFileSync(anonymousTokenPath, "", "utf-8");
