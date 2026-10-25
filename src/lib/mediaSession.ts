import type { Track } from "./mappers";
import { effectiveArtists } from "./artistOverrides";

/**
 * 锁屏 / 系统媒体面板（Media Session）集成。
 *
 * 之前完全没有这层，于是 iPhone 锁屏上只能回落到网页标题「Aurora Music」：
 * 没有封面、没有作者、没有进度条，切歌与拖拽也全部无效。
 * iOS 只有在三件事都做到时才把控件点亮：
 *   ① 设了 metadata（标题/作者/封面，封面必须是**绝对地址**）
 *   ② 注册了对应的 action handler（play/pause/上一首/下一首/seekto…）
 *   ③ 通过 setPositionState 给出合法时长与位置（否则进度条不可用）
 */

type ActionType =
  | "play"
  | "pause"
  | "stop"
  | "previoustrack"
  | "nexttrack"
  | "seekbackward"
  | "seekforward"
  | "seekto"
  | "skipad";

interface ActionDetails {
  seekTime?: number | null;
  seekOffset?: number | null;
}

/** 只声明用得到的部分，避免依赖各版本 TS 内置类型的差异 */
interface SessionLike {
  metadata: unknown;
  playbackState: "none" | "paused" | "playing";
  setActionHandler: (type: ActionType, handler: ((d: ActionDetails) => void) | null) => void;
  setPositionState?: (state?: { duration?: number; playbackRate?: number; position?: number }) => void;
}

interface MetadataInit {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string; type: string }[];
}

export interface MediaSessionActions {
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  /** 绝对跳转（秒） */
  seek: (sec: number) => void;
  stop: () => void;
}

let actions: MediaSessionActions | null = null;

/**
 * 收到锁屏 seekto 之后的「写入抑制窗口」。
 *
 * 拖动锁屏进度条时，系统会持续下发 seekto；这几秒里我们任何一次
 * metadata / positionState / playbackState 写入，都可能把滑块拽回系统已知的位置
 * —— 那正是用户说的「拖不动 / 被吸住」。所以窗口内**一律不写**。
 *
 * 注意：这是**唯一**的一处抑制逻辑，且只在收到 seekto 时才开启；
 * 应用内拖动自己的进度条不受影响。
 */
const SEEK_SUPPRESS_MS = 3_000;
let suppressWritesUntil = 0;

/**
 * 这次写入是否落在抑制窗口内。
 *
 * 是 → 返回 true，调用方**不要**再写；否 → 返回 false，照常写。
 */
function writeSuppressed(): boolean {
  return Date.now() < suppressWritesUntil;
}

/** 收到锁屏 seekto：开一个抑制窗口，之后 3 秒内不写任何媒体会话状态 */
function openSeekSuppression(): void {
  suppressWritesUntil = Date.now() + SEEK_SUPPRESS_MS;
}

/** 锁屏封面的常用方图尺寸（iOS 会挑合适的一档） */
const ARTWORK_SIZES = [96, 128, 192, 256, 384, 512];

function session(): SessionLike | null {
  if (typeof navigator === "undefined") return null;
  const s = (navigator as Navigator & { mediaSession?: SessionLike }).mediaSession;
  return s ?? null;
}

/** 相对地址转绝对地址：iOS 不接受相对 URL 作为锁屏封面 */
function toAbsolute(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

/**
 * 生成封面候选。网易云图片支持 ?param=WxH 取指定尺寸，顺手给多档；
 * 若地址里已经带了 param，就原样使用，避免拼出非法 query。
 */
function buildArtwork(picUrl?: string): MetadataInit["artwork"] {
  if (!picUrl) return [];
  const base = toAbsolute(picUrl);
  if (/[?&]param=/.test(base)) return [{ src: base, sizes: "512x512", type: "image/jpeg" }];
  const sep = base.includes("?") ? "&" : "?";
  return ARTWORK_SIZES.map((size) => ({
    src: `${base}${sep}param=${size}y${size}`,
    sizes: `${size}x${size}`,
    type: "image/jpeg",
  }));
}

function MetadataCtor(): (new (init: MetadataInit) => unknown) | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { MediaMetadata?: new (init: MetadataInit) => unknown })
    .MediaMetadata;
  return ctor ?? null;
}

/** 上一次下发的文字签名，用于避免内容没变时反复设置导致闪烁 */
let lastSignature = "";

/**
 * 设置锁屏信息。
 *
 * @param track       当前歌曲
 * @param currentLyric 当前歌词**正文**（不含翻译/音译）。有值时上行显示它、
 *                     下行显示「歌名 · 歌手」；为空（纯音乐或还没取到歌词）时
 *                     沿用原来的两行：歌名 / 歌手。
 */
export function updateMediaMetadata(track: Track | null, currentLyric?: string): void {
  const s = session();
  const Ctor = MetadataCtor();
  if (!s || !Ctor) return;
  try {
    if (!track) {
      if (lastSignature === "__none__") return;
      // 抑制窗口内不写，也**不更新签名** —— 否则窗口结束后这次内容就永远不会再下发
      if (writeSuppressed()) return;
      lastSignature = "__none__";
      s.metadata = null;
      return;
    }
    const lyric = (currentLyric ?? "").trim();
    const title = lyric || track.name || "未知歌曲";
    /*
     * 歌手：单曲设置里改过就用改后的值。
     * 这里只是**取显示文本**（只读），媒体会话的动作绑定 / 抑制窗口等逻辑一概不动。
     * 锁屏那行由 App 每 500ms 调一次本函数，所以改完歌手最多半秒就会反映到锁屏。
     */
    const artists = effectiveArtists(track.id, track.artists);
    const artist = lyric
      ? [track.name, artists].filter(Boolean).join(" · ")
      : artists || "未知歌手";
    const album = lyric ? "" : track.album || "";
    const signature = `${title}|${artist}|${album}|${track.picUrl ?? ""}`;
    // 文本没变就不重复下发：锁屏每秒重设一次会让 iOS 上出现闪动
    if (signature === lastSignature) return;
    // 同上：抑制窗口内不写、也不推进签名
    if (writeSuppressed()) return;
    lastSignature = signature;
    s.metadata = new Ctor({
      title,
      artist,
      album,
      artwork: buildArtwork(track.picUrl),
    });
  } catch {
    /*
     * 个别字段（例如 artwork 解码）不被支持时会走到这里。
     * 异常一律就地吃掉 —— 写 metadata 失败不影响播放本身。
     */
  }
}

/** 同步播放/暂停状态，锁屏的按钮图标据此变化 */
export function updateMediaPlaybackState(playing: boolean): void {
  const s = session();
  if (!s) return;
  const state = playing ? "playing" : "paused";
  if (writeSuppressed()) return;
  try {
    s.playbackState = state;
  } catch {
    /* 状态名不被支持时忽略：不影响播放本身 */
  }
}

/**
 * 同步进度。iOS 的锁屏进度条只有在 setPositionState 拿到合法数据后才可用；
 * 传非法值（duration 为 0/NaN、position 越界）会抛错并让进度条长期不可用，
 * 所以这里逐项守卫。
 */
export function updateMediaPosition(duration: number, position: number): void {
  const s = session();
  if (!s || typeof s.setPositionState !== "function") return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const pos = Math.min(Math.max(Number.isFinite(position) ? position : 0, 0), duration);
  if (writeSuppressed()) {
    return;
  }
  try {
    s.setPositionState({ duration, playbackRate: 1, position: pos });
  } catch {
    /* 非法值会被浏览器拒绝：忽略即可，播放不受影响 */
  }
}

/** 清掉进度状态（停止播放时用） */
export function clearMediaPosition(): void {
  const s = session();
  if (!s || typeof s.setPositionState !== "function") return;
  if (writeSuppressed()) return;
  try {
    s.setPositionState();
  } catch {
    /* 清空失败不影响播放，忽略 */
  }
}

/**
 * 是否**显式撤回** seekbackward / seekforward（`setActionHandler(type, null)`）。
 *
 * **结论：在 iOS 上这是二选一，不能兼得（已实机验证两次）。**
 *
 *   不碰这两个动作（本文件当前的选择）
 *     → 锁屏进度条**可拖**；代价是系统的默认「±10 秒」进退键
 *       顶掉了我们注册的 ⏮/⏭（WebKit 在这种布局下忽略 previoustrack / nexttrack）。
 *
 *   显式撤回（把下面的常量改成 true，2026-10-07 实机试过）
 *     → 锁屏恢复 ⏮/⏭；代价是**进度条立刻变回只读、拖不动**。
 *
 * 所以常量保持 false：优先保证"能拖进度条"。
 * `skipad` **不碰**（另有语义，且与布局无关）。
 */
const WITHDRAW_SEEK_ACTIONS = false;

/*
 * 关于 seekbackward / seekforward 的历史结论（**已用实机实验定论**）：
 *
 * 「显式置空 → 进度条变只读」这条**是对的**，先前我一度认为它是错误归因（理由是
 * 当时 `<audio>` 还游离在文档之外），但把 `<audio>` 挂进文档、并恢复每秒推
 * positionState 之后**再试一次**，结果依旧是"置空 → 进度条拖不动"。
 * 可见：**进度条的可拖动性依赖这两个动作处于可用状态**，与 `<audio>` 是否在文档里无关。
 *
 * 由此确定 iOS 的取舍：
 *   · 想要可拖的锁屏进度条 → 必须保留 ±10 秒这对键（⏮/⏭ 会被顶掉）；
 *   · 想要 ⏮/⏭ → 进度条只能只读。
 *
 * 另外：拖动锁屏进度条时系统会持续下发 seekto，每收到一次就开一个 3 秒的
 * 「写入抑制窗口」（见文件开头的 SEEK_SUPPRESS_MS）—— 窗口内不写 metadata /
 * positionState / playbackState，避免和用户的手抢滑块。
 */
function install(): void {
  const s = session();
  if (!s) return;
  const set = (type: ActionType, fn: (d: ActionDetails) => void) => {
    try {
      s.setActionHandler(type, fn);
    } catch {
      // Safari 支持的动作集比 Chrome 少，不支持的直接跳过
    }
  };

  /*
   * 每个处理器都包一层 try/catch。
   *
   * 在 iOS 上，任何一次动作回调抛出异常，都可能让**后续动作回调整体失效**
   * （用户看到的就是「按钮全部点不动」）。所以异常一律就地吃掉。
   */
  const guard =
    (run: () => void) =>
    (_d: ActionDetails) => {
      try {
        run();
      } catch {
        /* 就地吃掉：绝不让异常逃出动作回调 */
      }
    };

  set(
    "play",
    guard(() => {
      actions?.play();
    }),
  );
  set(
    "pause",
    guard(() => {
      actions?.pause();
    }),
  );
  set(
    "stop",
    guard(() => {
      actions?.stop();
    }),
  );
  set(
    "previoustrack",
    guard(() => {
      actions?.prev();
    }),
  );
  set(
    "nexttrack",
    guard(() => {
      actions?.next();
    }),
  );
  set("seekto", (d) => {
    try {
      if (!d || typeof d.seekTime !== "number" || !Number.isFinite(d.seekTime)) return;
      // 先开抑制窗口，再执行搜索：连「搜索这一刻自己推的那次位置」也一并被抑制
      openSeekSuppression();
      actions?.seek(d.seekTime);
    } catch {
      /* 就地吃掉：同上，异常不得逃出动作回调 */
    }
  });

  /*
   * 撤回 seekbackward / seekforward（见 WITHDRAW_SEEK_ACTIONS 的说明）。
   * 只撤回这两个，`skipad` 不碰。
   * 注意：这里传的必须是 **null**（撤回），不是函数 —— 传函数会真的把它们注册成
   * 「按固定时长跳转」，反而继续占着系统的默认按钮位。
   */
  if (WITHDRAW_SEEK_ACTIONS) {
    for (const type of ["seekbackward", "seekforward"] as const) {
      try {
        s.setActionHandler(type, null);
      } catch {
        // 极少数环境不支持该动作名，忽略即可
      }
    }
  }
}

/**
 * 重新注册一遍动作处理器（幂等，代价极小）。
 *
 * 两处必须重试的地方：
 *  1. App 启动那一刻 `navigator.mediaSession` 可能还没就绪（Safari 会延迟暴露），
 *     只装一次的话就永远装不上，锁屏于是退回系统默认的「±10 秒」键；
 *  2. Howler 每首歌都会新建 `<audio>` 元素，系统可能在媒体元素更换后重置处理器。
 * 所以换歌与开始播放时各重装一次。
 */
export function refreshMediaSessionHandlers(): void {
  install();
}

/** 绑定播放器动作，并立即注册处理器 */
export function bindMediaSessionActions(next: MediaSessionActions): void {
  actions = next;
  install();
}
