# Changelog

## [0.1.0](https://github.com/FYWinds/Spotifify/releases/tag/v0.1.0) (2026-09-04)

### Features

* **sources:** NetEase Cloud Music playlists and "Liked Music" via QR or cookie login, with include/exclude filters
* **sources:** local library scanning with in-memory `.ncm` decryption and NetEase-id recovery from `.ncm` headers and `163 key` comment tags
* **match:** tiered matching (ISRC → field search → free text → artist aliases → title), CJK/Traditional normalization, duration checks, confidence scoring, optional AcoustID fingerprinting
* **match:** search cache, per-run search budget and persisted rate-limit deadline for Development-mode `/search` quotas
* **match:** `aliases` command mines `matching.artist_aliases` from confirmed matches
* **sync:** idempotent plan (`desired − remote`), LIS-based reordering, foreign items preserved, `--prune` for removals, Liked Songs reconciliation
* **export:** unmatched tracks transcoded/copied into the Spotify Local Files folder with canonical tags and the desktop client's exact `spotify:local:…:{duration}` identity; atomic placement so the client never indexes a half-written file
* **tui:** Ink review UI with custom search, paste, browser open and undo
* **cli:** `init --upgrade`, `doctor`, `auth`, `sync`, `review`, `status`, `unmatched`, `aliases`, `pending --copy`, `rematch`, `export`, `task install|uninstall`
* **build:** single-binary compile via `bun build --compile`, Windows Task Scheduler registration script
