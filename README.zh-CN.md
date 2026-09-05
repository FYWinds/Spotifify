# Spotifify

[![CI](https://github.com/FYWinds/Spotifify/actions/workflows/ci.yml/badge.svg)](https://github.com/FYWinds/Spotifify/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/FYWinds/Spotifify?sort=semver)](https://github.com/FYWinds/Spotifify/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

把**网易云音乐歌单**和**本地音乐库**（含 `.ncm`）幂等地同步到 **Spotify**，可放进定时任务。Spotify 曲库里有的歌匹配后镜像成歌单（并加入"已点赞的歌曲"）；找不到的导出成 Spotify 桌面端的*本地文件*，并给出可直接粘贴的 URI。

> **本项目由 AI 编写。** 代码由 AI 编程代理在人工指导下完成，只在一个真实账号上实测过。**请谨慎使用：** 它会写入你的 Spotify 曲库，先用 `sync --dry-run` 看计划，确认无误前不要开 `--prune`，无法重建的数据请先备份。按现状提供，不做任何担保（[MIT](LICENSE)）。

```
网易云歌单 ────┐                 ┌─ 匹配 ─► spotify:track:…  ─► 镜像歌单 + 已点赞的歌曲
              ├─ 规范键 ────────┤
本地音乐库 ────┘ (网易云 id /   └─ 未匹配 ─► ffmpeg 导出 ─► spotify:local:…（粘贴一次）
 .ncm/mp3/flac   isrc / 哈希)
```

## 功能

- **来源**：网易云音乐（扫码或 Cookie 登录；自建歌单 + "我喜欢的音乐"，支持白名单/黑名单）和本地目录（`mp3 flac m4a ogg wav ncm`）。`.ncm` 在内存中解密；`.ncm` 头部和 `163 key` 注释里的网易云 id 让本地文件能顶替网易云歌单里的同一首歌。
- **分层匹配**：ISRC → 字段限定搜索 → 自由文本 → 艺人别名 → 纯标题，带 CJK / 繁简归一化、时长校验和置信度打分。低置信度进入交互式**复核 TUI**（`spotifify review`）；可选 AcoustID 声纹。
- **幂等同步**：每次运行重新拉取远端状态，Plan = `期望 − 远端`。无变化的第二次运行 = 零写请求。按来源顺序用最少移动（LIS）排序；你手动加的歌留在尾部；工具加的、已从来源消失的歌只在 `--prune` 时删除。
- **真正能播的本地文件**：未匹配的歌转码/复制到你的 Spotify *本地文件* 目录，写规范 tag，并生成桌面端自己算出的那个身份 `spotify:local:{艺人}:{专辑}:{标题}:{时长}`——包括客户端的整秒时长算法（和 ffprobe 的结果并不一样）。粘贴一次，之后的运行会像普通歌曲一样识别、排序、清理这些条目。
- **懂配额**：Development Mode 的 Spotify 应用 `/search` 有每日配额。搜索有缓存、每次运行有预算，遇到长时间 `429` 直接停止匹配阶段（截止时间持久化）而不是干等；已匹配的部分照常写入歌单。
- **单文件二进制**（`bun build --compile`）和 Windows 任务计划注册脚本。

## 安装

| 方式 | 命令 |
|---|---|
| Release 压缩包 | 从 [Releases](https://github.com/FYWinds/Spotifify/releases) 下载 `spotifify-<平台>.zip` / `.tar.xz`，解压后把 `spotifify` 放进 `PATH`。 |
| npm（需要 [Bun](https://bun.sh) ≥ 1.2） | `bun install -g spotifify`，或一次性运行：`bunx spotifify sync --dry-run` |
| 源码 | `git clone https://github.com/FYWinds/Spotifify && cd Spotifify && bun install`，然后 `bun run spotifify …` |

另外需要：

- `ffmpeg` 在 `PATH` 里（导出/转码）。只有开启声纹时才需要 `fpcalc`。
- 在 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) 建一个应用，Redirect URI 填 `http://127.0.0.1:8765/callback`（端口 = `spotify.redirect_port`）。只需要 Client ID（Authorization Code + PKCE）。
- 本地文件需要 Spotify **桌面端**（手机上播放需要 Premium 且和桌面端在同一 Wi‑Fi，见下文）。

二进制内嵌了 Bun 运行时（解压后约 70–90 MB），靠压缩包控制下载体积——UPX 这类可执行文件压缩器会破坏 Bun 内嵌的模块图，所以没有使用。

## 快速开始

```sh
spotifify init                 # 生成 ~/.spotifify/config.toml
#   编辑：spotify.client_id、netease.include_playlists、local.dirs、export.dir
spotifify auth spotify         # 打开浏览器登录（PKCE）
spotifify auth netease         # 终端扫码，或 --cookie "MUSIC_U=…"
spotifify doctor               # 检查配置 / 数据库 / ffmpeg / 登录状态
spotifify sync --dry-run       # 只打印计划
spotifify sync
spotifify pending --copy       # 本地文件 URI 进剪贴板；到 Spotify 桌面端对应歌单里粘贴
spotifify review               # 处理低置信度匹配
```

源码方式把 `spotifify …` 换成 `bun run spotifify …`。

状态目录是 `~/.spotifify`（`config.toml`、`state.db`、日志）；可用 `--state-dir` 或 `SPOTIFIFY_STATE_DIR` 覆盖。

## 命令

| 命令 | 作用 |
|---|---|
| `init [--force\|--upgrade]` | 写配置模板；`--upgrade` 把新版本新增的选项合并进现有文件（保留原值，写 `.bak`）。 |
| `doctor` | 检查配置、状态库、`ffmpeg`/`fpcalc`、token scope、搜索配额截止时间，以及桌面端的本地文件索引（哪些导出没被索引、哪些时长和我们算的不一致——歌单里灰掉的两种原因）。 |
| `auth spotify` / `auth netease [--cookie …]` | 登录。 |
| `sync [--dry-run] [--prune] [--source netease\|local] [--playlist 名称] [--skip-match]` | 拉取 → 匹配 → 导出 → 计划 → 执行 → 报告。`--prune` 还会删掉被取代的本地条目和不再需要的导出文件——但只在本次能对账的范围内：带 `--playlist`/`--source` 时不会取消其他镜像歌单想要的喜欢，本次计划外的歌单仍引用的导出文件保留，没有任何镜像歌单的运行什么都不删。退出码 `3` = 需要重新登录。 |
| `review` | Ink TUI：`j/k` 移动，`1-9`/`Enter` 选候选，`/` 自定义搜索，`p` 粘贴 Spotify 链接/URI，`o`/`O` 在浏览器打开候选/来源，`l` 保持为本地文件，`s` 跳过，`u` 撤销，`?` 帮助。 |
| `status` | 匹配统计、歌单映射、上次运行。 |
| `unmatched [--status local\|review\|all] [--tsv]` | 没有 Spotify 匹配的歌以及对应的本地文件。 |
| `aliases [--apply] [--min N]` | 从已确认的匹配里挖 `matching.artist_aliases`（例如 `"陈奕迅" = "Eason Chan"`）。 |
| `pending [--copy] [--playlist 名称]` | 上次 sync 之后仍待粘贴的本地文件 URI。 |
| `rematch <key…> \| --all-local` | 忘掉匹配决策，下次 sync 重新搜索。 |
| `export [--force]` | 只跑导出阶段。 |
| `task install [--time HH:mm] [--exe 路径]` / `task uninstall` | 注册每日 Windows 任务计划（`scripts/register-task.ps1`）。 |

全局选项：`--config`、`--state-dir`、`--log-file`、`--verbose`。

## 本地文件是怎么工作的

Spotify Web API 不能把本地文件*加入*歌单，但能读取、重排、删除已经在歌单里的本地条目。所以流程是：

1. `sync` 把每首有本地来源的未匹配歌导出到 `export.dir`（`{艺人} - {标题}.mp3|m4a`，规范 tag，封面）。文件先写到临时名再原子落位，因为桌面端在目录项出现的那一刻就会索引文件，之后不再重读。
2. `pending --copy` 把 URI 放进剪贴板；在 Spotify 桌面端打开歌单按一次 Ctrl+V。
3. 下一次 `sync` 看到这些条目，按导出记录（含时长）对上号，之后就和普通歌曲一样排序和清理。

如果粘贴的条目一直是灰的（"can't play this right now"），重启桌面端，或者在 *设置 → 本地文件* 里把目录关掉再打开让它重建索引。手机上播放本地文件：Premium，和桌面端在同一 Wi‑Fi，然后在手机上*下载*该歌单。

如果只想让本地文件给网易云歌单里没匹配上的歌提供音频、而不是把整个目录镜像成一个歌单，设置 `local.mirror_playlist = false`。

## 配置

`spotifify init` 会生成带注释的模板，见 [`config.example.toml`](config.example.toml)。要点：

| 键 | 说明 |
|---|---|
| `spotify.market` | `"from_token"`（账号所在国家）或 ISO 国家码。该地区不可播放的歌视为未匹配。 |
| `netease.include_playlists` | 歌单名/ id；特殊值 `"liked"` 表示"我喜欢的音乐"。空 = 全部自建歌单。 |
| `local.dirs`、`local.extensions`、`local.filename_pattern` | 扫描目录；无 tag 的文件按 `artist-title` / `title-artist` 解析文件名。 |
| `export.dir`、`export.bitrate` | 你的 Spotify 本地文件目录；非 mp3/m4a 来源用 `libmp3lame` 编码。 |
| `matching.auto_threshold`、`review_threshold` | 自动接受 / 进复核队列的分数阈值。 |
| `matching.max_searches_per_run`、`max_queries_per_track`、`search_concurrency`、`search_min_interval_ms` | 搜索预算（Development Mode 配额保护）。 |
| `matching.artist_aliases` | `"周杰倫" = "周杰伦"` 形式的别名表；`spotifify aliases --apply` 会自动填。 |
| `sync.playlist_prefix` | 在 Spotify 上创建的歌单名前缀。 |

## 定时运行

```powershell
spotifify task install --time 03:00            # 源码方式：跑 `bun run src/cli.ts sync`；npm 方式：跑安装好的包
spotifify task install --exe D:\tools\spotifify.exe
```

运行之间用 pid 锁（`sync.lock`）串行化；Ctrl+C 会释放锁。其他平台用 cron 跑 `spotifify sync --log-file …`。

## 开发

```sh
bun install
bun run typecheck      # tsc --noEmit
bun test               # 单元 + 端到端（e2e 需要 ffmpeg，缺失时跳过）
bun run build          # dist/spotifify（加 --target bun-linux-x64 等可交叉编译）
```

设计文档见 [`DESIGN.md`](DESIGN.md)。提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)；[release-please](https://github.com/googleapis/release-please) 据此生成 changelog、semver tag 和带 Windows / Linux / macOS 二进制的 GitHub Release。

## 许可证

[MIT](LICENSE)
