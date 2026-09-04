import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import template from "../config.example.toml" with { type: "text" };

const SpotifySchema = z.object({
  client_id: z.string().default(""),
  redirect_port: z.number().int().min(1024).max(65535).default(8765),
  market: z.string().min(2).default("from_token"),
});

const NeteaseSchema = z.object({
  enabled: z.boolean().default(true),
  include_liked: z.boolean().default(true),
  include_playlists: z.array(z.string()).default([]),
  exclude_playlists: z.array(z.string()).default([]),
  like_matched: z.boolean().default(true),
});

const LocalSchema = z.object({
  enabled: z.boolean().default(true),
  dirs: z.array(z.string()).default([]),
  playlist_name: z.string().min(1).default("Local Library"),
  /** false: local files only supply audio for tracks of other playlists (export path); no "Local Library" playlist is mirrored */
  mirror_playlist: z.boolean().default(true),
  extensions: z.array(z.string().min(1)).default(["mp3", "flac", "m4a", "ogg", "wav", "ncm"]),
  filename_pattern: z.enum(["artist-title", "title-artist"]).default("artist-title"),
  like_matched: z.boolean().default(false),
});

const ExportSchema = z.object({
  dir: z.string().default(""),
  ffmpeg: z.string().default("ffmpeg"),
  bitrate: z.string().regex(/^\d+k$/).default("320k"),
});

const MatchingSchema = z
  .object({
    auto_threshold: z.number().min(0).max(1).default(0.9),
    review_threshold: z.number().min(0).max(1).default(0.6),
    duration_tolerance_ms: z.number().int().nonnegative().default(3000),
    retry_unmatched_after_days: z.number().int().positive().default(30),
    search_cache_ttl_days: z.number().int().positive().default(30),
    /** network searches allowed per run (cache hits are free); 0 = unlimited. Spotify dev-mode apps get a daily quota. */
    max_searches_per_run: z.number().int().nonnegative().default(400),
    /** queries tried per track before giving up (isrc / fielded / free text / aliases / bare title) */
    max_queries_per_track: z.number().int().min(1).default(4),
    search_concurrency: z.number().int().min(1).max(8).default(2),
    search_min_interval_ms: z.number().int().nonnegative().default(120),
    fingerprint: z.boolean().default(false),
    fpcalc: z.string().default("fpcalc"),
    acoustid_key: z.string().default(""),
    artist_aliases: z.record(z.string(), z.string()).default({}),
  })
  .refine((m) => m.review_threshold <= m.auto_threshold, {
    message: "matching.review_threshold must be <= matching.auto_threshold",
  });

const SyncSchema = z.object({
  playlist_prefix: z.string().default(""),
});

// `prefault` (zod v4) fills a missing section with `{}` *before* parsing, so inner field defaults apply.
export const ConfigSchema = z.object({
  spotify: SpotifySchema.prefault({}),
  netease: NeteaseSchema.prefault({}),
  local: LocalSchema.prefault({}),
  export: ExportSchema.prefault({}),
  matching: MatchingSchema.prefault({}),
  sync: SyncSchema.prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_TEMPLATE: string = template;

export function stateDir(override?: string): string {
  return expandPath(override ?? process.env.SPOTIFIFY_STATE_DIR ?? join(homedir(), ".spotifify"));
}

export const CONFIG_FILENAME = "config.toml";

export function expandPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return resolve(p);
}

export async function loadConfig(path = join(stateDir(), CONFIG_FILENAME)): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`config not found: ${path} (run \`spotifify init\`)`);
  }
  const raw = parseToml(await file.text());
  const cfg = ConfigSchema.parse(raw);
  cfg.local.dirs = cfg.local.dirs.map(expandPath);
  if (cfg.export.dir) cfg.export.dir = expandPath(cfg.export.dir);
  cfg.local.extensions = cfg.local.extensions.map((e) => e.replace(/^\./, "").toLowerCase());
  return cfg;
}

export interface ConfigUpgrade {
  text: string;
  /** dotted keys that were absent from the user's file and now carry the template default */
  added: string[];
}

/** Merge entries into `[matching.artist_aliases]`, re-rendering the file through the template (comments/order preserved). */
export function withArtistAliases(existing: string, aliases: Record<string, string>): string {
  const current = parseToml(existing) as Record<string, unknown>;
  const matching = (current.matching ??= {}) as Record<string, unknown>;
  const table = (matching.artist_aliases ??= {}) as Record<string, unknown>;
  Object.assign(table, aliases);
  return upgradeConfig(stringifyToml(current)).text;
}

/**
 * Rewrite a config file against the current template: template order and comments, the user's values
 * where present, template defaults for options the file predates. Keys the template does not know are
 * kept at the end of their section; unknown sections are appended verbatim.
 */
export function upgradeConfig(existing: string, tmpl: string = CONFIG_TEMPLATE): ConfigUpgrade {
  const current = parseToml(existing) as Record<string, unknown>;
  const out: string[] = [];
  const added: string[] = [];
  const seenSections = new Set<string>();
  let section: string[] = [];
  let emitted = new Set<string>();

  const table = (path: string[]): Record<string, unknown> | undefined => {
    let node: unknown = current;
    for (const p of path) {
      if (typeof node !== "object" || node === null || !(p in node)) return undefined;
      node = (node as Record<string, unknown>)[p];
    }
    return typeof node === "object" && node !== null && !Array.isArray(node) ? (node as Record<string, unknown>) : undefined;
  };
  const isTable = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
  const flushExtras = () => {
    const t = table(section);
    if (!t) return;
    for (const [k, v] of Object.entries(t)) {
      if (emitted.has(k) || isTable(v)) continue;
      while (out.length > 0 && out[out.length - 1] === "") out.pop();
      out.push(`${tomlKey(k)} = ${tomlValue(v)}`);
    }
    out.push("");
  };

  for (const line of tmpl.split(/\r?\n/)) {
    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) {
      flushExtras();
      section = header[1]!.split(".");
      seenSections.add(header[1]!);
      emitted = new Set();
      out.push(line);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (kv) {
      const key = kv[1]!;
      const t = table(section);
      emitted.add(key);
      if (t && key in t && !isTable(t[key])) {
        out.push(`${key} = ${tomlValue(t[key])}${trailingComment(kv[2]!)}`);
      } else {
        out.push(line);
        added.push([...section, key].join("."));
      }
      continue;
    }
    out.push(line);
  }
  flushExtras();

  // Sections the template does not know at all (e.g. removed or user-invented): keep them.
  const walk = (node: Record<string, unknown>, path: string[]) => {
    for (const [k, v] of Object.entries(node)) {
      if (!isTable(v)) continue;
      const full = [...path, k];
      const name = full.join(".");
      if (!seenSections.has(name)) {
        out.push(`[${name}]`);
        for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) if (!isTable(iv)) out.push(`${tomlKey(ik)} = ${tomlValue(iv)}`);
        out.push("");
      }
      walk(v as Record<string, unknown>, full);
    }
  };
  walk(current, []);

  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n"), added };
}

/** Options present in the template but missing from `existing` (what `init --upgrade` would add). */
export function missingConfigKeys(existing: string, tmpl: string = CONFIG_TEMPLATE): string[] {
  return upgradeConfig(existing, tmpl).added;
}

function tomlValue(v: unknown): string {
  const line = stringifyToml({ v });
  return line.slice(line.indexOf("=") + 1).trim();
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

/** Keep an inline `# comment` that follows the template value. */
function trailingComment(rest: string): string {
  const m = rest.match(/\s+(#.*)$/);
  return m ? `   ${m[1]}` : "";
}
