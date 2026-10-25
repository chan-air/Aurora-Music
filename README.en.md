# Aurora Music 🎵

English | [中文](./README.md)

> **Current version: `1.0.0 beta-1` (beta)** — features and on-disk data formats may still change; try it before relying on it day to day.

**Aurora Music is a multi-platform NetEase Cloud Music player**: one React front end plus a local Node proxy. Run it as a web app (open it on your phone over the same Wi-Fi), or package it as a native Windows / macOS / Linux desktop app with Tauri 2. Build scripts for Android and iOS are wired up as well.

---

## 1. What this is

Open it in a browser and it plays music. Open it on your phone and it works as a player and remote. Package it and you get a real desktop app. Lyrics are rendered with Apple Music Like Lyrics (AMLL), including word-by-word timing and translations.

### Highlights

- **Four-tab bottom navigation**: Home / Songs / Settings / Search, in that fixed order (`NAV_ITEMS` in `src/components/layout/nav.ts`). On a touch device in portrait, the bar becomes a liquid-glass pill dock; mouse devices and landscape layouts use the regular bottom nav or sidebar.
- **Immersive lyrics page (AMLL)**: `src/components/player/LyricsSheet.tsx` renders `LyricPlayer` from `@applemusic-like-lyrics/react`; word-by-word (YRC) lyrics and translations are parsed with `@applemusic-like-lyrics/lyric`. TTML lyric sources, spring parameters, flowing background, fonts, and colors are all configurable.
- **Touch liquid-glass dock**: two forms — the expanded two-row layout (glass song bar + large pill) and the merged single-row layout (left circle = current page icon, center song capsule, right circle = search). It collapses automatically when the content area is scrolled or left idle. You can tune **transparency**, **fling resistance**, **return speed**, **bounce**, **press deformation**, and the **idle auto-collapse sensitivity** (see the "触屏底栏（液态玻璃）" card in `src/pages/SettingsPage.tsx`).
- **Lock-screen lyrics and media session**: Media Session exposes title, artwork, and the current lyric line on the lock screen, plus play, pause, previous/next, and scrubbing.
- **Fullscreen follow**: opening the immersive lyrics page requests fullscreen; the optional "immersive lyrics follow fullscreen" toggle (desktop only) links fullscreen and the lyrics page in both directions.
- **Keyboard shortcuts**: on the immersive lyrics page `Space` toggles play/pause and `←` / `→` skip to the previous/next track; everywhere else the same actions take a `Tab` prefix — `Tab + Space`, `Tab + ←` / `Tab + →`. Typing fields, open menus, and modal dialogs keep those keys for themselves, and `Shift + Tab` still moves focus natively (`src/hooks/usePlayerShortcuts.ts` documents the trade-off).
- **Song settings sharing**: share per-song settings (lyrics, instrumental flag, lyric display options, and even replaced local audio) with other devices on the same LAN.
- **Local audio replacement**: swap the online stream of a song for your own file. The bytes live in IndexedDB (`aurora-audio`), so they survive refreshes and restarts.
- **Search / playlists / albums / favorites / history**: search songs, playlists, artists, albums, and users; playlist and album detail pages; favorites for songs, playlists, artists, users, and albums; and the last 500 played tracks in history.
- **User profile parsing**: paste a NetEase Cloud Music profile URL and the app reads that user's playlists and listening ranking (weekly and all-time).

---

## 2. Requirements

| Goal | What you need |
| --- | --- |
| Web app (just running it) | **Node.js ≥ 18** (Vite 5 requires `^18.0.0 \|\| >=20.0.0`; verified locally on Node v22.20.0) plus npm |
| Phone access | The phone and the computer on the same Wi-Fi. Nothing to install on the phone |
| Desktop / mobile app (optional) | **Rust** (`cargo` / `rustc`) and the Tauri 2 system prerequisites; on Windows see the MinGW note in section 5 |
| Android / iOS (optional) | Android: Android Studio + SDK/NDK + JDK 17. iOS: macOS + Xcode |

> Everything below is written for **Windows**, which is the platform this was verified on. The commands are identical on macOS and Linux; only path separators differ.

---

## 3. Quick start

### Option A: double-click `start.cmd` (recommended)

Double-click **`start.cmd`** in the project root. Here is exactly what it does (`start.cmd` and `start.ps1`):

1. Checks that `node` exists and tells you to install Node 18+ if it does not.
2. Installs dependencies as needed: runs `npm install` in the project root if `node_modules\vite` is missing, and runs `npm install` inside `server\` if `server\node_modules` is missing.
3. **Port 3000 (local proxy)**: if something is already listening there, it **skips startup** and reports that port 3000 is already in use. Otherwise it launches `node server/index.js` minimized in the background and waits up to 40 seconds.
4. **Port 1420 (web app)**: same logic — skip if already listening, otherwise launch `node node_modules/vite/bin/vite.js --port 1420` minimized and wait up to 30 seconds.
5. Prints the URLs to open (localhost and the LAN address) and waits for Enter. **Closing those two minimized windows stops the services.**

> `start.cmd` only launches `start.ps1`. The `.cmd` file is deliberately pure ASCII so that cmd.exe's code page cannot turn Chinese text into mojibake; all the real logic and the Chinese messages live in `start.ps1`.

### Option B: two terminals by hand

```bash
# Terminal 1: local proxy (NeteaseCloudMusicApi) on port 3000
npm run server

# Terminal 2: web app (Vite) on port 1420
npm run dev
```

Then open **http://localhost:1420**.

### Ports and addresses at a glance

| Service | Port | Notes |
| --- | --- | --- |
| Web app (Vite) | **1420** | Hard-coded as `port: 1420` with `strictPort: true` in `vite.config.ts`, so an occupied port fails loudly instead of silently moving |
| Local proxy | **3000** | The `PORT` in `server/index.js`; listens on `0.0.0.0` by default |

The front end points at `<current page host>:3000` by default (`src/lib/env.ts`). Inside the Tauri native container it always uses `http://127.0.0.1:3000`. Override it with `VITE_API_BASE`; see `.env.example`.

### Where dependencies are installed

This project has **two independent `node_modules` directories**:

- **`node_modules/` in the project root** — front-end and desktop-shell dependencies (React, Vite, AMLL, Howler, `@tauri-apps/*`, and so on; see the root `package.json`).
- **`server/node_modules/`** — the proxy's dependencies only: `NeteaseCloudMusicApi` (see `server/package.json`).

So if you change something under `server/`, or the proxy complains about a missing module, install dependencies inside `server\` separately — that is exactly what `start.ps1` does. Installing only in the root will not set up the proxy's dependencies.

---

## 4. Access from a phone or another device

1. Make sure the phone and the computer are on the **same Wi-Fi** (same LAN).
2. Run `ipconfig` on the computer to find its LAN IPv4 address (verified locally as `192.168.0.28`).
3. Open this in the phone's browser:

```
http://<computer LAN IP>:1420
```

For example `http://192.168.0.28:1420`. `start.ps1` prints this exact URL once startup finishes.

- **The proxy is exposed on `:3000` as well.** The page on your phone automatically sends API requests to `http://<same IP>:3000`, so nothing needs configuring on the phone — but the proxy on the computer must be running.
- `localhost` on a phone means the phone itself, so `localhost:1420` will not work there.
- **Firewall**: the first run triggers a Windows prompt asking whether to allow Node.js on this network. Allow it (Private networks are enough). If it gets dismissed, the page still loads but every API call fails — open "Windows Security → Firewall & network protection → Allow an app through firewall" and tick Node.js, or temporarily disable the firewall to confirm.
- `server.host` in `vite.config.ts` listens on all interfaces by default, so LAN access is intended behaviour rather than an accident.
- **Mobile apps (Android / iOS) are different**: the proxy does not run on the phone, so you must build with `VITE_API_BASE` pointing at the computer's (or a server's) LAN address, otherwise the app cannot reach the API. The desktop app needs no such setting because the proxy runs locally at `127.0.0.1:3000`.

---

## 5. Building and packaging

### Web

```bash
npm run build      # = tsc && vite build, output in dist/
npm run preview    # preview the production build locally (vite preview)
```

The output directory is `dist/` (see the `build` section of `vite.config.ts` plus the `index.html` entry). The build target is chosen per platform: `chrome105` for Windows/Tauri and `safari13` otherwise.

### Desktop (Tauri 2)

```bash
npm run desktop:dev     # = tauri dev: starts the front end first (beforeDevCommand = pnpm dev → 1420), then the native window
npm run desktop:build   # = tauri build: builds the front end (beforeBuildCommand = pnpm build), then compiles Rust and packages
npm run tauri -- <cmd>  # raw Tauri CLI, e.g. npm run tauri icon src-tauri/icons/icon.svg
```

Where the artifacts land (`bundle.targets = "all"` in `src-tauri/tauri.conf.json`):

| Artifact | Path |
| --- | --- |
| Executable | `src-tauri/target/release/aurora-music.exe` |
| Installers | Under `src-tauri/target/release/bundle/`; the Windows NSIS installer is in `bundle/nsis/` |

An existing example from this machine: `src-tauri\target\release\bundle\nsis\Aurora Music_1.0.0-beta.1_x64-setup.exe` (the `Aurora Music` and `1.0.0-beta.1` in the name come from `productName` and `version` in `tauri.conf.json`; the version has to be valid SemVer, so "1.0.0 beta-1" is written as `1.0.0-beta.1`).

> `desktop:build` internally calls `pnpm build` (`beforeBuildCommand` in `tauri.conf.json`), so a working `pnpm` must be available. For the web app alone, `npm run build` is enough.

### ⚠️ Building Tauri on Windows needs a MinGW toolchain

The Rust toolchain here targets **GNU** (`rustc -vV` reports `host: x86_64-pc-windows-gnu`), so linking and import-library generation depend on MinGW's `dlltool.exe` / `gcc.exe`. If those are not on `PATH`, the build fails outright with:

```
error: dlltool.exe not found
```

This machine uses the MSYS2 UCRT64 toolchain at:

```
D:\msys64\ucrt64\bin
```

**Add it to `PATH` before building** (PowerShell):

```powershell
$env:PATH = "D:\msys64\ucrt64\bin;" + $env:PATH
npm run desktop:build
```

To confirm it is available:

```powershell
Test-Path D:\msys64\ucrt64\bin\dlltool.exe   # should be True
```

> If you use the MSVC toolchain (Visual Studio Build Tools), `rustc`'s host is usually `x86_64-pc-windows-msvc` and MinGW is unnecessary. This document only describes the GNU + MSYS2 combination verified on this machine.

---

## 6. Where data and settings live

### Web: `localStorage` (keys prefixed with `aurora:`)

| Key | Contents |
| --- | --- |
| `aurora:song_overrides` | Per-song settings: instrumental flag, hand-written lyrics, lyric format, replaced-audio file name and size, skip-leading-lines, translation shift |
| `aurora:favorites` | Favorite songs |
| `aurora:fav_items` | Favorite playlists / artists / users / albums |
| `aurora:history` | Play history (up to 500 entries) |
| `aurora:kv:settings` | All shared settings — note the real key is `aurora:kv:` plus `settings`, produced by `kvGet("settings")` |
| `aurora:kv:settings_<scope>` | **Per-profile** settings, where `scope` is one of `touch_portrait`, `touch_landscape`, `mouse_portrait`, `mouse_landscape` |
| `aurora:kv:player_state` | Last playback queue, current track, and volume |
| `<key>:prev` | Before every overwrite, the previous value is kept verbatim here (for example `aurora:song_overrides:prev`). Only one generation is kept, but it is enough to recover from a bad write |

To inspect them in a browser: F12 → Application/Storage → Local Storage → `http://localhost:1420`.

### Desktop (Tauri): SQLite

Under Tauri, `src/lib/storage.ts` switches to `@tauri-apps/plugin-sql` and opens the database file **`aurora_music.db`** (`Database.load("sqlite:aurora_music.db")`). Its tables mirror the web keys one-to-one: `favorites`, `play_history`, `kv_store`, `favorite_items`, `song_overrides`.

> The **directory** of that database file is resolved by tauri-plugin-sql from the app data directory; no absolute path is hard-coded in this repository, so none is given here. When you need it, look for the file by name under the app data directory (on Windows, under `%APPDATA%`, at the location determined by the `identifier`, which is `com.aurora.music`).

### Bytes of replaced audio: IndexedDB

Replaced local audio is stored in the **`files`** object store of the IndexedDB database **`aurora-audio`** (`src/lib/audioStore.ts`). It is shared by the web and desktop builds and persists across refreshes and restarts. The localStorage record only holds the file name and size; the audio bytes are never put in localStorage.

### On-disk files for song settings sharing (server side)

| Path | Contents |
| --- | --- |
| `server/.song-settings-share.json` | When sharing is on, the settings published by this machine are written here, so other devices can still fetch them after a proxy restart. Turning sharing off deletes the file |
| `server/.share-audio/` | Staging directory for shared replaced audio (files named `<songId>.bin`). Cleared when sharing is turned off |

Both paths are created by `server/index.js` and are listed in `.gitignore`.

### Manual backup of per-song settings

- **`song-settings-backup.json`** in the project root is a backup of per-song settings — **do not delete it**. It is a human-made archive; the code neither reads nor writes it. Dated archives such as `song-settings-backup.10-06.json` sit next to it.
- The program's own safety net is the `<key>:prev` entry listed above: the previous value is moved aside before every overwrite, so even a bad write can be recovered.

---

## 7. How to use song settings sharing

Purpose: move per-song work done on device A (lyrics, instrumental flags, lyric display options, and replaced local audio) to device B on the same LAN.

**Device A (the source, usually the computer)**

1. Open **Settings → Song settings sharing** and turn on "Share my song settings" (off by default).
2. As soon as it is on, the app `POST`s the settings to the local proxy, which writes them to `server/.song-settings-share.json`. Every later change to a per-song setting is republished automatically.
3. The card shows the local address as `IP:3000` (for example `192.168.0.28:3000`). Copy it to device B.
   - If you opened the app on the computer itself via `localhost`, the browser cannot read its own LAN IP, so the card instead shows the address of the device running the service (the NIC address returned by `GET /share/whoami`).

**Device B (the receiver, usually the phone)**

1. Open the same app at `http://<A's LAN IP>:1420`.
2. Go to Settings → Song settings sharing → "Add from another device", type A's address (**the IP alone is enough; port `3000` is added automatically**), and click "Add".

**Rules and caveats**

- **The port must be 3000.** The sharing endpoints live on the proxy itself (`GET` / `POST /share/song-settings`, with audio on `GET` / `POST /share/audio`) — the same service and port as the NetEase API. If A's proxy is not running, B cannot fetch anything.
- **Merge strategy**: for the same song, the newer `updatedAt` wins. Older data never overwrites newer settings on B; if B's copy is newer, that song is skipped.
- **Audio is synced too**: replaced audio is uploaded over a binary channel when publishing and downloaded into B's IndexedDB when importing, so a song with a swapped source plays correctly on the other device. Only missing or size-changed files are transferred, so publishing does not re-upload tens of megabytes every time.
- **The publish endpoint accepts the local machine only.** `POST` verifies that the request comes from one of the host's own addresses, so other LAN devices cannot write to A.
- There is no automatic device discovery: one side turns sharing on, the other types the address.

---

## 8. Troubleshooting

**Q: The script says "port 3000 / 1420 is already in use, skipping startup".**
That is `start.ps1` working as designed. It probes the port first and does not launch a second process, which avoids two proxies fighting over 3000 or Vite failing outright because of `strictPort`. If you actually want a restart, end the relevant `node.exe` processes in Task Manager (or close the two minimized windows started earlier) and double-click `start.cmd` again.

**Q: I edited `server/index.js` but nothing changed.**
Because **the old process is still the one running.** `server/index.js` is a Node script: new code is only loaded when the proxy restarts. That is exactly what happened here today — the file already contained `GET /share/whoami`, but the running process had no such route, so the settings page kept saying it could not read the local IP; restarting the proxy fixed it immediately. So: **after changing anything under `server/`, stop the proxy process and start it again** (`start.cmd` or `npm run server`). Front-end code is the opposite — Vite hot-reloads it.

**Q: The page behaves differently from the code I am looking at.**
Hit **Ctrl + Shift + R** first (or enable "Disable cache" in DevTools and reload). Vite occasionally serves a stale module, so a changed file can appear to have no effect. A hard refresh rules that class of illusion out before you go hunting for a bug.

**Q: On iPhone, do I really have to choose between the lock-screen scrubber and ⏮/⏭?**
Yes — **confirmed twice on real hardware** (see `WITHDRAW_SEEK_ACTIONS` in `src/lib/mediaSession.ts` and `src/components/common/LockCompatExperiment.tsx`):

- Not withdrawing `seekbackward` / `seekforward` (**the current default**) keeps the lock-screen **progress bar draggable**, at the cost of the system's default ±10-second buttons displacing our ⏮/⏭.
- Explicitly withdrawing those two actions restores ⏮/⏭, but the **progress bar becomes read-only** again (verified in the first experiment and re-verified after mounting `<audio>` into the document and pushing `positionState` every second).

The **"Lock-screen compatibility (advanced)"** card on the Settings page is where those two behaviours are toggled (`Mount <audio> into the document`, `Push positionState every second`). The defaults (on + on) are the combination verified on real hardware. After changing them, hard-refresh the page, play a track, and check on the lock screen whether the progress bar drags and which pair of buttons you get.

**Q: I pressed F11 for browser fullscreen and cannot get out.**
Because **browser-native fullscreen (F11, or the browser's own Fullscreen menu item) belongs to the browser window, and no web API can exit it**: `document.fullscreenElement` stays `null` and no `fullscreenchange` event is fired. The app can only exit the kind of fullscreen it requested itself through the Fullscreen API. Press **Esc** or **F11** yourself. The app shows a one-time hint, "浏览器全屏需要按 Esc 或 F11 退出（网页无权退出）" (browser fullscreen must be exited with Esc or F11 — a web page has no permission to do it), once per session.

**Q: Can I delete `song-settings-backup.json`?**
**Don't.** It is a backup of your per-song settings (the code neither reads nor writes it; it is a human archive). Separately, the program keeps the previous value of a localStorage key at `<key>:prev` (for example `aurora:song_overrides:prev`) before every overwrite as a last line of defence.

**Q: `npm install` prints pixi-related peer warnings.**
All `@pixi/*@7.4.3` packages are already declared explicitly in `package.json` and `.npmrc` sets `auto-install-peers=true`, so the remaining peer notices can be ignored.

**Q: The web app reports CORS errors or every API call fails.**
Make sure the proxy is the one started by `serveNcmApi` (it supplies the CORS headers) and never point the front end straight at NetEase's domains. Also check that the firewall is not blocking port 3000.

**Q: Lyrics do not show up, or the page is entirely black.**
AMLL renders through PixiJS (WebGL), so confirm the device supports WebGL. `@applemusic-like-lyrics/core/style.css` is already imported globally in `src/main.tsx`.

---

## 9. Project structure

| Path | Purpose |
| --- | --- |
| `src/pages/` | Pages: `UserPage` (home and any user's profile; routes `/`, `/user`, `/user/:uid`), `SongsPage`, `SettingsPage`, `SearchPage`, `FavoritesPage`, `HistoryPage`, `SongSettingsPage`, `PlaylistPage`, `AlbumPage` |
| `src/components/layout/` | Layout and navigation: `AppLayout`, `BottomNav` (mouse), `Sidebar` (landscape), `TouchDockNav` (touch-portrait liquid-glass pill dock), `TouchMiniBar` (merged form), `TouchSongBar`, `nav.ts` (nav items and highlight ownership rules) |
| `src/components/common/` | Shared components, including `SongSettingsShare` (sharing card) and `LockCompatExperiment` (advanced lock-screen compatibility) |
| `src/components/player/` | Player and lyrics: `PlayerBar`, `LyricsSheet` (the AMLL immersive lyrics page), `ProgressSlider`, `SkipButton`, and more |
| `src/components/playlist/`, `src/components/ui/` | Playlist card and song row; shadcn/ui primitives |
| `src/lib/` | Logic layer: `netease.ts` (API), `lyrics.ts` (lyric parsing and TTML), `storage.ts` (storage abstraction), `settings.ts` (settings definition and defaults), `share.ts` (song settings sharing), `audioStore.ts` (IndexedDB audio), `mediaSession.ts` (lock screen), `fullscreen.ts`, `env.ts` (proxy address), `glassTone.ts`, `touchMorph.ts`, and more |
| `src/stores/` | zustand state: `playerStore`, `settingsStore`, `appStore` |
| `server/` | Local proxy (Node, port 3000): `index.js` adds song settings sharing, the audio channel, and the image passthrough on top of `NeteaseCloudMusicApi`. Dependencies live in `server/node_modules/`. (**Do not edit `server/README.md` — it belongs to the third-party library.**) |
| `src-tauri/` | Tauri 2 project: `tauri.conf.json` (window, `devUrl` 1420, bundle targets), `Cargo.toml` (`tauri-plugin-sql`), `src/lib.rs` (registers the SQL plugin), `capabilities/default.json` (grants `sql:*`), `icons/`, `target/` (build output) |
| `public/`, `index.html`, `vite.config.ts`, `tailwind.config.cjs`, `tsconfig.json` | Static assets and project configuration |
| `start.cmd` / `start.ps1` | One-click launcher (see section 3) |
| `dist/`, `src-tauri/target/` | Build artifacts (`npm run build` / `npm run desktop:build`) |
| `_perf/`, `_diag.html`, `_diag_out.json` | Development-time performance and diagnostic scripts/output; not part of the runtime |
| `song-settings-backup*.json` | Manual backups of per-song settings (see section 6) |

---

## 10. License and credits

- **License for this project: AGPL-3.0** (see [`LICENSE`](./LICENSE) in the repository root).
  - **Why AGPL-3.0 rather than MIT**: this project uses `@applemusic-like-lyrics/core`, `/react`, and `/lyric`, all of which are **AGPL-3.0-only**. They are bundled into the front-end bundle and the desktop binaries, forming a combined work, so the whole work must be distributed under AGPL-3.0.
  - Under AGPL-3.0 §13, **users who interact with this program over a network are also entitled to the complete corresponding source**: <https://github.com/chan-air/Aurora-Music>.
  - When redistributing a modified version, keep `LICENSE` and the copyright notices of the third-party components.
- Third-party credits:
  - [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) (the proxy core under `server/`, which ships its own `server/README.md`)
  - [Apple Music Like Lyrics (AMLL)](https://github.com/amll-dev/applemusic-like-lyrics) (lyric rendering and parsing; check its license terms yourself before use)
  - React, Vite, TypeScript, Tailwind CSS, shadcn/ui, Howler.js, Tauri 2, zustand

---

If something is off, read section 8 first — and remember: **restart the proxy after backend changes, and hard-refresh the page when the UI looks wrong.**
