import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { decryptNcm, readNcmMeta } from "../sources/local/ncm.ts";
import type { Repo } from "../state/repo.ts";
import { log } from "../util/log.ts";
import { RetryableError, sleep, withRetry } from "../util/retry.ts";

const ACOUSTID_MIN_SCORE = 0.7;
const MAX_RECORDINGS = 3;
const MUSICBRAINZ_GAP_MS = 1100;
const USER_AGENT = "Spotifify/0.1 (https://github.com/spotifify)";

const FpcalcOutput = z.object({ duration: z.number(), fingerprint: z.string().min(1) });

const AcoustIdResponse = z.object({
  status: z.string(),
  error: z.object({ message: z.string() }).optional(),
  results: z.array(z.object({ id: z.string(), score: z.number(), recordings: z.array(z.object({ id: z.string() })).optional() })).optional(),
});

const MusicBrainzRecording = z.object({ isrcs: z.array(z.string()).optional() });

/** Set once per process when `fpcalc` cannot be spawned, so every later track skips silently. */
let fpcalcMissing = false;
/** All AcoustID / MusicBrainz traffic is serialized so the 1 req/s MusicBrainz budget holds across concurrent tracks. */
let queue: Promise<unknown> = Promise.resolve();
let lastMusicBrainzAt = 0;

async function fetchJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new RetryableError(`${res.status} from ${new URL(url).host}`, retryAfter > 0 ? retryAfter * 1000 : undefined);
    }
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}: ${(await res.text()).slice(0, 200)}`);
    return schema.parse(await res.json());
  });
}

/** Returns null (and disables fingerprinting for the process) when the binary is not installed. */
async function runFpcalc(fpcalc: string, path: string): Promise<z.infer<typeof FpcalcOutput> | null> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([fpcalc, "-json", path], { stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      fpcalcMissing = true;
      log.warn(`fpcalc not found (${fpcalc}); fingerprint lookups disabled for this run`);
      return null;
    }
    throw e;
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`fpcalc exited ${code}: ${stderr.trim().slice(0, 200)}`);
  return FpcalcOutput.parse(JSON.parse(stdout));
}

/** Chromaprint of a library file. fpcalc decodes with ffmpeg, which cannot open an encrypted .ncm container, so those are decrypted to a temp file first. */
export async function chromaprint(fpcalc: string, path: string, contentHash: string): Promise<z.infer<typeof FpcalcOutput> | null> {
  if (!path.toLowerCase().endsWith(".ncm")) return runFpcalc(fpcalc, path);
  const { format } = await readNcmMeta(path);
  const tmp = join(tmpdir(), `spotifify-fp-${contentHash.slice(0, 16)}.${format.toLowerCase() || "audio"}`);
  try {
    await decryptNcm(path, tmp);
    return await runFpcalc(fpcalc, tmp);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function lookup(path: string, contentHash: string, cfg: Config["matching"], repo: Repo, now: number): Promise<string[]> {
  const fp = await chromaprint(cfg.fpcalc, path, contentHash);
  if (!fp) return [];
  const durationS = Math.round(fp.duration);
  const acoustid = await fetchJson(
    `https://api.acoustid.org/v2/lookup?client=${encodeURIComponent(cfg.acoustid_key)}&meta=recordings&duration=${durationS}&fingerprint=${encodeURIComponent(fp.fingerprint)}`,
    AcoustIdResponse,
  );
  if (acoustid.status !== "ok") throw new Error(`acoustid: ${acoustid.error?.message ?? acoustid.status}`);
  const mbids: string[] = [];
  for (const r of acoustid.results ?? []) {
    if (r.score < ACOUSTID_MIN_SCORE) continue;
    for (const rec of r.recordings ?? []) {
      if (mbids.length >= MAX_RECORDINGS) break;
      if (!mbids.includes(rec.id)) mbids.push(rec.id);
    }
  }
  const isrcs = new Set<string>();
  for (const mbid of mbids) {
    const wait = lastMusicBrainzAt + MUSICBRAINZ_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastMusicBrainzAt = Date.now();
    const rec = await fetchJson(`https://musicbrainz.org/ws/2/recording/${mbid}?inc=isrcs&fmt=json`, MusicBrainzRecording);
    for (const isrc of rec.isrcs ?? []) isrcs.add(isrc.toUpperCase());
  }
  const out = [...isrcs];
  repo.setFingerprint({ contentHash, fp: fp.fingerprint, durationS, acoustid: acoustid.results ?? null, isrcs: out, fetchedAt: now });
  return out;
}

/**
 * ISRCs for a local file via Chromaprint → AcoustID → MusicBrainz, cached by content hash.
 * Returns [] when fingerprinting is disabled, `fpcalc`/key are missing, or any step fails (failures are not cached).
 */
export async function isrcsByFingerprint(path: string, contentHash: string, cfg: Config["matching"], repo: Repo, now: number): Promise<string[]> {
  if (!cfg.fingerprint || !cfg.acoustid_key || fpcalcMissing) return [];
  const cached = repo.getFingerprint(contentHash);
  if (cached) return cached.isrcs;
  const job = queue.then(() => lookup(path, contentHash, cfg, repo, now));
  queue = job.catch(() => {});
  try {
    return await job;
  } catch (e) {
    log.warn(`fingerprint lookup failed for ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
