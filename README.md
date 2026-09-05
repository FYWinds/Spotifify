# Spotifify

[![CI](https://github.com/FYWinds/Spotifify/actions/workflows/ci.yml/badge.svg)](https://github.com/FYWinds/Spotifify/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/FYWinds/Spotifify?sort=semver)](https://github.com/FYWinds/Spotifify/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

Idempotent, schedulable sync of **NetEase Cloud Music playlists** and a **local music library** (including `.ncm`) to **Spotify**. Tracks that exist on Spotify are matched and mirrored into playlists (and Liked Songs); everything else is exported as Spotify desktop *local files* with ready-to-paste URIs.

> **Written by an AI.** This project was produced by an AI coding agent under human direction and has been exercised against one real account. **Use it with care:** it writes to your Spotify library, so start with `sync --dry-run`, leave `--prune` off until you trust the plan, and back up anything you cannot re-create. Provided as-is, without warranty ([MIT](LICENSE)).

```
NetEase playlists ─┐                 ┌─ match ─► spotify:track:…  ─► mirrored playlists + Liked Songs
                   ├─ canonical keys ┤
Local library ─────┘  (netease id /  └─ unmatched ─► ffmpeg export ─► spotify:local:… (paste once)
   .ncm / mp3 / flac   isrc / hash)
```

## Features

- **Sources**: NetEase Cloud Music (QR or cookie login; own playlists + "Liked Music", include/exclude filters) and local folders (`mp3 flac m4a ogg wav ncm`). `.ncm` files are decrypted in memory; the NetEase id embedded in `.ncm` headers and in `163 key` comment tags lets a local file stand in for the same song in a NetEase playlist.
- **Tiered matching**: ISRC → field-restricted search → free text → artist aliases → title only, with CJK/Traditional-Chinese normalization, duration checks and a confidence score. Low-confidence hits go to an interactive **review TUI** (`spotifify review`); optional AcoustID fingerprinting.
- **Idempotent sync**: the remote state is re-fetched on every run and the plan is `desired − remote`. Second run with no changes = zero write requests. Source order is enforced with minimal moves (LIS); items you added by hand are kept at the tail; tool-added items that left the source are only removed with `--prune`.
- **Local files that actually play**: unmatched tracks are transcoded/copied into your Spotify *Local Files* folder with canonical tags, and the tool emits the exact `spotify:local:{artist}:{album}:{title}:{duration}` identity the desktop client computes — including the duration arithmetic the client uses, which is *not* what ffprobe reports. Paste the URIs once; later runs recognise, reorder and prune those entries like any other.
- **Rate-limit aware**: Development-mode Spotify apps have a daily `/search` quota. Searches are cached, budgeted per run and a long `429` stops the match phase (persisted deadline) instead of sleeping; playlist writes still happen for what is already matched.
- **Single binary** (`bun build --compile`) and a Windows Task Scheduler helper for nightly runs.

## Install

| Method | Command |
|---|---|
| Release archive | Download `spotifify-<platform>.zip` / `.tar.xz` from [Releases](https://github.com/FYWinds/Spotifify/releases), unpack, put `spotifify` on `PATH`. |
| npm (needs [Bun](https://bun.sh) ≥ 1.2) | `bun install -g spotifify` — or one-off: `bunx spotifify sync --dry-run` |
| From source | `git clone https://github.com/FYWinds/Spotifify && cd Spotifify && bun install`, then `bun run spotifify …` |

Also needed:

- `ffmpeg` on `PATH` (exports/transcoding). `fpcalc` only if you enable fingerprinting.
- A Spotify app from the [Developer Dashboard](https://developer.spotify.com/dashboard): add the Redirect URI `http://127.0.0.1:8765/callback` (port = `spotify.redirect_port`). Only the Client ID is needed (Authorization Code + PKCE).
- The Spotify **desktop** client for local files (playing them on mobile needs Premium and the same Wi‑Fi network; see below).

The binaries embed the Bun runtime (~70–90 MB unpacked); the archives are what keep downloads small — UPX-style executable packers break Bun's embedded module graph, so they are not used.

## Quick start

```sh
spotifify init                 # writes ~/.spotifify/config.toml
#   edit: spotify.client_id, netease.include_playlists, local.dirs, export.dir
spotifify auth spotify         # opens the browser (PKCE)
spotifify auth netease         # QR code in the terminal, or --cookie "MUSIC_U=…"
spotifify doctor               # config / db / ffmpeg / auth checks
spotifify sync --dry-run       # prints the plan
spotifify sync
spotifify pending --copy       # local-file URIs → clipboard; paste into the playlist in Spotify desktop
spotifify review               # resolve low-confidence matches
```

From a source checkout use `bun run spotifify …` instead of `spotifify …`.

State lives in `~/.spotifify` (`config.toml`, `state.db`, logs); override with `--state-dir` or `SPOTIFIFY_STATE_DIR`.

## Commands

| Command | What it does |
|---|---|
| `init [--force\|--upgrade]` | Write the config template; `--upgrade` merges options added in newer versions into your file (values kept, `.bak` written). |
| `doctor` | Check config, state db, `ffmpeg`/`fpcalc`, token scopes, search-quota deadline, and the desktop client's local-files index (exports it never indexed or indexed with another duration — the two causes of grey rows). |
| `auth spotify` / `auth netease [--cookie …]` | Log in. |
| `sync [--dry-run] [--prune] [--source netease\|local] [--playlist NAME] [--skip-match]` | Pull → match → export → plan → apply → report. `--prune` also removes superseded local entries and exported files no longer needed — never beyond what the run can account for: with `--playlist`/`--source` nothing is unliked that another mirrored playlist wants, exports still referenced from a playlist outside the run are kept, and a run that mirrors no playlist at all prunes nothing. Exit code `3` = re-authenticate. |
| `review` | Ink TUI: `j/k` move, `1-9`/`Enter` pick a candidate, `/` custom search, `p` paste a Spotify URL/URI, `o`/`O` open candidate/source in the browser, `l` keep as local file, `s` skip, `u` undo, `?` help. |
| `status` | Match counts, playlist mappings, last run. |
| `unmatched [--status local\|review\|all] [--tsv]` | Tracks without a Spotify match and the local file that backs them. |
| `aliases [--apply] [--min N]` | Mine `matching.artist_aliases` (e.g. `"陈奕迅" = "Eason Chan"`) from confirmed matches. |
| `pending [--copy] [--playlist NAME]` | Local-file URIs still to be pasted, from the last sync. |
| `rematch <key…> \| --all-local` | Forget match decisions so the next sync searches again. |
| `export [--force]` | Run only the export step. |
| `task install [--time HH:mm] [--exe PATH]` / `task uninstall` | Register a daily Windows Scheduled Task (`scripts/register-task.ps1`). |

Global options: `--config`, `--state-dir`, `--log-file`, `--verbose`.

## How local files work

Spotify's Web API cannot *add* a local file to a playlist, but it can read, reorder and remove local entries that are already there. So the loop is:

1. `sync` exports every unmatched track that has a local source into `export.dir` (`{artist} - {title}.mp3|m4a`, canonical tags, cover art). Files are written under a temporary name and then placed atomically, because the desktop client indexes a file the moment its directory entry appears and never re-reads it.
2. `pending --copy` puts the URIs on the clipboard; open the playlist in Spotify desktop and press Ctrl+V once.
3. The next `sync` sees those entries, matches them to the export records (duration included), and from then on orders and prunes them like normal tracks.

If pasted entries stay grey ("can't play this right now"), restart the desktop client or toggle the folder off/on under *Settings → Local Files* so its index is rebuilt. Playing local files on a phone: Premium, same Wi‑Fi as the desktop client, then *Download* the playlist on the phone.

Set `local.mirror_playlist = false` if you only want local files to supply audio for NetEase playlists rather than mirroring the whole folder as its own playlist.

## Configuration

`spotifify init` writes an annotated template; see [`config.example.toml`](config.example.toml). Highlights:

| Key | Notes |
|---|---|
| `spotify.market` | `"from_token"` (account country) or an ISO code. Tracks not playable in that market count as unmatched. |
| `netease.include_playlists` | Playlist names/ids; the special value `"liked"` selects "Liked Music". Empty = all own playlists. |
| `local.dirs`, `local.extensions`, `local.filename_pattern` | Folders to scan; tag-less files fall back to `artist-title` / `title-artist` filename parsing. |
| `export.dir`, `export.bitrate` | Your Spotify Local Files folder; non-mp3/m4a sources are encoded with `libmp3lame`. |
| `matching.auto_threshold`, `review_threshold` | Score cut-offs for auto-accept and review queue. |
| `matching.max_searches_per_run`, `max_queries_per_track`, `search_concurrency`, `search_min_interval_ms` | Search budget (Development-mode quota protection). |
| `matching.artist_aliases` | `"周杰倫" = "周杰伦"` style table; `spotifify aliases --apply` fills it. |
| `sync.playlist_prefix` | Prefix for playlists created on Spotify. |

## Scheduling

```powershell
spotifify task install --time 03:00            # from a checkout: runs `bun run src/cli.ts sync`; from npm: the installed package
spotifify task install --exe D:\tools\spotifify.exe
```

Runs are serialised by a pid lock (`sync.lock`); Ctrl+C releases it. On other platforms use cron with `spotifify sync --log-file …`.

## Development

```sh
bun install
bun run typecheck      # tsc --noEmit
bun test               # unit + end-to-end (e2e needs ffmpeg; skipped otherwise)
bun run build          # dist/spotifify (add --target bun-linux-x64 etc. to cross-compile)
```

The design document is [`DESIGN.md`](DESIGN.md) (Chinese). Commits follow [Conventional Commits](https://www.conventionalcommits.org/); [release-please](https://github.com/googleapis/release-please) turns them into the changelog, the semver tag and a GitHub Release with binaries for Windows, Linux and macOS.

## License

[MIT](LICENSE)
