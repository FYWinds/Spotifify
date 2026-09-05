#!/usr/bin/env bun
import { existsSync, mkdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import qrcode from "qrcode-terminal";
import { CONFIG_FILENAME, CONFIG_TEMPLATE, loadConfig, missingConfigKeys, stateDir, upgradeConfig, withArtistAliases, type Config } from "./config.ts";
import { inferArtistAliases } from "./match/aliases.ts";
import { Matcher } from "./match/matcher.ts";
import type { MatchStatus } from "./match/types.ts";
import { loginByQr, normalizeCookie } from "./sources/netease/auth.ts";
import { NeteaseAuthError, NeteaseClient } from "./sources/netease/client.ts";
import { SpotifyApi } from "./spotify/api.ts";
import { AuthExpiredError, loginPkce, type TokenStore } from "./spotify/auth.ts";
import { SpotifyClient } from "./spotify/client.ts";
import { compareExports, findLocalFilesIndexes, parseLocalFilesIndex } from "./spotify/localIndex.ts";
import { SCOPES, type SpotifyTokens } from "./spotify/types.ts";
import { openDatabase, schemaVersion } from "./state/db.ts";
import { Repo } from "./state/repo.ts";
import { applyExports } from "./sync/apply.ts";
import { formatPlan, planExportsOnly, runSync, selectedKeys, type AwaitingEntry, type SyncSummary } from "./sync/run.ts";
import { runReviewTui } from "./tui/index.ts";
import { probeBinary } from "./util/bin.ts";
import { copyToClipboard } from "./util/clipboard.ts";
import { acquireLock } from "./util/lock.ts";
import { configureLog, log } from "./util/log.ts";

const EXIT_ERROR = 1;
const EXIT_AUTH = 3;

interface GlobalOpts {
  config?: string;
  stateDir?: string;
  logFile?: string;
  verbose?: boolean;
}

interface Ctx {
  dir: string;
  cfg: Config;
  repo: Repo;
}

const program = new Command()
  .name("spotifify")
  .description("Sync Netease Cloud Music playlists and a local library to Spotify")
  .version("0.1.3") // x-release-please-version
  .option("--config <path>", "config file (default: <state-dir>/config.toml)")
  .option("--state-dir <dir>", "state directory (default: ~/.spotifify or $SPOTIFIFY_STATE_DIR)")
  .option("--log-file <path>", "append log lines to this file")
  .option("--verbose", "debug logging")
  .hook("preAction", () => {
    const o = program.opts<GlobalOpts>();
    configureLog({ level: o.verbose ? "debug" : "info", file: o.logFile });
  });

function paths(): { dir: string; configPath: string } {
  const opts = program.opts<GlobalOpts>();
  const dir = stateDir(opts.stateDir);
  return { dir, configPath: opts.config ?? join(dir, CONFIG_FILENAME) };
}

async function ctx(): Promise<Ctx> {
  const { dir, configPath } = paths();
  const cfg = await loadConfig(configPath);
  return { dir, cfg, repo: new Repo(openDatabase(dir)) };
}

function tokenStore(repo: Repo): TokenStore {
  return {
    load: () => repo.getAuth<SpotifyTokens>("spotify"),
    save: (t) => repo.setAuth("spotify", t, Date.now()),
  };
}

function spotifyApi(c: Ctx): SpotifyApi {
  if (!c.cfg.spotify.client_id) throw new Error("spotify.client_id is empty in config");
  const tokens = c.repo.getAuth<SpotifyTokens>("spotify");
  if (tokens) {
    const granted = new Set(tokens.scope.split(/\s+/));
    const missing = SCOPES.filter((s) => !granted.has(s));
    if (missing.length > 0) throw new AuthExpiredError(`Spotify token lacks scope(s) ${missing.join(", ")}; run \`spotifify auth spotify\` again`);
  }
  return new SpotifyApi(new SpotifyClient({ clientId: c.cfg.spotify.client_id, store: tokenStore(c.repo) }));
}

function fail(e: unknown): never {
  if (e instanceof AuthExpiredError || e instanceof NeteaseAuthError) {
    log.error(e.message);
    process.exit(EXIT_AUTH);
  }
  log.error(e instanceof Error ? (program.opts<GlobalOpts>().verbose ? (e.stack ?? e.message) : e.message) : String(e));
  process.exit(EXIT_ERROR);
}

/**
 * Compare `local_export` with the desktop client's own local-files index. Every grey "can't play"
 * row traces back to one of: the client never indexed the file, or it indexed it with another
 * identity (a different duration); both are visible here without touching the network.
 */
async function checkClientIndex(repo: Repo, report: (ok: boolean, label: string, detail: string) => void): Promise<void> {
  const exports = repo.listExports();
  if (exports.length === 0) return;
  const indexes = findLocalFilesIndexes();
  if (indexes.length === 0) {
    report(true, "client index", "desktop client index not found; skipped");
    return;
  }
  for (const file of indexes) {
    const written = statSync(file).mtime.toLocaleString();
    const entries = parseLocalFilesIndex(await readFile(file));
    const user = basename(dirname(file)).replace(/-user$/, "");
    if (entries.length === 0) {
      report(false, "client index", `empty for user ${user} (written ${written}); restart the desktop client or toggle the folder under Settings → Local Files`);
      continue;
    }
    const c = compareExports(entries, exports);
    const examples = (xs: string[]) => xs.slice(0, 3).join(", ") + (xs.length > 3 ? ", …" : "");
    if (c.mismatched.length > 0) {
      report(false, "client index", `${c.mismatched.length} export(s) indexed with another duration: ${examples(c.mismatched.map((m) => `${m.file} (client ${m.client}s, ours ${m.ours}s)`))}`);
    }
    if (c.missing.length > 0) {
      report(false, "client index", `${c.missing.length} export(s) not indexed by the desktop client (user ${user}, written ${written}): ${examples(c.missing)}; restart the client or toggle the folder`);
    }
    if (c.mismatched.length === 0 && c.missing.length === 0) report(true, "client index", `${c.matched} export(s) indexed with matching identity (user ${user}, written ${written})`);
  }
}
// ---- init / doctor ----------------------------------------------------------

program
  .command("init")
  .description("write a config template; --upgrade adds options introduced since the file was written")
  .option("--force", "overwrite an existing config with the template")
  .option("--upgrade", "merge new template options into the existing config (values kept, backup written)")
  .action(async (opts: { force?: boolean; upgrade?: boolean }) => {
    const { dir, configPath } = paths();
    mkdirSync(dir, { recursive: true });
    const exists = existsSync(configPath);
    if (exists && opts.upgrade) {
      const existing = await Bun.file(configPath).text();
      const { text, added } = upgradeConfig(existing);
      if (added.length === 0) {
        console.log("config already has every option; nothing to do");
        return;
      }
      await Bun.write(`${configPath}.bak`, existing);
      await Bun.write(configPath, text);
      console.log(`added ${added.length} option(s) with defaults (backup: ${configPath}.bak):`);
      for (const k of added) console.log(`  ${k}`);
      return;
    }
    if (exists && !opts.force) {
      console.log(`config already exists: ${configPath} (--upgrade to add new options, --force to overwrite)`);
      return;
    }
    await Bun.write(configPath, CONFIG_TEMPLATE);
    console.log(`wrote ${configPath}`);
    console.log("next: fill spotify.client_id, local.dirs, export.dir; then `spotifify doctor`");
  });

program
  .command("doctor")
  .description("check config, state db, external binaries, and auth state")
  .action(async () => {
    const { dir, configPath } = paths();
    let failures = 0;
    const report = (ok: boolean, label: string, detail: string) => {
      if (!ok) failures++;
      console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(18)} ${detail}`);
    };

    let cfg: Config;
    try {
      cfg = await loadConfig(configPath);
      report(true, "config", configPath);
      const missing = missingConfigKeys(await Bun.file(configPath).text());
      report(true, "config options", missing.length === 0 ? "up to date" : `${missing.length} new option(s) using defaults (${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""}); run \`spotifify init --upgrade\``);
    } catch (e) {
      report(false, "config", e instanceof Error ? e.message : String(e));
      process.exit(EXIT_ERROR);
    }

    report(cfg.spotify.client_id.length > 0, "spotify.client_id", cfg.spotify.client_id ? "set" : "empty");

    for (const d of cfg.local.dirs) {
      const isDir = existsSync(d) && statSync(d).isDirectory();
      report(isDir || !cfg.local.enabled, "local.dirs", isDir ? d : `missing: ${d}`);
    }
    if (cfg.local.enabled && cfg.local.dirs.length === 0) report(false, "local.dirs", "empty while local.enabled = true");

    const exportOk = cfg.export.dir.length > 0 && existsSync(cfg.export.dir) && statSync(cfg.export.dir).isDirectory();
    report(exportOk, "export.dir", exportOk ? cfg.export.dir : `missing: ${cfg.export.dir || "(unset)"}`);

    const ffmpeg = await probeBinary(cfg.export.ffmpeg, ["-version"]);
    report(ffmpeg !== null, "ffmpeg", ffmpeg ?? `not found: ${cfg.export.ffmpeg}`);

    if (cfg.matching.fingerprint) {
      const fpcalc = await probeBinary(cfg.matching.fpcalc, ["-version"]);
      report(fpcalc !== null, "fpcalc", fpcalc ?? `not found: ${cfg.matching.fpcalc}`);
      report(cfg.matching.acoustid_key.length > 0, "acoustid_key", cfg.matching.acoustid_key ? "set" : "empty");
    } else {
      report(true, "fingerprint", "disabled");
    }

    try {
      const db = openDatabase(dir);
      report(true, "state.db", `${join(dir, "state.db")} (schema v${schemaVersion(db)})`);
      const repo = new Repo(db);
      const spotify = repo.getAuth<SpotifyTokens>("spotify");
      report(spotify !== null, "auth spotify", spotify ? `present (refresh ok until re-auth needed)` : "run `spotifify auth spotify`");
      const netease = repo.getAuth<{ cookie: string }>("netease");
      if (cfg.netease.enabled) {
        if (netease) {
          const status = await new NeteaseClient(netease.cookie).loginStatus().catch(() => null);
          report(status !== null, "auth netease", status ? `logged in as ${status.nickname} (${status.uid})` : "cookie invalid: run `spotifify auth netease`");
        } else {
          report(false, "auth netease", "run `spotifify auth netease`");
        }
      } else {
        report(true, "auth netease", "disabled");
      }
      await checkClientIndex(repo, report);
      db.close();
    } catch (e) {
      report(false, "state.db", e instanceof Error ? e.message : String(e));
    }

    console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : EXIT_ERROR);
  });

// ---- auth -------------------------------------------------------------------

const auth = program.command("auth").description("log in to a provider");

auth
  .command("spotify")
  .description("Authorization Code + PKCE login via the browser")
  .action(async () => {
    try {
      const c = await ctx();
      if (!c.cfg.spotify.client_id) throw new Error("spotify.client_id is empty in config");
      await loginPkce({ clientId: c.cfg.spotify.client_id, port: c.cfg.spotify.redirect_port, store: tokenStore(c.repo) });
      const me = await spotifyApi(c).me();
      console.log(`logged in to Spotify as ${me.id} (${me.country})`);
    } catch (e) {
      fail(e);
    }
  });

auth
  .command("netease")
  .description("QR login (default) or paste a cookie with --cookie")
  .option("--cookie <cookie>", "MUSIC_U=... or a full Cookie header")
  .action(async (opts: { cookie?: string }) => {
    try {
      const c = await ctx();
      const cookie = opts.cookie
        ? normalizeCookie(opts.cookie)
        : await loginByQr((url) => {
            console.log("scan with the NetEase Cloud Music app:\n");
            qrcode.generate(url, { small: true });
            console.log(`\n(${url})`);
          });
      const status = await new NeteaseClient(cookie).loginStatus();
      if (!status) throw new NeteaseAuthError("cookie rejected by netease");
      c.repo.setAuth("netease", { cookie }, Date.now());
      console.log(`logged in to NetEase as ${status.nickname} (${status.uid})`);
    } catch (e) {
      fail(e);
    }
  });

// ---- sync -------------------------------------------------------------------

program
  .command("sync")
  .description("pull sources, match, and apply the diff to Spotify")
  .option("--dry-run", "print the plan without applying")
  .option("--prune", "remove tool-added items that left the source, superseded local entries, and exported files no longer needed (default: report only)")
  .option("--source <kind>", "only this source: netease | local", (v: string) => {
    if (v !== "netease" && v !== "local") throw new InvalidArgumentError("expected netease or local");
    return v;
  })
  .option("--playlist <name>", "only source playlists with this exact name")
  .option("--skip-match", "do not search Spotify for pending tracks")
  .action(async (opts: { dryRun?: boolean; prune?: boolean; source?: "netease" | "local"; playlist?: string; skipMatch?: boolean }) => {
    let release: (() => void) | null = null;
    const onInterrupt = () => {
      // Match decisions are persisted per track, so aborting loses at most the in-flight searches.
      release?.();
      console.error("\ninterrupted; progress so far is saved - rerun `spotifify sync` to continue");
      process.exit(130);
    };
    process.once("SIGINT", onInterrupt);
    try {
      const c = await ctx();
      const api = spotifyApi(c);
      release = acquireLock(join(c.dir, "sync.lock"));
      const { summary, plan } = await runSync(
        { cfg: c.cfg, repo: c.repo, api },
        { dryRun: opts.dryRun ?? false, prune: opts.prune ?? false, source: opts.source, playlist: opts.playlist, skipMatch: opts.skipMatch ?? false },
      );
      if (opts.dryRun) {
        console.log("\n== plan (dry run) ==");
        console.log(formatPlan(plan, opts.prune ?? false));
      }
      printSummary(summary);
    } catch (e) {
      release?.(); // fail() exits the process, so `finally` would never run
      fail(e);
    } finally {
      process.off("SIGINT", onInterrupt);
      release?.();
    }
  });

function printSummary(s: SyncSummary): void {
  console.log("\n== summary ==");
  console.log(`pulled: netease ${s.pulled.netease.playlists} playlists / ${s.pulled.netease.tracks} tracks; local ${s.pulled.local.tracks} tracks`);
  console.log(`matched: searched ${s.matched.searched} → matched ${s.matched.matched}, review ${s.matched.review}, local ${s.matched.local}${s.matched.remaining ? `; ${s.matched.remaining} still pending` : ""}`);
  if (s.matched.blockedUntil !== null) {
    console.log(`  Spotify search is rate-limited until ${new Date(s.matched.blockedUntil).toLocaleString()}; rerun after that (matching resumes where it stopped)`);
  } else if (s.matched.budgetExhausted) {
    console.log(`  search budget for this run used up (matching.max_searches_per_run); rerun later or raise the budget`);
  }
  console.log(`plan: create ${s.plan.creates}, add ${s.plan.adds}, move ${s.plan.moves}, prune ${s.plan.prune}, like ${s.plan.likes}, unlike ${s.plan.unlikes}, export ${s.plan.exports}, remove export ${s.plan.exportGc}`);
  if (s.apply) {
    console.log(
      `applied: created ${s.apply.created}, added ${s.apply.added}, moved ${s.apply.moved}, replaced ${s.apply.replaced}, pruned ${s.apply.pruned}, liked ${s.apply.liked}, unliked ${s.apply.unliked}, exported ${s.apply.exported}${s.apply.exportErrors ? ` (${s.apply.exportErrors} export errors)` : ""}, removed exports ${s.apply.exportsRemoved}`,
    );
  }
  console.log(`match state: ${Object.entries(s.matchCounts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (s.plan.reviewPending > 0) console.log(`\n${s.plan.reviewPending} track(s) need review: run \`spotifify review\``);
  printAwaiting(s.awaiting);
}

function printAwaiting(entries: AwaitingEntry[]): void {
  const total = entries.reduce((n, e) => n + e.uris.length, 0);
  if (total === 0) return;
  console.log(`\n${total} local file(s) await pasting into the desktop client (run \`spotifify pending --copy\`):`);
  for (const e of entries) console.log(`  ${e.playlist}: ${e.uris.length}`);
}

// ---- review / status / pending / rematch / export ---------------------------

program
  .command("review")
  .description("interactive TUI to resolve review-queue and unmatched tracks")
  .action(async () => {
    try {
      const c = await ctx();
      const api = spotifyApi(c);
      const market = await api.resolveMarket(c.cfg.spotify.market);
      const matcher = new Matcher({ api, repo: c.repo, cfg: c.cfg, market });
      const { decided } = await runReviewTui({ repo: c.repo, matcher, market });
      console.log(`${decided} decision(s) saved; run \`spotifify sync\` to apply`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("status")
  .description("match counts, playlist mappings, last run")
  .action(async () => {
    try {
      const c = await ctx();
      const counts = c.repo.countMatches();
      console.log(`match state: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      console.log("\nplaylists:");
      for (const p of c.repo.listSourcePlaylists()) {
        const m = c.repo.getSpotifyPlaylist(p.id);
        const n = c.repo.playlistTracks(p.id).length;
        console.log(`  [${p.kind}] ${p.name} (${n}) → ${m ? `${m.name} <${m.spotifyId}>` : "(not created yet)"}`);
      }
      const last = c.repo.lastRun();
      if (last) {
        console.log(`\nlast run: ${new Date(last.startedAt).toISOString()} ${last.ok === null ? "(running/aborted)" : last.ok ? "ok" : "FAILED"}`);
        if (last.ok && last.summary) printAwaiting((last.summary as SyncSummary).awaiting ?? []);
        if (last.ok === false && last.summary) console.log(`  ${JSON.stringify(last.summary)}`);
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("unmatched")
  .description("list tracks with no Spotify match (status local/review) in mirrored playlists, with the file that would back them")
  .option("--status <s>", "local | review | all", "local")
  .option("--tsv", "tab-separated output for spreadsheets")
  .action(async (opts: { status: string; tsv?: boolean }) => {
    try {
      const c = await ctx();
      const statuses: MatchStatus[] = opts.status === "all" ? ["local", "review"] : opts.status === "review" ? ["review"] : ["local"];
      const keys = selectedKeys(c.repo, c.cfg, {});
      const rows = statuses.flatMap((s) => c.repo.listMatches(s)).filter((m) => keys.has(m.canonicalKey));
      const tracks = c.repo.representativeTracks(rows.map((m) => m.canonicalKey));
      const exports = new Map(c.repo.listExports().map((e) => [e.canonicalKey, e] as const));
      if (opts.tsv) console.log(["status", "key", "title", "artists", "album", "playlists", "file", "exported"].join("\t"));
      let withFile = 0;
      for (const m of rows) {
        const t = tracks.get(m.canonicalKey);
        if (!t) continue;
        if (t.file) withFile++;
        const playlists = c.repo.playlistNamesForKey(m.canonicalKey).join(", ");
        const file = t.file?.path ?? "";
        const exported = exports.get(m.canonicalKey)?.exportPath ?? "";
        if (opts.tsv) console.log([m.status, m.canonicalKey, t.title, t.artists.join("/"), t.album ?? "", playlists, file, exported].join("\t"));
        else {
          const link = t.neteaseId !== undefined ? `https://music.163.com/#/song?id=${t.neteaseId}` : "";
          console.log(`[${m.status}] ${t.artists.join(", ")} - ${t.title}${t.album ? ` (${t.album})` : ""}  ${link}`);
          console.log(`         in: ${playlists}${file ? `\n         file: ${file}` : ""}${exported ? `\n         exported: ${exported}` : ""}`);
        }
      }
      if (!opts.tsv) {
        console.log(`\n${rows.length} track(s); ${withFile} backed by a local file, ${rows.length - withFile} need one (download them into local.dirs, then sync)`);
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("aliases")
  .description("suggest matching.artist_aliases from confirmed matches (user / ISRC / fingerprint); --apply writes them to the config")
  .option("--apply", "merge the suggestions into the config (backup written)")
  .option("--min <n>", "only pairs seen at least n times", (v: string) => Number.parseInt(v, 10), 1)
  .action(async (opts: { apply?: boolean; min: number }) => {
    try {
      const c = await ctx();
      const suggestions = inferArtistAliases(c.repo, c.cfg.matching).filter((s) => s.count >= opts.min);
      if (suggestions.length === 0) {
        console.log("no new alias pairs found (need confirmed matches whose artist names differ from Spotify's)");
        return;
      }
      for (const s of suggestions) {
        console.log(`"${s.from}" = "${s.to}"   # ${s.count}×${s.conflicts.length ? `, also seen as: ${s.conflicts.join(" / ")}` : ""}`);
        for (const e of s.examples) console.log(`    ${e}`);
      }
      if (!opts.apply) {
        console.log(`\n${suggestions.length} suggestion(s); rerun with --apply to add them to [matching.artist_aliases]`);
        return;
      }
      const { configPath } = paths();
      const existing = await Bun.file(configPath).text();
      await Bun.write(`${configPath}.bak`, existing);
      await Bun.write(configPath, withArtistAliases(existing, Object.fromEntries(suggestions.map((s) => [s.from, s.to]))));
      console.log(`\nwrote ${suggestions.length} alias(es) to ${configPath} (backup: ${configPath}.bak)`);
      console.log("next: `spotifify rematch --all-local` then `spotifify sync` — cached search results are re-scored without new requests");
    } catch (e) {
      fail(e);
    }
  });

program
  .command("pending")
  .description("list local-file URIs that must be pasted into the desktop client (from the last sync)")
  .option("--copy", "copy the URIs to the clipboard")
  .option("--playlist <name>", "only this Spotify playlist")
  .action(async (opts: { copy?: boolean; playlist?: string }) => {
    try {
      const c = await ctx();
      const last = c.repo.lastRun();
      const entries = (last?.ok && last.summary ? ((last.summary as SyncSummary).awaiting ?? []) : []).filter(
        (e) => opts.playlist === undefined || e.playlist === opts.playlist,
      );
      if (entries.length === 0) {
        console.log("nothing pending" + (last ? "" : " (no successful sync yet)"));
        return;
      }
      for (const e of entries) {
        console.log(`# ${e.playlist}`);
        for (const u of e.uris) console.log(u);
      }
      if (opts.copy) {
        const text = entries.flatMap((e) => e.uris).join("\n");
        const ok = await copyToClipboard(text);
        console.log(ok ? `\ncopied ${entries.reduce((n, e) => n + e.uris.length, 0)} URI(s); open the playlist in Spotify desktop and paste` : "\nclipboard unavailable");
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("rematch")
  .description("reset match decisions so the next sync searches again")
  .argument("[key...]", "canonical keys (netease:123, isrc:XXX, local:hash)")
  .option("--all-local", "reset every auto-decided unmatched track")
  .action(async (keys: string[], opts: { allLocal?: boolean }) => {
    try {
      const c = await ctx();
      const targets = opts.allLocal ? c.repo.listMatches("local").filter((m) => m.decidedBy === "auto") : keys.map((k) => c.repo.getMatch(k)).filter((m) => m !== null);
      for (const m of targets) c.repo.upsertMatch({ ...m, status: "pending", spotifyId: null, spotifyUri: null, score: null, decidedBy: null, decidedAt: null });
      console.log(`reset ${targets.length} match(es) to pending`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("export")
  .description("run only the export step (decrypt/transcode unmatched local files into export.dir)")
  .option("--force", "re-export files that already exist (use after changing the bitrate, or to refresh tags/URIs)")
  .action(async (opts: { force?: boolean }) => {
    try {
      const c = await ctx();
      const plans = planExportsOnly(c.repo, c.cfg, {}, opts.force ?? false);
      const r = await applyExports(plans, { repo: c.repo, cfg: c.cfg, now: Date.now() });
      console.log(`exported ${r.exported} file(s)${r.errors ? `, ${r.errors} error(s)` : ""}; run \`spotifify sync\` to refresh the paste list`);
      if (r.uriChanged > 0) console.log(`${r.uriChanged} file(s) changed identity: the old entries in the desktop client are now stale (\`spotifify sync --prune\` removes them), then \`spotifify pending --copy\` and paste again`);
    } catch (e) {
      fail(e);
    }
  });

// ---- task -------------------------------------------------------------------

const task = program.command("task").description("Windows Task Scheduler registration");

task
  .command("install")
  .option("--time <HH:mm>", "daily run time", "03:00")
  .option("--exe <path>", "compiled spotifify.exe (default: bun run src/cli.ts)")
  .action(async (opts: { time: string; exe?: string }) => {
    const script = join(import.meta.dir, "..", "scripts", "register-task.ps1");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Time", opts.time];
    if (opts.exe) args.push("-Exe", opts.exe);
    process.exit(await Bun.spawn(["powershell", ...args], { stdout: "inherit", stderr: "inherit" }).exited);
  });

task.command("uninstall").action(async () => {
  const script = join(import.meta.dir, "..", "scripts", "register-task.ps1");
  process.exit(await Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Uninstall"], { stdout: "inherit", stderr: "inherit" }).exited);
});

await program.parseAsync(process.argv);
