# Aurora Music 🎵

[English](./README.en.md) | 中文

> **当前版本：`v0.0.1-beta`（Beta 测试版）** —— 功能与数据格式仍可能变动，请自行评估后再日常使用。

> ⚠️ **本项目仅供个人学习与技术交流，禁止商业使用；与网易云音乐官方无任何关联，也不包含任何音源文件。** 使用前请先读[第 11 节 · 版权与免责声明](#11-版权与免责声明)。

**Aurora Music 是一个多端网易云音乐播放器**：一套 React 前端 + 一个本机 Node 代理，既能当网页用（手机连同一 Wi-Fi 直接打开），也能打包成 Windows / macOS / Linux 桌面应用（Tauri 2），还预留了 Android / iOS 的构建脚本。

---

## 1. 这是什么

浏览器打开就能听歌，手机扫码/输网址就能当遥控器与播放器用，桌面端可安装成原生应用。歌词用 Apple Music Like Lyrics（AMLL）渲染，支持逐字滚动与翻译。

### 主要特性

- **四项底栏导航**：首页 / 歌曲 / 设置 / 搜索（顺序固定，见 `src/components/layout/nav.ts` 的 `NAV_ITEMS`）。触屏竖屏会自动换成液态玻璃药丸停靠栏，鼠标设备与横屏用底部导航 / 侧边栏。
- **沉浸歌词页（AMLL）**：`src/components/player/LyricsSheet.tsx` 用 `@applemusic-like-lyrics/react` 的 `LyricPlayer` 渲染，逐字歌词（YRC）与翻译经 `@applemusic-like-lyrics/lyric` 解析；支持 TTML 歌词源、弹簧参数、流动背景、字体与颜色等一整套调节。
- **触屏液态玻璃底栏**：两种形态 —— 「两栏展开态」（玻璃歌曲栏 + 大药丸）与「合一态」（一整行：左圆 = 当前页面图标、中间歌曲胶囊、右圆 = 搜索）。切形态规则：内容区滚动的**累计位移**（不分方向）达到「收起触发距离」就收成合一态；滑到内容**顶部或底部**（在端点继续滑也算）则展开回两栏；静置超时也会自动收起；设置页不参与自动换形态。可调**透明度**、**滑动阻力**、**回位速度**、**回弹幅度**、**按压形变**、**收起触发距离**、**静置折叠灵敏度**（见 `src/pages/SettingsPage.tsx` 的「触屏底栏（液态玻璃）」卡片）。
- **锁屏歌词与媒体会话**：Media Session 提供锁屏歌名 / 封面 / 当前歌词行，以及播放、暂停、上下首、拖动进度。
- **全屏跟随**：进入沉浸歌词页自动全屏；可选的「沉浸歌词跟随全屏」（仅电脑端）让全屏 ↔ 歌词页联动。
- **键盘快捷键**：沉浸歌词页里 `Space` 暂停 / 播放，`←` `→` 上一首 / 下一首；其它页面统一挂 `Tab` 前缀 —— `Tab + Space`、`Tab + ←` / `Tab + →`。输入框、下拉菜单与打开的模态框里不抢键，`Shift + Tab` 保留原生跳焦点（实现与取舍见 `src/hooks/usePlayerShortcuts.ts`）。
- **歌曲设置共享**：把逐首的歌词 / 纯音乐标记 / 歌词显示设置共享给同一局域网内的其它设备（含替换过的本地音频）。
- **本地替换音频**：某首歌可以用你自己的音频文件替换在线音源，字节存在 IndexedDB（`aurora-audio`），刷新与重启都还在。
- **搜索 / 歌单 / 专辑 / 收藏 / 历史**：搜索歌曲、歌单、歌手、专辑、用户；歌单与专辑详情页；收藏（歌曲 / 歌单 / 歌手 / 用户 / 专辑）与最近 500 条播放历史。
- **用户主页解析**：粘贴网易云个人主页链接即可读取其歌单与听歌排行（周榜 / 总榜）。

---

## 2. 环境要求

| 用途 | 需要什么 |
| --- | --- |
| 网页端（跑起来） | **Node.js ≥ 18**（Vite 5 要求 `^18.0.0 \|\| >=20.0.0`；本机实测 Node v22.20.0） + npm |
| 手机访问 | 与电脑同一 Wi-Fi 即可，手机端无需安装任何东西 |
| 桌面端 / 移动端（可选） | **Rust**（`cargo` / `rustc`）+ Tauri 2 系统依赖；Windows 上见第 5 节的 MinGW 说明 |
| Android / iOS（可选） | Android：Android Studio + SDK/NDK + JDK 17；iOS：macOS + Xcode |

> 平台以 **Windows** 为例（本文所有路径都按 Windows 写）。macOS / Linux 的命令完全一致，只是路径分隔符不同。

---

## 3. 快速开始

### 方式一：双击 `start.cmd`（推荐）

在项目根目录双击 **`start.cmd`**。它做的事（源码见 `start.cmd` / `start.ps1`）：

1. 检查是否装了 `node`，没有就提示去装 Node 18+；
2. 按需安装依赖：根目录缺 `node_modules\vite` 时执行 `npm install`；`server\node_modules` 不存在时在 `server\` 下再执行一次 `npm install`；
3. **端口 3000（本机代理）**：如果已经在监听，直接**跳过启动**并提示「端口 3000 已有服务在跑，不会重复启动」；否则后台最小化启动 `node server/index.js` 并最多等 40 秒；
4. **端口 1420（网页端）**：同样，已在监听就**跳过**，否则后台最小化启动 `node node_modules/vite/bin/vite.js --port 1420` 并最多等 30 秒；
5. 打印访问地址（本机 + 局域网 IP），按回车关闭启动窗口 —— **关掉那两个最小化的窗口即可停止服务**。

> `start.cmd` 只负责拉起 `start.ps1`（`.cmd` 里全是 ASCII，避免 cmd.exe 的代码页把中文显示成乱码），真正的逻辑与中文提示都在 `start.ps1` 里。

### 方式二：手动开两个终端

```bash
# 终端 1：本机代理（NeteaseCloudMusicApi），端口 3000
npm run server

# 终端 2：网页端（Vite），端口 1420
npm run dev
```

然后打开 **http://localhost:1420**。

### 端口与地址速查

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| 网页端（Vite） | **1420** | `vite.config.ts` 里写死 `port: 1420` + `strictPort: true`，被占用会直接失败而不是换端口 |
| 本机代理 | **3000** | `server/index.js` 的 `PORT`，默认监听 `0.0.0.0` |

前端默认把接口指向「当前页面主机名 + `:3000`」（`src/lib/env.ts`）；在 Tauri 原生容器里固定指向 `http://127.0.0.1:3000`。可用 `VITE_API_BASE` 覆盖，写法参考 `.env.example`。

### 依赖装在哪

这个项目有**两份独立的 `node_modules`**：

- **项目根 `node_modules/`** —— 网页端与桌面壳的依赖（React、Vite、AMLL、Howler、`@tauri-apps/*` 等，见根 `package.json`）；
- **`server/node_modules/`** —— 只有代理的依赖：`NeteaseCloudMusicApi`（见 `server/package.json`）。

所以改了 `server/` 的代码、或者代理报「找不到模块」时，要单独在 `server\` 目录里装依赖 —— `start.ps1` 就是这么做的。只装根目录不会把代理的依赖装好。

---

## 4. 手机 / 其它设备访问

1. 确认手机与电脑连接**同一个 Wi-Fi**（同一局域网）；
2. 在电脑上跑 `ipconfig` 看局域网 IPv4 地址（本机实测示例：`192.168.0.28`）；
3. 手机浏览器打开：

```
http://<电脑局域网IP>:1420
```

例如 `http://192.168.0.28:1420`。`start.ps1` 启动完会直接把这条地址打印出来。

- **代理对外也在 `:3000`**。手机页面会自动把接口请求发到 `http://<同一个IP>:3000`，所以**不需要**在手机上配任何东西，但电脑上的代理必须开着。
- 手机上的 `localhost` 指的是手机自己，所以不能用 `localhost:1420`。
- **防火墙**：Windows 第一次会弹出「是否允许 Node.js 在此网络上通信」，必须允许（专用网络足够）；如果手滑点了取消，页面能打开但接口一直失败 —— 去「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」里把 Node.js 勾上，或临时关掉防火墙测试。
- `vite.config.ts` 的 `server.host` 默认监听所有网卡，所以局域网访问是设计内的行为，不是巧合。
- **移动端 App（Android / iOS）不一样**：代理不在手机上，必须构建时用 `VITE_API_BASE` 指向电脑（或服务器）的局域网地址，否则手机上的 App 连不上接口。桌面端不用配：代理就在本机，固定走 `127.0.0.1:3000`。

---

## 5. 构建与打包

### 网页端

```bash
npm run build      # = tsc && vite build，产物在 dist/
npm run preview    # 本地预览构建产物（Vite preview）
```

产物目录是 `dist/`（`vite.config.ts` 的 `build` 段 + `index.html` 入口）。构建目标按平台自动选：Windows(Tauri) 用 `chrome105`，其它用 `safari13`。

### 桌面端（Tauri 2）

```bash
npm run desktop:dev     # = tauri dev：先起前端（beforeDevCommand = pnpm dev → 1420），再开原生窗口
npm run desktop:build   # = tauri build：先构建前端（beforeBuildCommand = pnpm build），再编译 Rust 并打包
npm run tauri -- <命令> # 直接调用 Tauri CLI，例如 npm run tauri icon src-tauri/icons/icon.svg
```

产物位置（`src-tauri/tauri.conf.json` 的 `bundle.targets = "all"`）：

| 产物 | 路径 |
| --- | --- |
| 可执行文件 | `src-tauri/target/release/aurora-music.exe` |
| 安装包 | `src-tauri/target/release/bundle/` 下，Windows 的 NSIS 安装包在 `bundle/nsis/` |

例如本机已有的产物：`src-tauri\target\release\bundle\nsis\Aurora Music_0.0.1-beta_x64-setup.exe`（名字里的 `Aurora Music` 与 `0.0.1-beta` 分别来自 `tauri.conf.json` 的 `productName` 与 `version`；`v` 前缀只给 git tag 用，包内版本号必须是合法 SemVer，所以写作 `0.0.1-beta`）。

> `desktop:build` 内部会调用 `pnpm build`（`tauri.conf.json` 的 `beforeBuildCommand`），所以机器上要有可用的 `pnpm`；只跑网页端则 `npm run build` 就够。

### ⚠️ Windows 上构建 Tauri 需要 MinGW 工具链（如实说明）

本机的 Rust 是 **GNU 目标**（`rustc -vV` 显示 `host: x86_64-pc-windows-gnu`），链接与导入库生成依赖 MinGW 的 `dlltool.exe` / `gcc.exe`。如果这些工具不在 `PATH` 里，构建会直接报：

```
error: dlltool.exe not found
```

本机用的是 MSYS2 的 UCRT64 工具链，路径为：

```
D:\msys64\ucrt64\bin
```

**构建前先把它加进当前终端的 `PATH`**（PowerShell）：

```powershell
$env:PATH = "D:\msys64\ucrt64\bin;" + $env:PATH
npm run desktop:build
```

确认是否可用：

```powershell
Test-Path D:\msys64\ucrt64\bin\dlltool.exe   # 应为 True
```

> 若你用的是 MSVC 工具链（Visual Studio Build Tools），`rustc` 的 host 通常是 `x86_64-pc-windows-msvc`，此时不需要 MinGW；本文只按本机验证过的 GNU + MSYS2 组合描述。

---

## 6. 数据与设置存放位置

### 网页端：`localStorage`（键名前缀 `aurora:`）

| 键名 | 内容 |
| --- | --- |
| `aurora:song_overrides` | 逐首歌曲设置：纯音乐标记、手写歌词、歌词格式、替换音频文件名 / 大小、跳过前 N 行、翻译偏移 |
| `aurora:favorites` | 收藏的歌曲 |
| `aurora:fav_items` | 收藏的歌单 / 歌手 / 用户 / 专辑 |
| `aurora:history` | 播放历史（最多 500 条） |
| `aurora:kv:settings` | 全部设置（共用项）—— 注意键名是 `kvGet("settings")` 拼出来的 `aurora:kv:` + `settings` |
| `aurora:kv:settings_<scope>` | **分档**设置：`scope` 为 `touch_portrait` / `touch_landscape` / `mouse_portrait` / `mouse_landscape` 四种设备状态之一 |
| `aurora:kv:player_state` | 上次的播放队列、当前曲目与音量 |
| `<键>:prev` | 每次覆盖写之前，旧值会原样留一份到这里（如 `aurora:song_overrides:prev`）。只留一份，但足以挽救一次误写 |

在浏览器里查看：F12 → Application / 存储 → Local Storage → `http://localhost:1420`。

### 桌面端（Tauri）：SQLite

`src/lib/storage.ts` 在 Tauri 环境里改用 `@tauri-apps/plugin-sql`，数据库文件名为 **`aurora_music.db`**（`Database.load("sqlite:aurora_music.db")`），表结构与网页端的键一一对应：`favorites`、`play_history`、`kv_store`、`favorite_items`、`song_overrides`。

> 该数据库文件的**具体目录由 tauri-plugin-sql 按应用数据目录解析**，本仓库里没有写死路径，因此本文不给出绝对路径 —— 需要时在 App 数据目录（Windows 上是 `%APPDATA%` 下由 `identifier`（`com.aurora.music`）决定的位置）里按文件名找。

### 替换音频的字节：IndexedDB

本地替换的音频存在 IndexedDB 数据库 **`aurora-audio`** 的 **`files`** 对象存储里（`src/lib/audioStore.ts`）。网页端与桌面端共用，刷新 / 重启都还在；localStorage 记录里只存文件名与大小，音频本体不存 localStorage。

### 歌曲设置共享的落盘文件（在 server 侧）

| 路径 | 内容 |
| --- | --- |
| `server/.song-settings-share.json` | 「歌曲设置共享」开启后，本机发布出去的设置会落盘在这里，重启代理后其它设备仍能拉到；关闭共享时该文件会被删除 |
| `server/.share-audio/` | 共享出去的手动替换音频的暂存目录（文件名形如 `<songId>.bin`），关闭共享时一并清除 |

这两个路径由 `server/index.js` 生成，已写进 `.gitignore`。

### 单曲设置的手工备份

- **`song-settings-backup.json`**（根目录）是单曲设置的备份文件，**不要删**。它是人工留的存档，代码不读写它；同目录下还有带日期的历史存档（如 `song-settings-backup.10-06.json`）。
- 程序侧的保险是上面那张表里的 `<键>:prev`：每次覆盖写之前把旧值挪一份，所以即使出现误写也还能从上一版找回来。

---

## 7. 歌曲设置共享怎么用

用途：把 A 设备上逐首做好的设置（歌词、纯音乐标记、歌词显示设置、替换过的本地音频）搬到同一局域网的 B 设备上。

**A 端（提供方，通常是电脑）**

1. 打开 **设置 → 歌曲设置共享**，打开「共享我的歌曲设置」开关（默认关闭）；
2. 打开后 App 会立刻把设置 `POST` 到本机代理，落盘到 `server/.song-settings-share.json`；之后每次改动单曲设置都会自动重新发布；
3. 卡片里的「本机地址」会显示 `IP:3000`（例如 `192.168.0.28:3000`），复制它给 B 端。
   - 如果是在电脑本机用 `localhost` 打开，浏览器读不到自己的局域网 IP，卡片会改显示「服务所在设备地址」（后端接口 `GET /share/whoami` 提供的网卡地址）。

**B 端（接收方，通常是手机）**

1. 用 `http://<A 的局域网 IP>:1420` 打开同一个应用；
2. 设置 → 歌曲设置共享 → 「从其它设备添加」里填入 A 的地址（**只填 IP 也行，端口 `3000` 会自动补上**），点「一键添加」；
3. 提示会告诉你「已添加 N 首 / 更新 N 首 / 含替换音频 N 首 / 跳过 N 首」。

**规则与注意事项**

- **端口必须是 3000**：共享接口就挂在代理上（`GET` / `POST /share/song-settings`、音频走 `GET` / `POST /share/audio`），和网易云接口是同一台服务、同一个端口；A 端代理没起来，B 端就一定拉不到。
- **合并策略**：同一首歌以 `updatedAt` 较新的为准，不会用旧数据覆盖 B 端较新的设置；双方都有的歌按时间取新，B 端较新就跳过。
- **音频也会同步**：发布时经二进制通道上传，导入时取回并写进 B 端的 IndexedDB，所以改过音源的歌在对方那边也能直接播放；只传缺失或大小变化的，不会每次重传几十 MB。
- **发布接口只接受本机**：`POST` 会校验来源地址是本机网卡之一，局域网里其它设备无法往 A 端乱写。
- 没有「自动发现设备」这回事：必须一端开开关、另一端手填地址。

---

## 8. 常见问题

**Q：脚本说「端口 3000 / 1420 已有服务在跑，跳过启动」？**
那是 `start.ps1` 的正常行为 —— 它先探测端口，已经在监听就不再启动第二个进程，避免两个代理抢 3000 或 Vite 因 `strictPort` 直接失败。如果你**就是想重启**，去任务管理器结束对应的 `node.exe`（或关掉那两个最小化的启动窗口）后重新双击 `start.cmd`。

**Q：改了 `server/index.js` 为什么不生效？（今天真踩过）**
因为**跑着的是旧进程**。`server/index.js` 是 Node 脚本，改完必须**重启代理**才会加载新代码。今天的现象就是：文件里明明已经写了 `GET /share/whoami`，但旧进程没有这条路由，前端设置页一直显示「读不到本机 IP」；重启代理后立刻正常。所以：**改 `server/` 里任何文件 → 停掉代理进程 → 重新启动**（`start.cmd` 或 `npm run server`）。前端代码则相反，Vite 会热更新。

**Q：页面行为与代码/预期不一致？**
先 **Ctrl + Shift + R 硬刷新**（或 DevTools 勾选 Disable cache 后刷新）。Vite 偶尔会下发旧模块，改了代码但页面还在跑上一版的情况是存在的；硬刷新能排除这一类假象，再去怀疑代码。

**Q：iPhone 锁屏上，进度条和 ⏮/⏭ 只能要一个？**
对，**实测两次确认不能兼得**（原因见 `src/lib/mediaSession.ts` 的 `WITHDRAW_SEEK_ACTIONS` 与 `src/components/common/LockCompatExperiment.tsx`）：

- 不撤回 `seekbackward` / `seekforward`（**当前默认**）→ 锁屏**进度条可拖**，但系统默认的「±10 秒」键会顶掉 ⏮/⏭；
- 显式撤回这两个动作 → 锁屏恢复 ⏮/⏭，但**进度条变回只读**（第一次实测与「把 `<audio>` 挂进文档 + 每秒推 positionState」之后复测，结论一致）。

设置页的「**锁屏兼容（进阶）**」卡片就是这两件事的开关（`把 <audio> 挂进文档`、`每秒推 positionState`），默认值（开 + 开）是实机验证过可用的组合；改完硬刷新页面，播放一首后在锁屏上看进度条能不能拖、进退键是哪一套。

**Q：按 F11 进了浏览器全屏，为什么退出不了？**
因为**浏览器自带全屏（F11 / 浏览器「全屏」菜单）属于浏览器自己的窗口状态，网页没有任何 API 能退出它**：`document.fullscreenElement` 一直是 `null`，也不会派发 `fullscreenchange`。App 只能退出「自己用 Fullscreen API 请求的那种全屏」。所以请自己按 **Esc** 或 **F11** 退出（App 会提示一次「浏览器全屏需要按 Esc 或 F11 退出（网页无权退出）」，同一会话只提示一次）。

**Q：`song-settings-backup.json` 能删吗？**
**不要删**。那是单曲设置的备份文件（代码不读写它，是人留的存档）。另外程序每次覆盖写 localStorage 之前，会把旧值留一份到 `<键>:prev`（如 `aurora:song_overrides:prev`），这是最后一道保险。

**Q：`npm install` 报 pixi 相关的 peer 警告？**
`package.json` 已显式声明全部 `@pixi/*@7.4.3`，`.npmrc` 里有 `auto-install-peers=true`，剩余的 peer 提示可以忽略。

**Q：网页端报 CORS / 接口全挂？**
确认代理由 `serveNcmApi` 启动（它自带 CORS 头），并且**不要**让前端直连网易云域名；同时检查防火墙是否挡住了 3000。

**Q：歌词不显示或整片黑？**
AMLL 基于 PixiJS（WebGL）渲染，确认设备支持 WebGL；`@applemusic-like-lyrics/core/style.css` 已在 `src/main.tsx` 全局引入。

---

## 9. 项目结构

| 路径 | 作用 |
| --- | --- |
| `src/pages/` | 页面：`UserPage`（首页 / 我的及他人主页，路由 `/`、`/user`、`/user/:uid`）、`SongsPage`、`SettingsPage`、`SearchPage`、`FavoritesPage`、`HistoryPage`、`SongSettingsPage`、`PlaylistPage`、`AlbumPage` |
| `src/components/layout/` | 布局与导航：`AppLayout`、`BottomNav`（鼠标）、`Sidebar`（横屏）、`TouchDockNav`（触屏竖屏液态玻璃药丸）、`TouchMiniBar`（合一态）、`TouchSongBar`、`nav.ts`（导航项与高亮归属规则） |
| `src/components/common/` | 通用组件，含 `SongSettingsShare`（歌曲设置共享卡片）、`LockCompatExperiment`（锁屏兼容进阶） |
| `src/components/player/` | 播放器与歌词：`PlayerBar`、`LyricsSheet`（AMLL 沉浸歌词页）、`ProgressSlider`、`SkipButton` 等 |
| `src/components/playlist/`、`src/components/ui/` | 歌单卡片 / 歌曲行；shadcn/ui 基础组件 |
| `src/lib/` | 逻辑层：`netease.ts`（接口）、`lyrics.ts`（歌词解析与 TTML）、`storage.ts`（存储抽象）、`settings.ts`（设置定义与默认值）、`share.ts`（歌曲设置共享）、`audioStore.ts`（IndexedDB 音频）、`mediaSession.ts`（锁屏）、`fullscreen.ts`、`env.ts`（代理地址）、`glassTone.ts`、`touchMorph.ts` 等 |
| `src/stores/` | zustand 状态：`playerStore`、`settingsStore`、`appStore` |
| `server/` | 本机代理（Node，端口 3000）：`index.js` 在 `NeteaseCloudMusicApi` 之上加了歌曲设置共享、音频通道与图片透传；依赖装在 `server/node_modules/`（**不要改 `server/README.md`，那是第三方库自带的**） |
| `src-tauri/` | Tauri 2 工程：`tauri.conf.json`（窗口、`devUrl` 1420、打包目标）、`Cargo.toml`（`tauri-plugin-sql`）、`src/lib.rs`（注册 SQL 插件）、`capabilities/default.json`（授权 `sql:*`）、`icons/`、`target/`（构建产物） |
| `public/`、`index.html`、`vite.config.ts`、`tailwind.config.cjs`、`tsconfig.json` | 静态资源与工程配置 |
| `start.cmd` / `start.ps1` | 一键启动脚本（见第 3 节） |
| `dist/`、`src-tauri/target/` | 构建产物（`npm run build` / `npm run desktop:build`） |
| `_perf/`、`_diag.html`、`_diag_out.json` | 开发期的性能与诊断脚本 / 输出，不参与运行时 |
| `song-settings-backup*.json` | 单曲设置的手工备份（见第 6 节） |

---

## 10. 许可与致谢

- **本项目的许可：AGPL-3.0**（见仓库根目录的 [`LICENSE`](./LICENSE)）。
  - **为什么是 AGPL-3.0 而不是 MIT**：本项目使用 `@applemusic-like-lyrics/core`、`/react`、`/lyric`，三个包均为 **AGPL-3.0-only**。它们会被打进前端 bundle 与桌面端二进制，构成结合作品，因此整个作品必须按 AGPL-3.0 分发。
  - 按 AGPL-3.0 第 13 条，**通过网络使用本程序的用户同样有权获取完整对应源码**：<https://github.com/chan-air/Aurora-Music>。
  - 再分发修改版时，请保留 `LICENSE` 与各第三方组件的版权声明。
- 第三方组件致谢：
  - [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)（`server/` 的代理内核，自带 `server/README.md`）
  - [Apple Music Like Lyrics (AMLL)](https://github.com/amll-dev/applemusic-like-lyrics)（歌词渲染与解析；使用前请自行确认其许可条款）
  - React、Vite、TypeScript、Tailwind CSS、shadcn/ui、Howler.js、Tauri 2、zustand

## 11. 版权与免责声明

> **本项目不是网易云音乐的官方客户端，也未获得其任何形式的授权或认可。请先读完本节，再决定是否使用或分发。**

- **用途**：本项目**仅供个人学习、技术研究与交流**，**禁止任何形式的商业使用**（包括但不限于付费分发、捆绑销售、以本项目承接商业项目）。
- **归属**：与网易云音乐（杭州网易云音乐科技有限公司）及其关联公司**没有任何关系**。文中出现的产品名称、商标、封面、歌词等均归各自权利人所有，仅作标识与说明之用。
- **不含音源**：本仓库与发行包**不包含、不存储、不分发任何音频文件**，也不内置任何账号凭据；音乐、封面、歌词等数据由使用者本机通过第三方接口实时获取。
- **接口**：本项目通过**非官方接口**访问数据。这类用法可能不符合相关平台的服务条款，也可能随平台调整而随时失效。是否使用、如何使用，由使用者自行判断并承担全部风险。
- **禁止行为**：请勿将本项目用于破解付费内容、绕过会员或版权限制、批量下载、二次分发受版权保护的作品，以及其它侵犯他人合法权益的行为。
- **支持正版**：喜欢请通过官方渠道购买会员、专辑与数字音乐。
- **无担保**：本项目按 **AGPL-3.0**「按原样（AS IS）」提供，不附带任何明示或默示的担保，作者不对使用后果承担责任。
- **侵权处理**：若权利人认为本项目侵犯其合法权益，请通过仓库 Issue 或主页联系方式告知，核实后我会**立即删除**相关内容或停止分发。

---

有问题先看第 8 节，然后记得：**改后端要重启代理，页面不对先硬刷新。**
