# Changelog

## [0.1.3](https://github.com/FYWinds/Spotifify/compare/v0.1.2...v0.1.3) (2026-09-05)


### Bug Fixes

* **match:** let a fingerprint hit decide for a pooled track ([75c2717](https://github.com/FYWinds/Spotifify/commit/75c27178f16b277a5062ff3aff5c396bbc36ec4b))
* **sources:** unreadable files and partial pulls are not deletions ([0fb80a7](https://github.com/FYWinds/Spotifify/commit/0fb80a7a3af3a03d06543e118be1cb7171fd5880))
* **spotify:** make playlist writes safe to interrupt and retry ([5882336](https://github.com/FYWinds/Spotifify/commit/5882336ec47f4c8ededef8712312864f7d1d7f16))
* **sync:** never prune beyond what the run reconciles ([fd1d732](https://github.com/FYWinds/Spotifify/commit/fd1d732fa06cfcff5b855f60ff90c68414d41bb9))

## [0.1.2](https://github.com/FYWinds/Spotifify/compare/v0.1.1...v0.1.2) (2026-09-05)


### Features

* **doctor:** check the client's local-file index ([bdc099b](https://github.com/FYWinds/Spotifify/commit/bdc099bfa54abaae2a9f75b4d804fd9fd41f90eb))
* **sync:** prune superseded exports with --prune ([4db0559](https://github.com/FYWinds/Spotifify/commit/4db05590f9c318e57703a5f8cdcc7be96850a58e))


### Bug Fixes

* **sync:** prune against the listing snapshot ([8c1634a](https://github.com/FYWinds/Spotifify/commit/8c1634a91b2228c4ff4916e42e621ddc54c91737))

## [0.1.1](https://github.com/FYWinds/Spotifify/compare/v0.1.0...v0.1.1) (2026-09-05)


### Features

* **release:** npm package and compressed archives ([ce7712d](https://github.com/FYWinds/Spotifify/commit/ce7712d6c1c06c9fe5272e4d7741f7bf86e40000))


### Bug Fixes

* **netease:** create anonymous_token before lib loads ([908b266](https://github.com/FYWinds/Spotifify/commit/908b266a327aeb2ee58ebf18b377748a72947168))


### Documentation

* AI authorship note and usage disclaimer ([bdf6890](https://github.com/FYWinds/Spotifify/commit/bdf6890b486bc63135ad7a96a2ce6464b201250f))

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
