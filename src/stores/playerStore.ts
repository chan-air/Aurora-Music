import { create } from "zustand";
import { Howl, Howler } from "howler";
import type { LyricLine } from "@applemusic-like-lyrics/core";
import { netease } from "@/lib/netease";
import { loadLyricLines, forgetResolvedLyrics, getResolvedLyrics } from "@/lib/lyrics";
import { addHistory, savePlayerState, getPlayerState, getSongOverride } from "@/lib/storage";
import { getLocalAudioUrl } from "@/lib/audioStore";
import { coverColorForSong } from "@/lib/coverColorCache";
import { getNetworkQuality } from "@/lib/network";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAppStore } from "@/stores/appStore";
import type { Track } from "@/lib/mappers";

/**
 * 播放失败的提示文案，按原因分类：
 *  - network：判定为网络问题（网络质量不佳，或 Howler 报 MEDIA_ERR_NETWORK）
 *  - load   ：网络正常，但音频取不到 / 音源不可用（下架、无版权等）
 *  - play   ：音频已经加载，但播放失败
 */
export const PLAYBACK_FAILURE_MESSAGES = {
  network: "网络状态不佳，歌曲加载失败",
  load: "歌曲加载失败，资源可能下架",
  play: "音频播放失败，请稍后再试",
} as const;

/** 按当前网络状况 + Howler 错误码判断该归到哪一类 */
function classifyLoadFailure(code?: number): keyof typeof PLAYBACK_FAILURE_MESSAGES {
  // Howler 的 code 沿用 <audio> 的 MediaError：2 = MEDIA_ERR_NETWORK
  if (code === 2) return "network";
  return getNetworkQuality() === "poor" ? "network" : "load";
}

/**
 * 连续多少首"怎么都播不了"就停下来。
 *
 * 注意：这里**没有**"失败自动跳下一首"的功能（用户没要）。这个上限只用于
 * 「用户自己一首首往下点、每首都放不出来」时别再假装还能播 —— 到点停住并提示一次，
 * 免得用户以为播放器卡死、也免得每次点下一首都弹一条提示把人烦死。
 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** 连续失败到上限时的提示文案（人话，且给出下一步建议） */
const FAILURE_STREAK_MESSAGE = `连续 ${MAX_CONSECUTIVE_FAILURES} 首歌都无法播放，已停止自动播放。请检查网络，或换一首歌后点播放`;

/**
 * 连续加载失败计数。
 * 成功播放（`onplay`）或用户**主动**表达"我要听"（点播放键 / 从列表里点一首）时清零；
 * 单纯点"下一首"不清零 —— 否则一首首都放不出来时永远累计不到上限。
 */
let consecutiveFailures = 0;
/** 连续失败到上限后的提示是否已经发过（同一条失败链只提示一次） */
let failureStreakNotified = false;

/**
 * 记录一次"这一首播不了"。
 *
 * **绝不动 `wantPlay`**（除非达到连续失败上限）—— 这是"播放意图"语义的核心：
 * 一首歌下架/无版权，只说明这一首放不了，不代表用户不想听了。
 * 之前这里把 `wantPlay` 清成 false，于是紧接着点"下一首"时
 * `startPlayback(track, keepPlaying=true)` 保留了那个被污染的意图 → 只换曲目不播放。
 *
 * @param toast 这一首对应的失败文案
 */
function notePlaybackFailure(toast: string): void {
  consecutiveFailures += 1;
  usePlayerStore.setState({ playing: false });
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    // 到上限：这时才清意图（"停下"），并且整条失败链只提示一次
    wantPlay = false;
    usePlayerStore.setState({ playing: false });
    if (!failureStreakNotified) {
      failureStreakNotified = true;
      useAppStore.getState().showToast(FAILURE_STREAK_MESSAGE);
    }
    return;
  }
  useAppStore.getState().showToast(toast);
}

/** 播放真的成功 / 用户主动要听：清空连续失败计数 */
function resetFailureStreak(): void {
  consecutiveFailures = 0;
  failureStreakNotified = false;
}

/** 全局唯一的 Howl 实例，避免被序列化进 store */
let howl: Howl | null = null;

/**
 * 最近一次「播完」被处理的时刻（ms）。
 *
 * `onend` 里用它去重：恢复播放走的是"不 seek"快路径，我们自己补的 ended 监听
 * 可能与 Howler 自己挂的那条同时存在，同一次播完会触发两次 —— 不去重就会连跳两首。
 */
let lastEndedAt = 0;

export function getHowl(): Howl | null {
  return howl;
}

/** 所有创建过、尚未卸载的 Howl 实例，供自愈看门狗体检 */
const liveHowls = new Set<Howl>();

/** 当前正在播放的实例数量（正常应 ≤ 1） */
export function countPlayingHowls(): number {
  let n = 0;
  liveHowls.forEach((h) => {
    try {
      if (h.playing()) n++;
    } catch {
      /* 实例可能已销毁，忽略 */
    }
  });
  return n;
}

/**
 * 自愈：若发现多个实例同时播放，只保留当前实例，其余强制停止并卸载。
 * @returns 是否修复了问题
 */
export function enforceSinglePlayback(): boolean {
  const playing: Howl[] = [];
  liveHowls.forEach((h) => {
    try {
      if (h.playing()) playing.push(h);
    } catch {
      /* ignore */
    }
  });
  if (playing.length <= 1) return false;
  playing.forEach((h) => {
    if (h === howl) return;
    try {
      h.stop();
      h.unload();
    } catch {
      /* ignore */
    }
    liveHowls.delete(h);
  });
  return true;
}

/**
 * 用户的播放意图：只有点击播放/暂停键才会改变。
 *
 * **失败、切歌、加载、缓冲都不能把它清成 false** —— 一首歌下架/无版权只说明
 * 这一首放不了，不代表用户不想听了。历史 bug 就是"拿不到音频地址时顺手把
 * wantPlay 置 false"，于是紧接着点"下一首"只换曲目、不播放。
 * （唯一例外：连续 MAX_CONSECUTIVE_FAILURES 首失败后主动停下，见 notePlaybackFailure。）
 */
let wantPlay = false;
/** 切歌请求序号：加载期间若又发起新切歌，旧请求作废 */
let loadToken = 0;

/** 预加载缓存：歌曲 id -> 音频地址 / 歌词 / 已预热封面 */
const preloadedUrls = new Map<number, string>();
const preloadedLyrics = new Map<number, LyricLine[]>();
const preloadedCovers = new Set<number>();
/** 正在按需加载歌词的歌曲，避免重复请求 */
const loadingLyrics = new Set<number>();
/**
 * 已经尝试过按需加载、且**失败**了的歌曲。
 *
 * 没有它的时候：加载失败不会写进 preloadedLyrics（`has()` 一直为 false），
 * 而 App 里那个 500ms 的定时器每拍都会调一次 ensureLyricsCached ——
 * 于是「没有歌词 / 接口失败」的歌会**每秒发起两次网络请求**（TTML + 网易云），
 * 一直打下去。这里记下来，失败就不再用定时器重试。
 */
const failedLyrics = new Set<number>();

export function getPreloadedLyrics(id: number): LyricLine[] | undefined {
  /*
   * 优先返回「已定稿」的那一份。
   *
   * 为什么不能只用 preloadedLyrics：预加载常常在**网易云先回**时就写入了缓存
   * （那时 TTML 还在飞），而 TTML 到达后会把"已定稿歌词"升级成 TTML 版本。
   * 如果这里读的是旧的那份，切到这首歌时首帧就是 LRC，要等广播再替换一次 ——
   * 正是需求里要避免的。resolvedLyrics 是歌词模块里唯一的"最终答案"，
   * 这里只做"有升级版就用升级版"的读取，不额外维护第二份状态。
   */
  return getResolvedLyrics(id) ?? preloadedLyrics.get(id);
}

/**
 * 确保某首歌的歌词进入缓存。
 *
 * 锁屏上行要用歌词正文，而歌词原本只在「预加载」开启时才填缓存；
 * 关掉预加载的用户就会没有歌词可显示。这里做一次按需兜底：
 * 已缓存或正在加载时直接返回，失败也不重试（避免每 500ms 反复打接口）。
 */
export function ensureLyricsCached(trackId: number): void {
  if (preloadedLyrics.has(trackId) || loadingLyrics.has(trackId) || failedLyrics.has(trackId)) return;
  const st = usePlayerStore.getState();
  const track =
    st.current?.id === trackId ? st.current : st.queue.find((t) => t.id === trackId);
  if (!track) return;
  loadingLyrics.add(trackId);
  // force：这是"当前曲目"的正式加载（锁屏上行要用），必须无视预加载留下的失败记账
  void loadLyricLines(trackId, () => netease.lyric(trackId), { force: true })
    .then((lines) => {
      // 空结果同样写进缓存：给锁屏用的就是"这首没有歌词"，不该反复重试
      preloadedLyrics.set(trackId, lines);
      if (lines.length === 0) failedLyrics.add(trackId);
    })
    .catch(() => {
      failedLyrics.add(trackId);
    })
    .finally(() => {
      loadingLyrics.delete(trackId);
    });
}

/** 手动改了歌词 / 纯音乐标记后清空歌词预加载缓存，避免继续用旧歌词 */
export function clearPreloadedLyrics(): void {
  preloadedLyrics.clear();
  // 失败标记也要一起清：用户刚手动改了歌词，必须允许重新加载一次
  failedLyrics.clear();
  // 「已定稿歌词」同样要丢：否则 loadLyricLines 会直接命中旧的那一份
  forgetResolvedLyrics();
}

/** 替换 / 还原本地音频后清掉该曲的音频缓存 */
export function clearPreloadedAudio(id?: number): void {
  if (id === undefined) preloadedUrls.clear();
  else preloadedUrls.delete(id);
}

/** 调试用：查看预加载缓存状态 */
/**
 * 搜索目标（秒）。提交搜索后，音频（尤其 html5 流式）需要一点时间才真的跳过去，
 * 这段时间里 howl.seek() 仍返回**旧位置** —— 任何照它刷新的界面都会
 * 「先跳回原处、再跳到目标」。所以在过渡期内对外统一报告目标值，
 * 等音频追上（或超时兜底）后再交还真实位置。
 *
 * 放在播放器层是为了让**所有**消费方受益：应用内进度条、沉浸页、锁屏进度条。
 */
let pendingSeek: { target: number; at: number } | null = null;
/** 音频位置与目标的差值小于它，即视为已经追上 */
const SEEK_SETTLE_TOLERANCE_SEC = 0.35;
/** 兜底：超过这段时间仍未追上（例如音频卡住）就不再压着 */
const SEEK_SETTLE_TIMEOUT_MS = 1500;

/** 记录一次搜索，供 getPlaybackPosition 在过渡期内报告目标值 */
function markPendingSeek(targetSec: number): void {
  pendingSeek = { target: targetSec, at: Date.now() };
}

/**
 * 当前播放位置（秒）。锁屏进度条（Media Session）与应用内进度条都用它，
 * 因此这里统一抹平「搜索后音频尚未追上」的过渡期。
 */
export function getPlaybackPosition(): number {
  if (!howl) {
    pendingSeek = null;
    return 0;
  }
  try {
    const actual = howl.seek();
    const pos = typeof actual === "number" && Number.isFinite(actual) ? actual : 0;
    if (pendingSeek) {
      const settled =
        Math.abs(pos - pendingSeek.target) < SEEK_SETTLE_TOLERANCE_SEC ||
        Date.now() - pendingSeek.at > SEEK_SETTLE_TIMEOUT_MS;
      if (settled) pendingSeek = null;
      else return pendingSeek.target;
    }
    return pos;
  } catch {
    return 0;
  }
}

/**
 * 排查用：把"当前/上一首/下一首 + 预加载队列状态"一次性取出来。
 * 只读快照，不参与任何业务逻辑；专门用来核对"到底预加载了哪几首"。
 */
export function getPreloadDebugSnapshot(): {
  currentId: number | null;
  currentIndex: number;
  queueIds: number[];
  neighbourIds: number[];
  queued: number;
  active: number;
  limit: number;
  cachedLyricIds: number[];
  cachedUrlIds: number[];
} {
  const { queue, currentIndex, current } = usePlayerStore.getState();
  const n = queue.length;
  const idx: number[] = [];
  if (n > 0 && currentIndex >= 0 && currentIndex < n) {
    idx.push(currentIndex);
    if (n > 1) {
      idx.push((currentIndex - 1 + n) % n);
      idx.push((currentIndex + 1) % n);
    }
  }
  return {
    currentId: current?.id ?? null,
    currentIndex,
    queueIds: queue.map((t) => t.id),
    neighbourIds: idx.map((i) => queue[i]?.id).filter((v): v is number => typeof v === "number"),
    queued: preloadQueue.length,
    active: preloadActive,
    limit: PRELOAD_CONCURRENCY,
    cachedLyricIds: [...preloadedLyrics.keys()],
    cachedUrlIds: [...preloadedUrls.keys()],
  };
}

/** 调试用：查看预加载小队列的状态（只读，不影响任何行为） */
export function getPreloadQueueInfo(): {
  queued: number;
  active: number;
  limit: number;
  keep: number[];
} {
  return {
    queued: preloadQueue.length,
    active: preloadActive,
    limit: PRELOAD_CONCURRENCY,
    keep: [...preloadKeepIds],
  };
}

export function getPreloadCacheInfo(): {
  urls: number[];
  lyrics: number[];
  covers: number[];
} {
  return {
    urls: [...preloadedUrls.keys()],
    lyrics: [...preloadedLyrics.keys()],
    covers: [...preloadedCovers],
  };
}

let preloadTimer: ReturnType<typeof setInterval> | null = null;

function stopPreloadCheck() {
  if (preloadTimer) clearInterval(preloadTimer);
  preloadTimer = null;
}

/**
 * 播放中的兜底检查：临近结尾时再预热一次前后两首。
 * 正常切歌时就已经预热好了，这里只用于队列被改动后的补充。
 */
function startPreloadCheck() {
  stopPreloadCheck();
  preloadTimer = setInterval(() => {
    if (!howl || !howl.playing()) return;
    const dur = howl.duration() as number;
    const pos = howl.seek() as number;
    if (dur > 0 && dur - pos <= 10) {
      preloadNeighbors();
      stopPreloadCheck(); // 只触发一次
    }
  }, 500);
}

/**
 * 预热单曲：**歌词（TTML + 网易云两条源都取）** + 音频地址 + 封面图。
 *
 * 关于歌词：以前这里只把结果丢进预加载缓存、且不保证 TTML 那条通道被走到；
 * 现在统一走 `loadLyricLines`（它内部并行取 TTML 与网易云、TTML 优先并写入
 * 「已定稿」缓存），于是切到这首歌时**首帧就是 TTML**，不会再先闪一下 LRC。
 */
async function preloadTrack(track: Track): Promise<void> {
  // 歌词（最贵、收益最大的一条，先发）
  if (!preloadedLyrics.has(track.id) && !failedLyrics.has(track.id)) {
    void loadLyricLines(track.id, () => netease.lyric(track.id))
      .then((lines) => {
        if (lines.length === 0) failedLyrics.add(track.id);
        // 这里存的是"刚解析出来"的那一份，可能还是 LRC；
        // 真正对外提供时由 getPreloadedLyrics 优先取"已定稿"（TTML 到达后会被升级）
        preloadedLyrics.set(track.id, getResolvedLyrics(track.id) ?? lines);
      })
      .catch(() => {
        failedLyrics.add(track.id);
      });
  }
  // 音频地址（决定切歌延迟的关键；本地替换音频优先）
  if (!preloadedUrls.has(track.id)) {
    let url: string | null | undefined;
    if (getSongOverride(track.id)?.audioName) {
      url = await getLocalAudioUrl(track.id);
    }
    if (!url) {
      const item = await netease.songUrl(track.id).catch(() => null);
      url = item?.url;
    }
    if (url) preloadedUrls.set(track.id, url);
  }
  // 封面图：提前让浏览器缓存，切歌时封面/流动背景秒出
  if (track.picUrl && !preloadedCovers.has(track.id)) {
    preloadedCovers.add(track.id);
    const img = new Image();
    img.decoding = "async";
    img.src = track.picUrl;
  }
}

/* ---------------- 预加载小并发队列 ----------------
 *
 * 为什么需要它：预加载一首歌要打 3 个接口（歌词两条源 + 歌曲地址），
 * 一次预加载"当前 + 上一首 + 下一首"就是 9 个请求；快速连按切歌时旧的那批
 * 还没落地、新的一批又来了 —— 全放出去会把连接池占满，反而拖慢**当前这首歌**
 * 的歌词与音频。所以：
 *   · 同时最多 PRELOAD_CONCURRENCY 首在预加载；
 *   · 每次重算邻居都换一个 token，队列里属于旧 token 的任务在开跑前直接丢弃
 *     （并发中的那些没法中断，但它们落地后只是多填一份缓存，不影响正确性）。
 */
const PRELOAD_CONCURRENCY = 2;
const preloadQueue: { track: Track; token: object }[] = [];
let preloadToken: object = {};
let preloadActive = 0;

/** 当前该预加载的歌曲 id 集合（每次重算邻居时更新） */
let preloadKeepIds = new Set<number>();

/** 这首歌现在还需要预加载吗（切歌 / 关开关 / 队列变化后不再需要就丢弃） */
function shouldPreload(id: number): boolean {
  if (!useSettingsStore.getState().preloadEnabled) return false;
  if (preloadKeepIds.has(id)) return true;
  // 正在播的那首永远可以做（按需兜底，不算"过期"）
  return usePlayerStore.getState().current?.id === id;
}

function drainPreloadQueue(): void {
  while (preloadActive < PRELOAD_CONCURRENCY && preloadQueue.length > 0) {
    const job = preloadQueue.shift();
    if (!job) break;
    // 与"当前曲目"共用同一套去重：已在缓存 / 失败过 / 正在预加载中的跳过
    if (job.token !== preloadToken || !shouldPreload(job.track.id)) continue;
    if (preloadedLyrics.has(job.track.id) && preloadedUrls.has(job.track.id)) continue;
    preloadActive += 1;
    void preloadTrack(job.track)
      .catch(() => {})
      .finally(() => {
        preloadActive -= 1;
        drainPreloadQueue();
      });
  }
}

function enqueuePreload(track: Track, front = false): void {
  if (!useSettingsStore.getState().preloadEnabled) return;
  // 同一首不重复排队；队列里已有的旧 token 任务不用清，出队时会自己丢掉
  if (preloadQueue.some((j) => j.track.id === track.id && j.token === preloadToken)) return;
  if (front) preloadQueue.unshift({ track, token: preloadToken });
  else preloadQueue.push({ track, token: preloadToken });
  drainPreloadQueue();
}

/**
 * 预加载「当前歌曲」的上一首 / 下一首的全部信息（**歌词含 TTML**、音频地址、封面），
 * 并清掉与这三首无关的缓存，避免无限增长。
 *
 * 触发时机：当前曲目变化（startPlayback 末尾）与临近结尾的兜底检查会调它；
 * **不在渲染里调用**。邻居集合没变时直接返回，不做任何重复工作。
 */
export function preloadNeighbors(): void {
  if (!useSettingsStore.getState().preloadEnabled) {
    // 关掉预加载：把还没开跑的任务全部作废，避免"关了还偷偷在下载"
    preloadToken = {};
    preloadQueue.length = 0;
    preloadKeepIds = new Set<number>();
    return;
  }
  const { queue, currentIndex } = usePlayerStore.getState();
  if (queue.length === 0 || currentIndex < 0 || currentIndex >= queue.length) return;

  const n = queue.length;
  const keepIdx = new Set<number>([currentIndex]);
  if (n > 1) {
    keepIdx.add((currentIndex - 1 + n) % n);
    keepIdx.add((currentIndex + 1) % n);
  }

  const keepIds = new Set<number>();
  keepIdx.forEach((i) => {
    const t = queue[i];
    if (t) keepIds.add(t.id);
  });

  // 邻居集合与上次一模一样（例如 500ms 兜底检查又调了一次）：不再重排队列
  const same =
    keepIds.size === preloadKeepIds.size && [...keepIds].every((id) => preloadKeepIds.has(id));
  if (same) return;

  // 换一个 token：队列里属于上一批的任务在开跑前会被丢弃
  preloadToken = {};
  preloadKeepIds = keepIds;

  keepIdx.forEach((i) => {
    const t = queue[i];
    if (!t) return;
    // 当前这首插到队首：它有更大的概率马上要用到，永远优先于邻居
    if (i === currentIndex) enqueuePreload(t, true);
    else enqueuePreload(t);
  });

  // 只保留当前 / 上一首 / 下一首的缓存
  for (const id of [...preloadedUrls.keys()]) if (!keepIds.has(id)) preloadedUrls.delete(id);
  for (const id of [...preloadedLyrics.keys()]) if (!keepIds.has(id)) preloadedLyrics.delete(id);
  for (const id of [...preloadedCovers]) if (!keepIds.has(id)) preloadedCovers.delete(id);
}

interface PlayerState {
  queue: Track[];
  currentIndex: number;
  current: Track | null;
  playing: boolean;
  duration: number;
  volume: number;
  loading: boolean;
  playTrack: (track: Track, queue?: Track[]) => Promise<void>;
  playNext: (track: Track) => Promise<void>;
  appendToQueue: (track: Track) => Promise<void>;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (sec: number) => void;
  setVolume: (v: number) => void;
  reload: () => void;
  stop: () => void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const { queue, currentIndex, current, volume } = usePlayerStore.getState();
    void savePlayerState({ queue, currentIndex, current, volume });
  }, 400);
}

/** 启动时恢复上次的队列 / 歌曲 / 音量（不自动播放） */
export async function restorePlayerState(): Promise<void> {
  const snap = await getPlayerState();
  if (!snap) return;
  usePlayerStore.setState({
    queue: snap.queue ?? [],
    currentIndex: snap.currentIndex ?? -1,
    current: snap.current ?? null,
    volume: typeof snap.volume === "number" ? snap.volume : 0.8,
  });
  if (howl && typeof snap.volume === "number") howl.volume(snap.volume);
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  currentIndex: -1,
  current: null,
  playing: false,
  duration: 0,
  volume: 0.8,
  loading: false,

  playTrack: async (track, queue) => {
    if (queue && queue.length) {
      const idx = queue.findIndex((t) => t.id === track.id);
      set({ queue, currentIndex: idx >= 0 ? idx : 0 });
    }
    await startPlayback(track);
    schedulePersist();
  },

  playNext: async (track) => {
    const { queue, currentIndex } = get();
    if (!queue.length) {
      set({ queue: [track], currentIndex: 0 });
    } else {
      const insertAt = Math.max(0, Math.min(currentIndex + 1, queue.length));
      const nextQueue = [...queue];
      nextQueue.splice(insertAt, 0, track);
      set({ queue: nextQueue, currentIndex: insertAt });
    }
    await startPlayback(track);
    schedulePersist();
  },

  appendToQueue: async (track) => {
    const { queue } = get();
    if (!queue.length) {
      set({ queue: [track], currentIndex: 0 });
    } else {
      const nextQueue = [...queue, track];
      set({ queue: nextQueue, currentIndex: nextQueue.length - 1 });
    }
    await startPlayback(track);
    schedulePersist();
  },

  toggle: () => {
    wantPlay = !wantPlay;
    if (wantPlay) {
      // 用户主动点"播放"：重新开始计失败链（否则连败 3 首后永远停在"停下"状态）
      resetFailureStreak();
    }
    set({ playing: wantPlay });
    if (!howl) {
      // 尚未加载音频（例如刚恢复上次的播放状态）：按播放需要重新加载当前歌曲
      const { current } = get();
      if (wantPlay && current) void startPlayback(current, true);
      return;
    }
    if (wantPlay) {
      /*
       * 恢复播放：优先走「不重新 seek」的快路径（见 resumeWithoutReseek 的说明）。
       * 它失败时再退回 Howler 的 play() —— 后者会重新赋值 currentTime，
       * 换来一次管线冲刷，但至少能出声。
       */
      if (!howl.playing() && !resumeWithoutReseek(howl)) howl.play();
    } else {
      howl.pause();
    }
  },

  next: () => {
    const { queue, currentIndex } = get();
    if (!queue.length) return;
    const i = (currentIndex + 1) % queue.length;
    set({ currentIndex: i });
    void startPlayback(queue[i], true);
    schedulePersist();
  },

  prev: () => {
    const { queue, currentIndex } = get();
    if (!queue.length) return;
    const i = (currentIndex - 1 + queue.length) % queue.length;
    set({ currentIndex: i });
    void startPlayback(queue[i], true);
    schedulePersist();
  },

  seek: (sec) => {
    // 先记目标：此后到音频真正追上之前，对外报告的都是目标值
    markPendingSeek(sec);
    if (howl) howl.seek(sec);
  },

  setVolume: (v) => {
    set({ volume: v });
    if (howl) howl.volume(v);
    schedulePersist();
  },

  /** 用（可能已替换的）音频重新加载当前歌曲，保持播放 / 暂停状态 */
  reload: () => {
    const { current } = get();
    if (current) void startPlayback(current, true);
  },

  stop: () => {
    wantPlay = false;
    pendingSeek = null;
    set({ playing: false });
    if (howl) howl.stop();
    stopPreloadCheck();
  },
}));

/**
 * 从音频地址里取扩展名（忽略 query / hash）。
 * 拿不到就返回空串 —— 调用方会退回到默认格式。
 */
function extFromUrl(u: string): string {
  if (!/^https?:/i.test(u)) return "";
  const path = u.split("?")[0].split("#")[0];
  const m = /\.([a-z0-9]{2,5})$/i.exec(path);
  return m ? m[1].toLowerCase() : "";
}

/**
 * 隐藏容器：把正在播放的 `<audio>` 挂进文档时用的落脚点（只建一次）。
 *
 * 用 position:fixed + 0 尺寸 + overflow:hidden 把它藏起来，
 * **不设 display:none**（那会让元素不再被渲染，风险更高），也不设 controls、不碰音量。
 */
let audioHost: HTMLDivElement | null = null;

function audioHostEl(): HTMLDivElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  if (audioHost && audioHost.isConnected) return audioHost;
  try {
    const el = document.createElement("div");
    el.setAttribute("data-aurora-audio-host", "");
    el.style.position = "fixed";
    el.style.top = "0";
    el.style.left = "0";
    el.style.width = "0";
    el.style.height = "0";
    el.style.overflow = "hidden";
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    document.body.appendChild(el);
    audioHost = el;
    return el;
  } catch {
    return null;
  }
}

/**
 * 把 Howler html5 正在用的 `<audio>` 节点**挂进文档**。
 *
 * 为什么要挂：Howler 的 html5 模式取的是 `Howler._obtainHtml5Audio()` 返回的
 * **游离** `new Audio()`（从不出现在 document 里）。
 * 游离节点足以把「现在播什么」送进系统媒体面板，但 iOS/WebKit 疑似只有在文档里
 * **有已挂载的媒体元素**时才把锁屏上的动作（播放/暂停/拖动进度…）回传给网页
 * —— 实机现象正是「锁屏能看到歌词与标题，但按钮和进度条全都点不动/拖不动」。
 *
 * 安全性：把已在播放的媒体元素换一个父节点**不会**打断播放、不会重新加载、不改 src。
 * 取不到节点（Howler 内部结构变化等）就静默跳过 —— 绝不允许挂载失败影响播放。
 *
 * @returns 是否已挂在文档里
 */
function mountHtml5AudioNode(h: Howl): boolean {
  try {
    // 设置页「锁屏兼容（进阶）」的开关：关掉就不挂（游离节点收不到锁屏动作回调）
    if (useSettingsStore.getState().lockMountAudio === false) return false;
    const node = (h as unknown as { _sounds?: { _node?: unknown }[] })._sounds?.[0]?._node;
    if (!(node instanceof HTMLAudioElement)) return false;
    if (node.parentNode) return true;
    const host = audioHostEl();
    if (!host) return false;
    host.appendChild(node);
    /*
     * 同一个容器里只留当前这一个 <audio>：Howler 会复用池里的节点（最多 10 个），
     * 换歌久了容器里可能攒下好几个。把旧的移出文档对它们毫无影响（要用时会被再次挂上），
     * 但容器里的媒体元素越干净，判据越清楚。
     */
    const others = host.querySelectorAll("audio");
    others.forEach((el) => {
      if (el !== node) {
        try {
          host.removeChild(el);
        } catch {
          /* 忽略：清理失败无所谓 */
        }
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** 取当前 Howl 实例的 <audio> 节点（取不到返回 null） */
function currentNode(): HTMLAudioElement | null {
  try {
    const node = (howl as unknown as { _sounds?: { _node?: unknown }[] } | null)?._sounds?.[0]?._node;
    return node instanceof HTMLAudioElement ? node : null;
  } catch {
    return null;
  }
}

/**
 * 立刻按「锁屏兼容（进阶）」的设置应用「挂载 / 不挂载」，切换开关时调用，无需刷新。
 *
 * 关闭时把节点**移出文档**（恢复"游离"状态）—— 移出不会打断播放、不会重新加载、不改 src，
 * 所以用户可以在播放中来回切换，直接在锁屏上对比两种行为。
 * 注意：默认是挂载（不挂载会收不到锁屏的动作回调，已实测）。
 *
 * @returns 当前是否处于「已挂载」状态
 */
export function applyAudioMountSetting(): boolean {
  if (!howl) return false;
  if (useSettingsStore.getState().lockMountAudio !== false) return mountHtml5AudioNode(howl);
  try {
    const node = currentNode();
    if (node && node.parentNode) node.remove();
  } catch {
    /* 忽略：移出失败不影响播放 */
  }
  return false;
}

/** Howler 内部结构里这条快路径会用到的字段（取不到的字段一律当"不可用"处理） */
type Html5SoundInternals = {
  _id?: number;
  _node?: unknown;
  _paused?: boolean;
  _ended?: boolean;
  _seek?: number;
  /** 我们自己挂的 ended 监听（用于去重，Howler 内部没有这个字段） */
  __auroraEnded?: EventListener;
};

/**
 * **恢复播放时不要重新 seek。**
 *
 * Howler 的 html5 分支在 `play()` 里会无条件执行 `node.currentTime = sound._seek`
 * （见 `dist/howler.js` 的 playHtml5）。哪怕目标位置就是暂停时的位置，Chrome 也会
 * 当成一次真正的 seek —— 实测每次「暂停 → 播放」都会派发
 * `seeking → waiting → seeked → playing`：解码器被冲刷、音频管线重新预热，
 * 声音要晚几十毫秒才出来，而 `<audio>.currentTime` 立刻从暂停点继续走。
 *
 * 于是**每按一次暂停/播放，声音就比媒体时钟晚一点点**；按得越频繁，这个差值叠得越多，
 * 表现就是「歌词越放越比音频快」（歌词是照 `howl.seek()` 推的）。
 *
 * 这里绕开 Howler 的 `play()`：直接让元素 `play()`（不碰 `currentTime`），
 * 再把 Howler 的记账字段（`_paused` / `_ended` / `_seek`）对齐到元素的真实状态。
 *
 * 任何一步不成立（不是 html5、没有元素、已经播完、数据没就绪）都返回 false，
 * 交给原来的 `howl.play()` —— 绝不为了一条快路径把"放不出声音"做出来。
 *
 * @returns 是否已经用"不 seek"的方式恢复
 */
function resumeWithoutReseek(h: Howl): boolean {
  try {
    const internals = h as unknown as {
      _webAudio?: boolean;
      _sounds?: Html5SoundInternals[];
      _ended?: (sound: Html5SoundInternals) => void;
    };
    // Web Audio 模式没有这段 seek 逻辑，不碰
    if (internals._webAudio) return false;

    const sound = internals._sounds?.[0];
    const node = sound?._node;
    if (!sound || !(node instanceof HTMLAudioElement)) return false;
    // 已经在播 / 已播完 / 数据还没到位：都走 Howler 原路径
    if (!node.paused || node.ended) return false;
    if (node.readyState < 2) return false;

    // 记账对齐：位置、暂停位、结束位
    sound._paused = false;
    sound._ended = false;
    sound._seek = node.currentTime;

    /*
     * Howler 的 'ended' 监听是它在 playHtml5 里挂的，pause 时**不会**摘掉，
     * 所以正常暂停→恢复时它还在。但如果这个实例从没走过 playHtml5
     * （加载期间就被暂停了），就没有任何监听 —— 播完不会触发 onend，
     * 自动下一首会失灵。所以这里补一个自己的，并保证同一时刻只有一个。
     */
    if (sound.__auroraEnded) node.removeEventListener("ended", sound.__auroraEnded);
    const onEnded: EventListener = () => {
      node.removeEventListener("ended", onEnded);
      sound.__auroraEnded = undefined;
      // 实例已经被换掉（换歌了）：这条监听只是残留在复用的节点上，什么都不做
      if (howl !== h) return;
      try {
        internals._ended?.(sound);
      } catch {
        /* 内部方法签名变化时不至于炸掉播放 */
      }
    };
    sound.__auroraEnded = onEnded;
    node.addEventListener("ended", onEnded);

    const started = node.play();
    if (started && typeof started.catch === "function") {
      started.catch(() => {
        // 自动播放被拦 / 元素不可播：把记账退回去，让 Howler 原路径接手
        node.removeEventListener("ended", onEnded);
        sound.__auroraEnded = undefined;
        sound._paused = true;
        try {
          h.play();
        } catch {
          /* ignore */
        }
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 彻底停用当前 Howl 实例，并用 Howler.stop() 兜底清掉所有残留声音，
 * 避免出现两首歌同时播放。
 *
 * 注意：必须先 `off()` 摘掉监听再销毁，否则旧实例的 onstop 会把 playing
 * 冲成 false，导致暂停/播放键在切歌时自己跳一下。
 *
 * 失败分支也要调它：否则"切到一首放不出来的歌"时，**上一首的音频还在响**，
 * 而界面已经显示新曲目 —— currentTrack 与实际声音不一致。
 */
function disposeCurrentHowl(): void {
  const old = howl;
  howl = null;
  if (old) {
    try {
      old.off();
      old.stop();
      old.unload();
    } catch {
      /* ignore */
    }
    liveHowls.delete(old);
  }
  Howler.stop();
}

/**
 * 加载某首歌（不含队列操作）。
 * @param keepPlaying 是否保持当前播放/暂停意图（切歌传 true）；false 表示强制播放（点歌用）
 */
async function startPlayback(track: Track, keepPlaying = false): Promise<void> {
  const token = ++loadToken;
  if (!keepPlaying) {
    wantPlay = true;
    // 用户从列表里主动点了一首歌：这是明确的"我要听"，重新开始计失败链
    resetFailureStreak();
  }

  // 不再把 loading 置 true：图标只反映播放/暂停意图，切歌时不会闪成转圈
  usePlayerStore.setState({
    current: track,
    duration: track.duration || 0,
    playing: wantPlay,
  });

  // 音频地址优先级：本地替换音频 → 预加载缓存 → 在线获取
  // （只有存在本地替换时才走异步 IndexedDB 查询，普通歌曲切歌依旧是同步的）
  let url: string | null | undefined;
  if (getSongOverride(track.id)?.audioName) {
    url = await getLocalAudioUrl(track.id);
  }
  if (!url) url = preloadedUrls.get(track.id);
  if (!url) {
    const item = await netease.songUrl(track.id).catch(() => null);
    url = item?.url;
  }
  if (token !== loadToken) return; // 加载期间又切歌了，交给新的加载流程
  if (!url) {
    /*
     * 这一首放不了（下架 / 无版权 / 地址解析失败）。
     *
     * 关键：**不碰 wantPlay** —— 用户"还想听"的意图必须保留，这样紧接着点
     * 「下一首」时 keepPlaying=true 依然成立，下一首会正常自动播放。
     * 同时把旧实例清掉，避免上一首的音频继续响（界面/声音不一致）。
     */
    disposeCurrentHowl();
    notePlaybackFailure(PLAYBACK_FAILURE_MESSAGES[classifyLoadFailure()]);
    return;
  }

  disposeCurrentHowl();

  // 所有事件都只对"当前实例"生效，避免过期实例改动播放状态
  //
  /*
   * 关于 format：**必须显式给**，不能让 Howler 从地址里猜。
   *
   * Howler 在没有 format 时会拿 URL 尾部当扩展名去查 self._codecs：
   *   ext = url.split(".").pop()
   *   self._codecs[ext] === undefined → 判定为不兼容 → emit('loaderror', 'No file extension was found…')
   *
   * 两种情况都会踩：
   *   1) 本地替换音频是 blob:http://host/uuid，压根没有扩展名；
   *   2) 在线地址里有一部分是网易云的跳转形式（/song/media/outer/url?id=…），同样没有扩展名
   *      —— 平时直链带 .mp3 所以没暴露，遇到这类歌曲就直接"加载失败"。
   * 所以这里按「本地文件名 → 地址扩展名 → mp3（接口默认等级返回的就是 mp3）」依次取，
   * 永远给一个明确值。
   */
  const localAudioName = getSongOverride(track.id)?.audioName ?? "";
  const blobExt =
    url.startsWith("blob:") && localAudioName.includes(".")
      ? localAudioName.split(".").pop()!.toLowerCase()
      : "";
  const audioExt = blobExt || extFromUrl(url) || "mp3";
  const next = new Howl({
    src: [url],
    format: [audioExt],
    html5: true,
    volume: usePlayerStore.getState().volume,
    onplay: () => {
      if (howl !== next) return;
      wantPlay = true;
      // 真的播出来了：失败链清零
      resetFailureStreak();
      usePlayerStore.setState({ playing: true });
      // 开始播放后再确认一次已挂进文档（Safari 上部分场景节点是延迟就绪的）
      mountHtml5AudioNode(next);
    },
    /*
     * 暂停 / 停止只更新界面状态，**不改播放意图**。
     *
     * 用户主动暂停走 toggle()，那里已经把 wantPlay 置 false 了；
     * 而这两个事件也可能由"浏览器自己"触发（缓冲中断、媒体元素被替换等），
     * 若在这里清意图，就会出现"明明是网络抖动，却被当成用户不想听了"，
     * 进而让下一次切歌不自动播放。
     */
    onpause: () => {
      if (howl !== next) return;
      usePlayerStore.setState({ playing: false });
    },
    onstop: () => {
      if (howl !== next) return;
      usePlayerStore.setState({ playing: false });
    },
    onend: () => {
      if (howl !== next) return;
      // 去重：见 lastEndedAt 的说明（同一次播完可能被两条 ended 监听各报一次）
      const now = Date.now();
      if (now - lastEndedAt < 1500) return;
      lastEndedAt = now;
      usePlayerStore.getState().next();
    },
    onload: () => {
      if (howl !== next) return;
      usePlayerStore.setState({ duration: next.duration() || track.duration || 0 });
      // 音频元数据就绪后再确认一次已挂进文档
      mountHtml5AudioNode(next);
    },
    onloaderror: (_id, err) => {
      if (howl !== next) return;
      /*
       * 同样**不碰 wantPlay**：地址拿到了但音频取不回来（CDN 拒绝、格式不支持…）
       * 也只是"这一首放不了"，不该把用户想听歌的意图一起清掉。
       * 把当前实例清干净，免得下一首继承"失败中"的挂起状态。
       */
      usePlayerStore.setState({ playing: false });
      // 把真实错误打出来，避免只能靠猜（Howler 的 code 沿用 MediaError：2=网络，4=源不可用）
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: number }).code
          : undefined;
      console.warn("[player] 音频加载失败", { src: url, format: audioExt, code, err });
      if (localAudioName) {
        // 本地替换音频是另一回事（文件格式不被支持等），单独提示更有指导性
        notePlaybackFailure(`本地替换音频无法播放（${localAudioName}），请换一个格式`);
        return;
      }
      notePlaybackFailure(PLAYBACK_FAILURE_MESSAGES[classifyLoadFailure(code)]);
    },
    onplayerror: (_id, err) => {
      if (howl !== next) return;
      /*
       * 自动播放被浏览器拦截时，Howler 的 AudioContext 处于 suspended，
       * 这种情况下面注册的 unlock 重试能救回来 —— 不算播放失败，不打扰用户。
       * 其余（已解锁仍播不动）才提示「音频播放失败」。
       */
      const blockedByAutoplay = Howler.ctx?.state === "suspended";
      if (!blockedByAutoplay) {
        console.warn("[player] 音频播放失败", { src: url, err });
        useAppStore.getState().showToast(PLAYBACK_FAILURE_MESSAGES.play);
      }
      next.once("unlock", () => {
        if (howl === next && wantPlay) next.play();
      });
    },
  });
  liveHowls.add(next);
  howl = next;
  /*
   * 把新实例的 <audio> 挂进文档：Howler 的 html5 节点是游离的 new Audio()，
   * 不挂进文档时 iOS 很可能收得到信息、却收不到锁屏上的操作回传（见 mountHtml5AudioNode）。
   * 每首歌都是新的 Howl，所以每次都要重新挂。
   */
  mountHtml5AudioNode(next);
  // 新实例没有任何待追的搜索目标
  pendingSeek = null;

  // 以当前「播放意图」为准：若加载期间用户点了暂停，这里就不再自动播放；
  // 已在播放则不重复 play()（Howler 重复 play 会叠加出第二份声音）
  if (wantPlay && !next.playing()) next.play();
  // 当前歌曲确定后，立刻预热上一首 / 下一首，尽量让切歌没有延迟
  preloadNeighbors();
  startPreloadCheck();
  void addHistory(track);
}

/*
 * 「歌曲预加载」开关：**关掉的那一刻**就把待跑任务作废。
 * 只订阅 preloadEnabled 一个字段（zustand v5 的 subscribe 默认按引用比较），
 * 所以拖动别的设置不会把这里刷爆；preloadNeighbors 内部还有"开关关着就直接返回"的兜底。
 */
useSettingsStore.subscribe((state, prev) => {
  if (state.preloadEnabled !== prev.preloadEnabled) preloadNeighbors();
});

/*
 * 封面颜色预热：同一首「实际播放累计 > 10s」后算一次并写入本地颜色表。
 *
 * - 1s 一次的低频检查，复用播放器已有的位置状态，不新增高频轮询；
 * - 暂停时不计时（st.playing=false 直接跳过）；
 * - 一次位置跳变 >1.6s 视为 seek，不计入累计；
 * - 成功后才标记 done；失败不写脏数据，30s 后仍可重试。
 */
let coverColorTrackId: number | null = null;
let coverColorPlayedMs = 0;
let coverColorLastPos = 0;
let coverColorAttemptAt = 0;
const coverColorDone = new Set<number>();

setInterval(() => {
  const st = usePlayerStore.getState();
  const track = st.current;
  if (!track) {
    coverColorTrackId = null;
    coverColorPlayedMs = 0;
    coverColorLastPos = 0;
    return;
  }
  if (coverColorTrackId !== track.id) {
    coverColorTrackId = track.id;
    coverColorPlayedMs = 0;
    coverColorLastPos = getPlaybackPosition();
    coverColorAttemptAt = 0;
    return;
  }
  const pos = getPlaybackPosition();
  if (!st.playing) {
    coverColorLastPos = pos;
    return;
  }
  const delta = pos - coverColorLastPos;
  coverColorLastPos = pos;
  if (delta > 0 && delta <= 1.6) coverColorPlayedMs += delta * 1000;
  if (coverColorPlayedMs <= 10000 || coverColorDone.has(track.id)) return;
  if (Date.now() - coverColorAttemptAt < 30_000) return;
  coverColorAttemptAt = Date.now();
  void coverColorForSong(track.id, track.picUrl).then((color) => {
    if (color) coverColorDone.add(track.id);
  });
}, 1000);

