import { API_BASE } from "./env";
import { getLocalAudio, putLocalAudio } from "./audioStore";
import {
  getSongOverrides,
  loadSongOverrides,
  saveSongOverride,
  type SongOverride,
} from "./storage";

/** 音频二进制通道的地址（与设置接口同一台服务） */
function audioUrl(host: string | undefined, query: string): string {
  const target = host && host.trim() ? host.trim() : defaultShareHost();
  const cleaned = target.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const withPort = /:\d+$/.test(cleaned) ? cleaned : `${cleaned}:${apiPort()}`;
  return `http://${withPort}/share/audio?${query}&t=${Date.now()}${Math.random()
    .toString(36)
    .slice(2)}`;
}

/**
 * 歌曲设置共享。
 *
 * 传输走本机那台 NeteaseCloudMusicApi 代理（默认监听 0.0.0.0:3000，手机本来就能访问），
 * 由 server/index.js 提供：
 *   GET  /share/song-settings   其它设备凭本机 IP 拉取
 *   POST /share/song-settings   本机 App 发布（仅允许回环地址）
 *
 * 注意：该代理内部有一层 `app.use(cache('2 minutes', …))` 的全局响应缓存，
 * 同一个 URL 的第二次请求会被缓存拦下、根本不进我们的处理器（实测过）。
 * 所以这里每次请求都带一个唯一参数把缓存绕开 —— 少了它会出现「发布后拉到的还是旧数据」
 * 以及「关闭共享后仍然能拉到」。
 */

/**
 * 「本机」= 当前页面所在的那台机器（代理就在它上面），**不是**写死的回环地址。
 *
 * 为什么这条是必须的：以前不给 host 时固定用 `127.0.0.1`，在电脑上（localhost:1420）
 * 恰好对；但**手机或任何用局域网地址打开的设备**上，`127.0.0.1` 指的是**手机自己**，
 * 那里没有代理 → 发布必然失败 → 服务端永远收不到 → `GET /share/song-settings` 永远 404。
 * 用户看到的「打开共享开关也没用」就是这条。
 *
 * 页面在 192.168.0.28:1420 打开 → 代理在 192.168.0.28:3000；
 * 页面在 localhost:1420 打开   → 代理在 localhost:3000（与 env.ts 的 API_BASE 同口径）。
 * 注意：用户**手填 IP** 的导入路径不走这里，仍用他填的那个地址。
 */
function defaultShareHost(): string {
  if (typeof location !== "undefined" && location.hostname) return location.hostname;
  return "127.0.0.1";
}

/** 从代理地址推出口径：默认 http://host:3000 —— 共享接口与它同端口 */
function apiPort(): string {
  try {
    return new URL(API_BASE).port || "3000";
  } catch {
    return "3000";
  }
}

/** 共享接口地址。host 省略表示**当前页面所在的那台机器**；带唯一参数绕过代理内置缓存 */
function shareUrl(host?: string): string {
  const target = host && host.trim() ? host.trim() : defaultShareHost();
  // 用户可能直接粘贴 http://192.168.0.28 或带端口，统一处理
  const cleaned = target.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const withPort = /:\d+$/.test(cleaned) ? cleaned : `${cleaned}:${apiPort()}`;
  return `http://${withPort}/share/song-settings?t=${Date.now()}${Math.random()
    .toString(36)
    .slice(2)}`;
}

/**
 * 可共享的字段。
 * 音频文件名/大小**要带上**：接收方需要知道这首有替换音频，并据此去二进制通道取文件。
 * 音频字节本身不在这里传（见 publishAudios）。
 */
function shareable(o: SongOverride) {
  return {
    songId: o.songId,
    name: o.name,
    artists: o.artists,
    instrumental: o.instrumental,
    lyricFormat: o.lyricFormat,
    lyricText: o.lyricText,
    audioName: o.audioName ?? "",
    audioSize: o.audioSize ?? 0,
    // 歌词显示设置也是"单曲设置"，跟着一起共享；缺省时按 0 处理
    skipLeadingLines: o.skipLeadingLines ?? 0,
    translationShift: o.translationShift ?? 0,
    updatedAt: o.updatedAt,
  };
}

/**
 * 把带替换音频的那些歌上传到本机代理的二进制通道。
 * 先问服务端已经有了哪些（按大小比对），只传缺失/变化的，避免每次发布都重传几十 MB。
 */
async function publishAudios(): Promise<{ uploaded: number; failed: number[] }> {
  const withAudio = getSongOverrides().filter((o) => o.audioName);
  if (!withAudio.length) return { uploaded: 0, failed: [] };

  let existing = new Map<number, number>();
  try {
    const res = await fetch(audioUrl(undefined, "list=1"));
    if (res.ok) {
      const json = (await res.json()) as { list?: { songId: number; size: number }[] };
      existing = new Map((json.list ?? []).map((x) => [x.songId, x.size]));
    }
  } catch {
    /* 取不到就当作都没有，最多多传一次 */
  }

  let uploaded = 0;
  const failed: number[] = [];
  for (const o of withAudio) {
    const rec = await getLocalAudio(o.songId);
    if (!rec?.blob) {
      // 标记还在、本地字节却找不到（存储被清过等）：属于数据不一致，明确报出来
      failed.push(o.songId);
      continue;
    }
    if (existing.get(o.songId) === rec.size) continue;
    try {
      const res = await fetch(audioUrl(undefined, `songId=${o.songId}`), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: rec.blob,
      });
      if (res.ok) uploaded += 1;
      else failed.push(o.songId);
    } catch {
      failed.push(o.songId);
    }
  }
  return { uploaded, failed };
}

/** 下载某台设备共享的某个音频；失败返回 null */
async function fetchSharedAudio(ip: string, songId: number): Promise<Blob | null> {
  try {
    const res = await fetch(audioUrl(ip, `songId=${songId}`));
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/**
 * 「当前设备 IP」查询结果（GET /share/whoami）。
 *
 * 为什么要有这个接口：浏览器读不到自己的局域网 IP（WebRTC 那条路早被隐私策略
 * 封掉），但本机代理同时知道自己的网卡地址与请求方地址，所以由它来回答。
 */
export interface WhoAmI {
  /** 请求方地址；本机回环访问时为 null（此时看 serverIps） */
  clientIp: string | null;
  /** 请求是否来自本机回环（127.0.0.1 / ::1） */
  isLoopback: boolean;
  /** 服务所在设备的非内部 IPv4 列表（形如 192.168.x.x） */
  serverIps: string[];
}

/**
 * 问一句「这台设备现在的局域网 IP 是多少」。
 *
 * 带唯一参数绕过代理内置的全局响应缓存（与 shareUrl 同理：那层 `cache('2 minutes')`
 * 会把第二次请求拦在处理器之前，IP 变了也刷不出来）；再配 cache: "no-store"，
 * 保证点「刷新」拿到的永远是新值。取不到时返回 null，由调用方给兜底文案。
 */
export async function fetchWhoAmI(): Promise<WhoAmI | null> {
  try {
    const res = await fetch(`${API_BASE}/share/whoami?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<WhoAmI>;
    return {
      clientIp: typeof data.clientIp === "string" && data.clientIp ? data.clientIp : null,
      isLoopback: data.isLoopback === true,
      serverIps: Array.isArray(data.serverIps) ? data.serverIps.filter((v) => typeof v === "string") : [],
    };
  } catch {
    // 代理没起来 / 跨域失败：返回 null，界面给「读不到」的人话说明
    return null;
  }
}

/**
 * 发布本机歌曲设置。
 * @param enabled 传 false 表示关闭共享（让服务端清掉缓存，避免残留数据继续被拉到）
 */export async function publishSongSettings(enabled: boolean): Promise<boolean> {
  try {
    const body = enabled
      ? { enabled: true, deviceName: "", overrides: getSongOverrides().map(shareable) }
      : { enabled: false };
    const res = await fetch(shareUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      /*
       * 不再静默失败。此前音频上传被服务端的「只允许本机发布」判成 403、而这里
       * 又把异常吞掉，于是表现成「设置/音频就是同步不过去」且毫无线索。
       */
      console.warn(
        "[share] 发布歌曲设置失败:",
        res.status,
        await res.text().catch(() => ""),
      );
      return false;
    }
    if (enabled) {
      const r = await publishAudios();
      if (r.failed.length) {
        console.warn("[share] 这些歌曲的替换音频上传失败，对方将拿不到音频:", r.failed);
      }
    }
    return true;
  } catch (err) {
    console.warn("[share] 发布歌曲设置异常:", err);
    return false;
  }
}

/** 拉取某台设备共享出来的歌曲设置；未共享或不可达时返回 null */
export async function fetchSharedSongSettings(ip: string): Promise<SongOverride[] | null> {
  try {
    const res = await fetch(shareUrl(ip));
    if (!res.ok) return null;
    const json = (await res.json()) as { overrides?: SongOverride[] } | null;
    const list = json?.overrides;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/**
 * 一键添加：拉取对方设置并合并到本机。
 * 合并规则：同一首歌以 updatedAt 较新的为准，不会用旧数据覆盖本机较新的设置。
 */
export async function importSharedSongSettings(
  ip: string,
): Promise<{ ok: boolean; added: number; updated: number; skipped: number; audio: number }> {
  const remote = await fetchSharedSongSettings(ip);
  if (!remote) return { ok: false, added: 0, updated: 0, skipped: 0, audio: 0 };

  await loadSongOverrides();
  const local = new Map(getSongOverrides().map((o) => [o.songId, o]));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let audio = 0;

  for (const r of remote) {
    if (!r || typeof r.songId !== "number") continue;
    const mine = local.get(r.songId);
    const newer = !mine || (mine.updatedAt ?? 0) < (r.updatedAt ?? 0);

    /*
     * 音频是否需要取回：
     *  - 对方有音频、本机没有标记 → 要取；
     *  - 设置要更新 → 一并取；
     *  - 设置不更新（本机较新），但本机标记虽在、字节其实已丢（上次没传成功、
     *    浏览器清过存储等）→ 也要补取，否则这首歌永远缺音频。
     * 之前只看 updatedAt 决定跳过，一旦第一次导入丢了音频，之后再导入都会被跳过。
     */
    let needAudio = false;
    if (r.audioName) {
      if (!mine?.audioName) {
        needAudio = true;
      } else if (newer) {
        needAudio = true;
      } else {
        const rec = await getLocalAudio(r.songId);
        if (!rec?.blob) needAudio = true;
      }
    }

    // 设置与音频都不需要动，才算跳过
    if (!newer && !needAudio) {
      skipped += 1;
      continue;
    }

    let audioName = mine?.audioName ?? "";
    let audioSize = mine?.audioSize ?? 0;
    if (needAudio && r.audioName) {
      const blob = await fetchSharedAudio(ip, r.songId);
      if (blob && blob.size > 0) {
        const file = new File([blob], r.audioName, {
          type: blob.type || "application/octet-stream",
        });
        await putLocalAudio(r.songId, file);
        audioName = r.audioName;
        audioSize = file.size;
        audio += 1;
      } else {
        // 取不到就明确置空，避免本机留下指向不存在文件的标记
        audioName = "";
        audioSize = 0;
      }
    }

    await saveSongOverride({
      songId: r.songId,
      name: newer ? (r.name ?? "") : (mine?.name ?? ""),
      artists: newer ? (r.artists ?? "") : (mine?.artists ?? ""),
      instrumental: newer ? !!r.instrumental : !!mine?.instrumental,
      lyricFormat: newer ? (r.lyricFormat ?? "lrc") : (mine?.lyricFormat ?? "lrc"),
      lyricText: newer ? (r.lyricText ?? "") : (mine?.lyricText ?? ""),
      audioName,
      audioSize,
      skipLeadingLines: newer ? (r.skipLeadingLines ?? 0) : (mine?.skipLeadingLines ?? 0),
      translationShift: newer ? (r.translationShift ?? 0) : (mine?.translationShift ?? 0),
    });
    if (mine) updated += 1;
    else added += 1;
  }

  return { ok: true, added, updated, skipped, audio };
}

/** 歌曲设置变化事件：存储层在保存/删除后派发，用于触发重新发布 */
export const SONG_SETTINGS_CHANGED = "aurora:song-settings-changed";

/**
 * 开启共享期间：监听歌曲设置变化并重新发布。
 * 返回取消函数。
 */
export function startShareSync(): () => void {
  const onChange = () => {
    void publishSongSettings(true);
  };
  window.addEventListener(SONG_SETTINGS_CHANGED, onChange);
  void publishSongSettings(true);
  return () => window.removeEventListener(SONG_SETTINGS_CHANGED, onChange);
}
