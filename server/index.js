// Aurora Music 后端代理：基于 NeteaseCloudMusicApi 启动 HTTP 服务
// 前端（Web / Tauri 桌面 / Tauri 移动端）统一通过该服务获取网易云数据
//
// 另外承担「歌曲设置共享」的收发：
//   GET  /share/song-settings  其它设备凭本机 IP 拉取共享出去的歌曲设置
//   POST /share/song-settings  本机 App 把歌曲设置发布到这里（仅允许本机回环地址）
// 共享开关默认关闭；关闭时本机会把已发布的缓存清空，避免残留数据继续被拉到。
const { serveNcmApi } = require("NeteaseCloudMusicApi");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const port = Number(process.env.PORT || 3000);
// 默认监听 0.0.0.0，方便同一局域网内的手机（Android/iOS）直接访问
const host = process.env.HOST || "0.0.0.0";

/** 共享数据的落盘位置：放在 server 目录下，重启后仍可被其它设备拉到 */
const SHARE_FILE = path.join(__dirname, ".song-settings-share.json");
/** 手动替换音频的暂存目录（关闭共享时一并清除） */
const AUDIO_DIR = path.join(__dirname, ".share-audio");
const SHARE_MAX_BYTES = 4 * 1024 * 1024; // 4MB，够放大量歌词文本

function readShare() {
  try {
    if (!fs.existsSync(SHARE_FILE)) return null;
    return JSON.parse(fs.readFileSync(SHARE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeShare(payload) {
  try {
    if (payload === null) {
      if (fs.existsSync(SHARE_FILE)) fs.unlinkSync(SHARE_FILE);
      return;
    }
    fs.writeFileSync(SHARE_FILE, JSON.stringify(payload), "utf8");
  } catch (err) {
    console.error("[Aurora Music] 写入共享歌曲设置失败:", err);
  }
}

/**
 * 「本机」地址集合，用于限制发布接口只被自己调用。
 *
 * 关键点：App 在浏览器里经**本机局域网 IP** 访问自己时（前端 defaultApiBase 会跟随
 * location.hostname，于是接口地址也指到 192.168.x.x:3000），
 * req.socket.remoteAddress 就是那个局域网 IP —— 只认 127.0.0.1 会把正常的发布请求
 * 全部判成 403。这正是「歌曲设置/替换音频都发布不出去」的根因。
 * 所以把本机所有网卡地址一并视为本机（局域网内其它设备不会撞上这些地址）。
 */
let ownAddrs = new Set();
let ownAddrsAt = 0;

function isOwnAddress(req) {
  const ip = req.socket?.remoteAddress || "";
  if (!ip) return false;
  const now = Date.now();
  // 网卡地址可能变化（换 Wi-Fi），定期刷新
  if (ownAddrs.size === 0 || now - ownAddrsAt > 30_000) {
    const set = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) {
          if (!ni || !ni.address) continue;
          set.add(ni.address);
          set.add(`::ffff:${ni.address}`);
        }
      }
    } catch {
      /* 取不到就只认回环 */
    }
    ownAddrs = set;
    ownAddrsAt = now;
  }
  return ownAddrs.has(ip);
}

/** 关闭共享时把音频暂存也一并清掉，不留残留 */
function clearAudioDir() {
  try {
    if (fs.existsSync(AUDIO_DIR)) fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error("[Aurora Music] 清除共享音频失败:", err);
  }
}

/**
 * 本机所有**非内部**的 IPv4 地址（局域网地址，形如 192.168.x.x / 10.x / 172.16-31.x）。
 *
 * 只给 GET /share/whoami 用：前端要在设置页显示「服务所在设备的 IP」，
 * 好让同一 Wi-Fi 下的另一台设备照着填。取不到时返回空数组，前端有兜底文案。
 */
function localIpv4List() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        // family 在旧版 Node 上是字符串 "IPv4"，新版是数字 4，两种都认
        const isV4 = ni && (ni.family === "IPv4" || ni.family === 4);
        if (!isV4 || ni.internal) continue;
        if (!out.includes(ni.address)) out.push(ni.address);
      }
    }
  } catch {
    /* 取不到就返回空数组，前端会给出人话说明 */
  }
  return out;
}

/*
 * 图片透传：GET /img?u=<encodeURIComponent(url)>
 *
 * 存在的唯一理由：玻璃底栏要根据「背后那张图的平均亮度」决定文字转不转深色，
 * 而网易云封面是**跨域资源** —— 直接画进 canvas 会污染画布，getImageData() 抛错，
 * 前端永远拿不到像素。这里由本机代理把图片原样转发一遍并带上 CORS 头，
 * 前端用 crossOrigin="anonymous" 的 <img> + canvas 就能读到像素了。
 *
 * 安全边界（不要把本机代理变成对任意地址开放的代理）：
 *   · 只接受 http / https；
 *   · 主机名必须在白名单后缀内（默认网易云图床 + 本机回环，可用环境变量
 *     AURORA_IMG_HOSTS 追加，逗号分隔）；
 *   · 上游响应的 Content-Type 必须是 image/*。
 */
const IMG_HOST_SUFFIXES = (process.env.AURORA_IMG_HOSTS || "music.126.net,126.net,127.0.0.1,localhost")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isAllowedImageHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  return IMG_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

function registerImageProxy(app) {
  app.get("/img", async (req, res) => {
    const raw = typeof req.query.u === "string" ? req.query.u : "";
    let target = null;
    try {
      target = new URL(raw);
    } catch {
      target = null;
    }
    if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) {
      res.status(400).json({ code: 400, message: "缺少合法的 u 参数" });
      return;
    }
    if (!isAllowedImageHost(target.hostname)) {
      res.status(403).json({ code: 403, message: "该图片主机不在白名单内" });
      return;
    }
    try {
      const upstream = await fetch(target, {
        headers: {
          // 网易图床对没有 Referer 的请求会 403
          Referer: "https://music.163.com/",
          "User-Agent": "Mozilla/5.0 (Aurora Music image proxy)",
        },
        redirect: "follow",
      });
      const type = upstream.headers.get("content-type") || "";
      if (!upstream.ok || !upstream.body || !type.startsWith("image/")) {
        res.status(502).json({ code: 502, message: `图片获取失败（${upstream.status}）` });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "public, max-age=86400");
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
      console.error("[Aurora Music] 图片透传失败:", err && err.message);
      if (!res.headersSent) res.status(502).json({ code: 502, message: "图片获取异常" });
      else res.end();
    }
  });
}

function registerShareRoutes(app) {
  /*
   * 只读小接口：告诉前端「这台设备现在的局域网 IP 是多少」。
   *
   * 为什么必须由服务端回答：浏览器读不到自己的局域网 IP（WebRTC 那条路早被
   * 隐私策略封掉），而本机代理同时知道**自己的网卡地址**和**请求方地址**。
   *
   * 用途：设置页「歌曲设置共享」卡片在填 IP 的输入框下方显示当前设备 IP，
   * 方便另一台设备照着填。
   *
   * 返回只有两项信息，不写磁盘、不读共享数据、不影响既有接口：
   *   { clientIp, isLoopback, serverIps }
   * 其中 clientIp 在本机回环访问时为 null（此时看 serverIps 即可）。
   */
  app.get("/share/whoami", (req, res) => {
    const raw = req.socket?.remoteAddress || "";
    // 去掉 IPv6 映射前缀（::ffff:192.168.0.28 → 192.168.0.28）
    const stripped = raw.replace(/^::ffff:/i, "");
    const isLoopback = stripped === "127.0.0.1" || stripped === "::1" || stripped === "localhost";
    const serverIps = localIpv4List();
    res.json({
      clientIp: isLoopback || !stripped ? null : stripped,
      isLoopback,
      serverIps,
    });
  });

  app.get("/share/song-settings", (_req, res) => {
    const data = readShare();
    if (!data) {
      res.status(404).json({ code: 404, message: "该设备未共享歌曲设置" });
      return;
    }
    res.json(data);
  });

  // 只有本机（App 自己）能发布/清除，防止局域网内其它设备乱写
  app.post("/share/song-settings", (req, res) => {
    if (!isOwnAddress(req)) {
      res.status(403).json({ code: 403, message: "只允许本机发布" });
      return;
    }
    const body = req.body;
    if (body && body.enabled === false) {
      writeShare(null);
      clearAudioDir();
      res.json({ code: 200, message: "已关闭共享" });
      return;
    }
    if (!body || !Array.isArray(body.overrides)) {
      res.status(400).json({ code: 400, message: "缺少 overrides" });
      return;
    }
    const text = JSON.stringify(body);
    if (text.length > SHARE_MAX_BYTES) {
      res.status(413).json({ code: 413, message: "数据过大" });
      return;
    }
    writeShare({
      code: 200,
      sharedAt: Date.now(),
      deviceName: typeof body.deviceName === "string" ? body.deviceName : "",
      overrides: body.overrides,
    });
    res.json({ code: 200, count: body.overrides.length });
  });

  /*
   * 手动替换的音频（本地文件）走独立的二进制通道。
   *
   * 为什么不塞进上面的 JSON：音频动辄几 MB 到几十 MB，base64 还要再涨 33%，
   * 而 Express 的 JSON body 是有上限的，很容易直接 413；而且二进制经 JSON 往返没有意义。
   * 这里用 application/octet-stream（不会被 json 解析器接管），原样落盘。
   *
   *   GET  /share/audio?list=1          列出已发布的音频（供 App 跳过重复上传）
   *   GET  /share/audio?songId=xxx      下载某个音频
   *   POST /share/audio?songId=xxx      上传（仅允许回环地址）
   */
  app.get("/share/audio", (req, res) => {
    if (req.query.list !== undefined) {
      const data = readShare();
      if (!data) {
        res.status(404).json({ code: 404, message: "该设备未共享歌曲设置" });
        return;
      }
      const list = fs.existsSync(AUDIO_DIR)
        ? fs
            .readdirSync(AUDIO_DIR)
            .map((f) => {
              const m = /^(\d+)\.bin$/.exec(f);
              if (!m) return null;
              let size = 0;
              try {
                size = fs.statSync(path.join(AUDIO_DIR, f)).size;
              } catch {
                return null;
              }
              return { songId: Number(m[1]), size };
            })
            .filter(Boolean)
        : [];
      res.json({ code: 200, list });
      return;
    }

    const songId = Number(req.query.songId);
    if (!Number.isFinite(songId)) {
      res.status(400).json({ code: 400, message: "缺少 songId" });
      return;
    }
    const file = path.join(AUDIO_DIR, `${songId}.bin`);
    if (!fs.existsSync(file)) {
      res.status(404).json({ code: 404, message: "未找到该音频" });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  });

  app.post("/share/audio", (req, res) => {
    if (!isOwnAddress(req)) {
      res.status(403).json({ code: 403, message: "只允许本机发布" });
      return;
    }
    const songId = Number(req.query.songId);
    if (!Number.isFinite(songId)) {
      res.status(400).json({ code: 400, message: "缺少 songId" });
      return;
    }
    try {
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
    } catch {
      /* 已存在 */
    }
    const file = path.join(AUDIO_DIR, `${songId}.bin`);
    const out = fs.createWriteStream(file);
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
    });
    req.pipe(out);
    out.on("finish", () => res.json({ code: 200, songId, size: bytes }));
    out.on("error", (err) => {
      console.error("[Aurora Music] 写入共享音频失败:", err);
      res.status(500).json({ code: 500, message: "写入失败" });
    });
  });
}

serveNcmApi({
  checkVersion: false,
  port,
  host,
})
  .then((app) => {
    // serveNcmApi 已在内部 app.listen() 启动监听，返回值为 Express app（app.server 才是 http.Server）
    const bound = app.server && app.server.address ? app.server.address() : null;
    const realPort = bound && bound.port ? bound.port : port;

    // 自建路由挂在它的路由之后：网易云的那些路径都不会命中这里，不影响代理功能
    registerShareRoutes(app);
    // 图片透传（玻璃色调自适应读封面亮度用）
    registerImageProxy(app);

    console.log("[Aurora Music] NeteaseCloudMusicApi 代理已启动");
    console.log(`  本机访问:  http://localhost:${realPort}`);
    console.log(`  移动端访问: http://<电脑局域网IP>:${realPort}`);
    console.log(`  歌曲设置共享接口: /share/song-settings`);
    console.log("");
    console.log("提示：如需访问 VIP / 私密数据，可设置登录 Cookie，例如：");
    console.log("  set COOKIE=你的_MUSIC_U值 然后重新启动");
  })
  .catch((err) => {
    console.error("[Aurora Music] 代理启动失败:", err);
    process.exit(1);
  });
