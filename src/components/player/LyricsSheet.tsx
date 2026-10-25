import { Component, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LyricPlayer, BackgroundRender } from "@applemusic-like-lyrics/react";
import type { LyricLine, LyricLineMouseEvent } from "@applemusic-like-lyrics/core";
import {
  usePlayerStore,
  getHowl,
  getPlaybackPosition,
  getPreloadedLyrics,
  clearPreloadedLyrics,
} from "@/stores/playerStore";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { loadLyricLines, onLyricLinesUpdated, applyLyricDisplaySettings, LYRIC_DISPLAY_CHANGED_EVENT, resolveNoLyrics } from "@/lib/lyrics";
import { useEffectiveArtists } from "@/lib/artistOverrides";
import { netease } from "@/lib/netease";
import { exitFullscreen, markLyricsCloseExit, showBrowserFullscreenHintOnce } from "@/lib/fullscreen";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAutoHide } from "@/hooks/useAutoHide";
import CloseButton from "@/components/player/CloseButton";
import { ProgressSlider } from "@/components/player/ProgressSlider";
import PlayPauseButton from "@/components/player/PlayPauseButton";
import SkipButton from "@/components/player/SkipButton";

/**
 * 未播放歌曲时的兜底「封面」：一张内联渐变图（data URI）。
 * 流动背景渲染器需要从专辑图采样颜色来生成流体网格，
 * 传入 undefined 会得到全黑背景，因此这里给一张渐变图作为兜底色。
 */
const FALLBACK_ALBUM = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#4c2a86"/>
<stop offset="45%" stop-color="#1f4a8f"/>
<stop offset="100%" stop-color="#8f2a63"/>
</linearGradient></defs><rect width="256" height="256" fill="url(#g)"/></svg>`,
)}`;

/**
 * 歌词播放器的错误边界。
 *
 * AMLL 会对歌词时间戳做严格校验，遇到脏数据（startTime > endTime、非有限数等）
 * 会直接 throw RangeError；没有边界的话 React 会卸载整棵树 —— 用户看到的就是
 * 「进入沉浸页整页纯黑」。这里兜住：最坏情况只是歌词区为空，背景 / 封面 / 控制条照常。
 * 切歌时用 resetKey 复位，给新歌一次重新渲染的机会。
 */
class LyricPlayerBoundary extends Component<
  { children: React.ReactNode; resetKey?: unknown },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("[lyrics] 歌词渲染失败，已跳过本次渲染：", error);
  }
  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * AMLL 的流动背景是 WebGL 画布，而 WebGL 默认 **不保留绘制缓冲**：
 * 一帧画完内容就被丢弃，外部再调 toDataURL() 只能拿到空白图（实测抓到的是空图，
 * 于是「冻结帧」永远抓不到、渲染器一直挂着）。
 *
 * 这里在创建上下文时补上 preserveDrawingBuffer，让静态背景能真正抓到那一帧。
 * 只拦截 webgl / webgl2 / experimental-webgl，对 2D 画布没有任何影响。
 */
if (typeof HTMLCanvasElement !== "undefined") {
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    attrs?: Record<string, unknown>,
  ) {
    if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
      return origGetContext.call(this, type, { ...(attrs ?? {}), preserveDrawingBuffer: true });
    }
    return origGetContext.call(this, type, attrs);
  } as typeof HTMLCanvasElement.prototype.getContext;
}

/** 全屏歌词页：AMLL 流动背景 + 左封面信息 / 右歌词，支持点击歌词跳转 */
export default function LyricsSheet() {  const lyricsOpen = useAppStore((s) => s.lyricsOpen);
  const setLyricsOpen = useAppStore((s) => s.setLyricsOpen);
  // 用户主动关闭时落门闩（阻止跟随全屏的逻辑把刚关掉的歌词页再弹回来）
  const markLyricsUserClosed = useAppStore((s) => s.markLyricsUserClosed);
  const showToast = useAppStore((s) => s.showToast);
  const current = usePlayerStore((s) => s.current);
  const playing = usePlayerStore((s) => s.playing);
  const duration = usePlayerStore((s) => s.duration);
  const loading = usePlayerStore((s) => s.loading);
  const seek = usePlayerStore((s) => s.seek);
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);

  const s = useSettingsStore();

  const [lines, setLines] = useState<LyricLine[]>([]);
  const [noLyrics, setNoLyrics] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [progress, setProgress] = useState(0);
  /** 正在拖动进度条：用 ref 让 rAF 循环能读到最新值，从而暂停进度回写 */
  const [seeking, setSeeking] = useState(false);
  const seekingRef = useRef(false);
  // 手动切到「大封面」布局后就不再自动切回歌词布局
  const [manualCover, setManualCover] = useState(false);
  // 手动歌词 / 纯音乐标记变化时 +1，触发重新加载
  const [overrideVersion, setOverrideVersion] = useState(0);
  /**
   * 「基线歌词」：刚解析出来、**还没施加显示设置**的那一份（TTML / 网易云 / 手动）。
   * 跳过前 N 行、翻译偏移都是在它的基础上现算的，所以改设置时可以立刻重画，
   * 不需要重新请求，也不会因为反复施加而层层累积。
   */
  const baseLinesRef = useRef<LyricLine[]>([]);

  const isPortrait = s.orientation === "portrait";
  /** 关闭方式只与「是否触屏」有关：触屏用下滑条，鼠标用叉号 */
  const isTouch = s.touch;
  // 竖屏 + 有歌词 + 未手动切走 → 紧凑布局（小封面在左上、歌词居中、控制栏在底部）
  const compact = isPortrait && !noLyrics && !manualCover;

  // 竖屏底部控制栏也支持自动隐藏，灵敏度与关闭键一致
  const controlsRef = useRef<HTMLDivElement>(null);
  /** 进度条那一行：单独做横向等比拉伸 */
  const progressRef = useRef<HTMLDivElement>(null);
  // 控制条隐藏时自身会收缩，故用一块「稳定的唤回热区」给 useAutoHide 判定距离
  const controlsZoneRef = useRef<HTMLDivElement>(null);
  const controlsVisibleRaw = useAutoHide(controlsZoneRef, s.closeButtonSensitivity);
  const controlsVisible = controlsVisibleRaw.visible;
  const showControls = controlsVisibleRaw.show;

  /** 歌词容器：高度恒定（控制栏绝对定位不占位），只有底部渐隐落点跟着控制栏走 */
  const lyricsBoxRef = useRef<HTMLDivElement>(null);
  const controlsInnerRef = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(112);

  useEffect(() => {
    const el = controlsInnerRef.current;
    if (!el) return;
    const update = () => setControlsHeight(el.offsetHeight || 0);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // lyricsOpen 必须在内：面板挂载前 ref 还是 null，不重跑就会一直用初始值
  }, [compact, isPortrait, lyricsOpen]);

  useEffect(() => {
    const el = lyricsBoxRef.current;
    if (!el) return;
    el.style.setProperty(
      "--lyrics-fade-inset",
      compact && controlsVisible ? `${controlsHeight}px` : "0px",
    );
    // current?.id 必须在内：歌词容器带 key={current.id}，切歌时会被整体重建，
    // 这个变量是写在元素内联样式上的，不重跑就会丢，表现为「渐隐消失」。
  }, [compact, controlsVisible, controlsHeight, lyricsOpen, current?.id]);

  useEffect(() => {
    const onChanged = () => {
      clearPreloadedLyrics(); // 丢掉旧的预加载歌词
      setOverrideVersion((v) => v + 1);
    };
    window.addEventListener("song-overrides-changed", onChanged);
    return () => window.removeEventListener("song-overrides-changed", onChanged);
  }, []);

  // 载入歌词：TTML 优先，LRC 回退（优先使用预加载缓存）
  // noLyrics 只在歌词「确认」后更新，避免加载期间布局突变
  useEffect(() => {
    let cancelled = false;
    if (!current) return;
    baseLinesRef.current = [];
    setLines([]);
    const cached = getPreloadedLyrics(current.id);
    if (cached) {
      baseLinesRef.current = cached;
      setLines(applyLyricDisplaySettings(current.id, cached));
      setNoLyrics(resolveNoLyrics(current.id, cached));
      /*
       * 缓存命中就万事大吉？不一定。
       * 预加载可能只落地了 LRC（TTML 那次超时/失败），此时缓存里就是 LRC 版，
       * 而"这首歌成了当前曲目"正是应当再给 TTML 一次机会的时刻。
       * loadLyricLines({force:true}) 会**立刻把手里这份返回**（不空屏、不闪），
       * 同时在后台再试一次 TTML —— 拿到就通过升级广播替换上屏。
       */
      void loadLyricLines(current.id, () => netease.lyric(current.id), { force: true }).catch(() => {});
      return;
    }
    // force：这是"当前曲目"的正式加载路径，无视预加载留下的暂时性失败记账
    loadLyricLines(current.id, () => netease.lyric(current.id), { force: true })
      .then((l) => {
        if (!cancelled) {
          baseLinesRef.current = l;
          setLines(applyLyricDisplaySettings(current.id, l));
          setNoLyrics(resolveNoLyrics(current.id, l));
        }
      })
      .catch(() => {
        if (!cancelled) {
          baseLinesRef.current = [];
          setLines([]);
          setNoLyrics(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [current?.id, overrideVersion]);

  /*
   * 歌词"升级"通道：网易云（YRC/LRC）先上屏后，TTML 镜像源一旦到达就替换成它。
   *
   * 守卫：
   *  1. 只认**仍然是当前这首歌**的广播 —— 切歌后迟到的旧结果必须丢弃；
   *  2. 只换歌词内容（setLines），**不碰播放位置、不重挂载歌词页**：
   *     歌词容器的 key 是 current.id，这里的替换不会改变它，歌词行不会重建，
   *     AMLL 沿用既有的 props 更新路径；[lines] 那条既有副作用会把逐行样式重新同步。
   *  3. 手动歌词 / 纯音乐标记的优先级由 lib/lyrics 内部把关（有 override 就不广播），
   *     这里只需认歌；
   *  4. 替换后同样要过一遍**显示设置**（跳过前 N 行 / 翻译偏移），
   *     否则"TTML 一到、偏移就失效"——这是最容易漏的一条。
   *
   * 只订阅一次（挂载即订、卸载才退），不随切歌反复订阅；也不引入任何轮询。
   */
  const currentIdRef = useRef<number | null>(null);
  currentIdRef.current = current?.id ?? null;
  useEffect(() => {
    return onLyricLinesUpdated((songId, upgraded) => {
      if (songId !== currentIdRef.current) return; // ① 旧歌的迟到结果：丢弃
      baseLinesRef.current = upgraded;
      setLines(applyLyricDisplaySettings(songId, upgraded));
      setNoLyrics(resolveNoLyrics(songId, upgraded));
    });
  }, []);

  /*
   * 显示设置（跳过前 N 行 / 翻译偏移）改动后**立即重画**，不需要切歌或重启。
   *
   * 这里刻意**不重新请求歌词**：手里这份"基线歌词"（baseLinesRef）原样保留，
   * 只是重新过一遍 applyLyricDisplaySettings。所以它不依赖 trackId、不依赖网络，
   * 也不会把正在播放的位置重置掉。
   */
  useEffect(() => {
    const onDisplayChanged = () => {
      const id = currentIdRef.current;
      const base = baseLinesRef.current;
      if (id === null) return;
      if (!base.length) return;
      setLines(applyLyricDisplaySettings(id, base));
    };
    window.addEventListener(LYRIC_DISPLAY_CHANGED_EVENT, onDisplayChanged);
    return () => window.removeEventListener(LYRIC_DISPLAY_CHANGED_EVENT, onDisplayChanged);
  }, []);

  // 打开时 / 切歌时同步一次进度
  useEffect(() => {
    const h = getHowl();
    if (h) {
      const sec = h.seek() as number;
      setCurrentTime(Math.round(sec * 1000));
      setProgress(sec);
    }
  }, [current?.id, lyricsOpen]);

  // rAF 播放进度同步
  // 注意：拖动进度条时必须停掉这个同步，否则每帧都会把音频实际位置写回 progress，
  // 手指位置和播放位置会互相打架（进度条来回跳、松手后的跳转也会被冲掉）。
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const h = getHowl();
      /*
       * 间奏点隐藏期限的解除**必须不受播放状态限制**。
       * 之前这段写在 `h.playing()` 守卫之内：暂停时循环不再推进进度，
       * 点过歌词后一暂停，hideInterlude 就永远挂着 —— 表现正是
       * 「小圆点再也不出现，连歌曲开头的间奏三点都没有」。
       */
      if (hideInterludeUntilRef.current) {
        const cur = pendingSeekRef.current ?? (h ? (h.seek() as number) : 0);
        if (Math.round(cur * 1000) > hideInterludeUntilRef.current) {
          hideInterludeUntilRef.current = 0;
          setHideInterlude(false);
        }
      }
      /*
       * 当前句是否已「唱完」—— 判据是**最后一个字结束的时刻**，不是行的 endTime。
       *
       * 原因（实测数据）：AMLL 的解析器会把行的 endTime 顶到下一行的 startTime
       * （用户那份 TTML：原文 15578 被解析成 16835，正好是下一行的起点）。
       * 若拿行尾判断，`ms >= 行尾` 成立的那一刻就是下一行开始的同一刻 ——
       * 「已播完但下一行未开始」这个窗口宽度恒为 0，效果永远看不到。
       * 而字级时间戳没有被延长，仍保留原文里真正唱完的时刻，所以用它来判断，
       * 就能准确落在两行之间那段空隙里（间隔大到 6 秒会交给间奏三点，不到则走这里）。
       */
      {
        const ls = linesRef.current;
        const ms = Math.round((pendingSeekRef.current ?? (h ? (h.seek() as number) : 0)) * 1000);
        let idx = -1;
        for (let i = 0; i < ls.length; i++) {
          if (ls[i].startTime <= ms) idx = i;
          else break;
        }
        let done = false;
        if (idx >= 0) {
          const cur = ls[idx];
          const words = cur.words;
          const contentEnd =
            words && words.length
              ? words.reduce((m, w) => Math.max(m, w.endTime), cur.startTime)
              : cur.endTime;
          /*
           * 取消高亮 + 恢复普通模糊，只在「本句真正的字唱完之后，离下一句还有
           * 明显空隙」时才做 —— 门槛 0.5 秒。
           *
           * 之前是"唱完就立刻生效"（只看 ms >= contentEnd），于是间隔只有零点几秒时
           * 会闪一下：刚刚取消高亮、下一句立刻接上，观感比一直亮着更差。
           * 间隔大到会显示间奏三点（6 秒）时同样走这里，两边互不冲突：
           * 三角点由 AMLL 自己画，我们只负责把上一行恢复成普通行观感。
           * 最后一行没有"下一句"，空隙视为无限大，所以照旧生效。
           */
          const nextStart = ls[idx + 1] ? ls[idx + 1].startTime : Infinity;
          done = ms >= contentEnd && nextStart - contentEnd > LINE_DONE_MIN_GAP_MS;
        }
        if (done !== currentLineDoneRef.current) {
          currentLineDoneRef.current = done;
          applyLineDone(done);
          setCurrentLineDone(done);
        }
      }
      if (!seekingRef.current && h && h.playing()) {
        const pending = pendingSeekRef.current;
        if (pending !== null) {
          // 跳转过渡期：音频可能还没追到目标位置，先推目标值避免进度回退（回退=跳转）
          setCurrentTime(Math.round(pending * 1000));
          setProgress(pending);
          // 跳转那一帧已经在 markSeek 里带着 isSeeking=true 送出去了，这里即刻复位
          setIsSeeking(false);
          const actual = h.seek() as number;
          if (Math.abs(actual - pending) < 0.35) endSeekTransition();
        } else {
          // 同样走统一接口：锁屏拖动进度条时这里才不会把旧位置又推回去
          const sec = getPlaybackPosition();
          setCurrentTime(Math.round(sec * 1000));
          setProgress(sec);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 跳转相关状态。AMLL 官方文档（Seeking and Progress Alignment）写明：
   *  - seeking 是**逐帧推导的瞬时状态**，只在发生跳转的那一帧成立，下一帧即回到正常播放；
   *  - 「不要长时间保持 seeking 状态」，否则会干扰它的间奏/动画状态；
   *  - 进度**回退**一律视为跳转；前进超过应有时长也算。
   *
   * 这正是「点了下一行、间奏三点还在」的根因：点击后我们立刻把 currentTime 写成目标值，
   * 但音频（Howler）还没真正跳过去，紧接着 rAF 循环又把**音频尚未追上的旧位置**推回去 ——
   * 进度出现「回退→再前进」的抖动，AMLL 反复判定为跳转，间奏动画被不停重启。
   *
   * 所以这里做三件事：
   *  1. 记下目标位置，在音频追上之前**推目标值**而不是旧值（消除回退抖动）；
   *  2. 只把**目标值那一帧**标记为 isSeeking（符合文档的「仅一帧」要求）；
   *  3. 这段过渡期内直接在 DOM 上隐掉间奏三点，确保点击后小圆点立刻消失。
   */
  const [isSeeking, setIsSeeking] = useState(false);
  const [hideInterlude, setHideInterlude] = useState(false);
  const pendingSeekRef = useRef<number | null>(null);
  const seekSettleTimerRef = useRef<number | null>(null);
  /**
   * 间奏点隐藏到该时间点（毫秒）。
   *
   * 点击歌词跳到某一句后，AMLL 内部可能**仍认为处于刚才那段间奏里**，于是把三点重新画出来。
   * 隐藏到「那一句播完」并不够（实测：播完后三点又出现了），要一直隐藏到
   * **下一段真正的间奏开始**才交给 AMLL —— 那才是应该重新出现小白点的时刻。
   */
  const hideInterludeUntilRef = useRef(0);
  /**
   * 间奏点隐藏的兜底上限。
   * 正常情况下隐藏会在「进入下一段间奏」时结束；这个上限只用于防止任何异常
   * （音频加载中、无法播放、用户暂停）导致小白点被永久隐掉。
   */
  const SEEK_HIDE_MAX_MS = 60_000;
  /**
   * 按 AMLL 同一套算法（含 i = -1 那一轮，即歌曲开头到第一句之间的空隙）预先算出间奏区间。
   * 阈值与本项目在 vite.config.ts 里改写后的保持一致（6 秒）。
   */
  const interludesRef = useRef<{ start: number; end: number }[]>([]);
  useEffect(() => {
    const MIN_GAP = 6_000;
    const ls = lines;
    const out: { start: number; end: number }[] = [];
    let maxEnd = 0;
    for (let i = -1; i < ls.length - 1; i++) {
      if (i >= 0) maxEnd = Math.max(maxEnd, ls[i].endTime);
      const gapEnd = Math.max(maxEnd, ls[i + 1].startTime);
      if (gapEnd - maxEnd >= MIN_GAP) out.push({ start: maxEnd, end: gapEnd });
    }
    interludesRef.current = out;
  }, [lines]);

  /**
   * 「本句已唱完」效果的触发门槛：本句最后一个字结束、到下一句开始之间的空隙
   * 必须**大于**这个值（毫秒）才取消高亮 + 恢复普通模糊。
   * 空隙太短时保持原样 —— 否则高亮会闪一下，比不取消更难看。
   */
  const LINE_DONE_MIN_GAP_MS = 500;

  /**
   * 当前这一句是否已经唱完。
   *
   * AMLL 核心源码写明：行高亮「唱完后不会自行熄灭，而是继续保持高亮」，
   * 只有在①下一句开始 ②进入间奏区间 ③歌曲结束 ④跳转 时才会清空。
   * 于是两行间隔小到**插不进间奏三点**时，上一句唱完仍整行高亮且没有模糊 ——
   * 这里由我们自己把这一行恢复成普通行观感（清高亮 + 正常模糊），
   * 但**不动行位置**：锚点仍停在这一句，直到下一句开始自然交棒。
   */
  const [currentLineDone, setCurrentLineDone] = useState(false);
  const currentLineDoneRef = useRef(false);
  /** 供 rAF 循环读取最新的歌词行（effect 依赖为空，闭包会拿到旧的） */
  const linesRef = useRef<LyricLine[]>([]);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  /**
   * 给「已唱完但仍是当前行」的那一行套上普通行的观感（取消高亮 + 正常模糊）。
   *
   * 为什么不用样式表：AMLL 把 `--bright-mask-alpha` / `--dark-mask-alpha` 写在**行内
   * style** 上，而这两个是 @property 注册过的自定义属性 —— 实测样式表里的 !important
   * 压不住行内声明（filter 能压住，自定义属性不行）。所以这里直接写行内 + important，
   * 并把原值备份到变量里，撤销时按原样还原（否则会破坏 AMLL 自己的状态）。
   */
  const applyLineDone = (done: boolean) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const wrap = sheet.querySelector<HTMLElement>('[class*="bottomLineWrapper"]');
    const targets = wrap
      ? wrap.querySelectorAll<HTMLElement>('[class*="lyricLine"], [class*="lyricLineWrapper"]')
      : [];
    targets.forEach((el) => {
      if (done) {
        if (!el.dataset.auroraDone) {
          // 备份原值
          el.dataset.auroraDone = "1";
          el.style.setProperty("--aurora-orig-bright", el.style.getPropertyValue("--bright-mask-alpha"));
          el.style.setProperty("--aurora-orig-dark", el.style.getPropertyValue("--dark-mask-alpha"));
          el.style.setProperty("--aurora-orig-filter", el.style.getPropertyValue("filter"));
          el.style.setProperty("--aurora-orig-opacity", el.style.getPropertyValue("opacity"));
        }
        // 只改「绘制」相关：遮罩、虚化、焦点亮度。
        // 绝不碰尺寸 / 位置 / 时间轴 —— 行位置不动、两行之间不产生空隙、页面也不滚动。
        el.style.setProperty(
          "--bright-mask-alpha",
          sheet.style.getPropertyValue("--aurora-passed-bright") || "0.2",
          "important",
        );
        el.style.setProperty(
          "--dark-mask-alpha",
          sheet.style.getPropertyValue("--aurora-passed-dark") || "0.2",
          "important",
        );
        el.style.setProperty(
          "filter",
          sheet.style.getPropertyValue("--aurora-passed-filter") || "none",
          "important",
        );
        // opacity 是「焦点亮度」的关键：AMLL 靠给非当前行降透明度体现失焦
        el.style.setProperty(
          "opacity",
          sheet.style.getPropertyValue("--aurora-passed-opacity") || "0.45",
          "important",
        );
      } else if (el.dataset.auroraDone) {
        delete el.dataset.auroraDone;
        const restore = (prop: string, backup: string) => {
          const v = el.style.getPropertyValue(backup);
          if (v) el.style.setProperty(prop, v);
          else el.style.removeProperty(prop);
          el.style.removeProperty(backup);
        };
        restore("--bright-mask-alpha", "--aurora-orig-bright");
        restore("--dark-mask-alpha", "--aurora-orig-dark");
        restore("filter", "--aurora-orig-filter");
        restore("opacity", "--aurora-orig-opacity");
      }
    });
  };

  /**
   * 换歌 / 关闭歌词页时复位跳转过渡状态。
   * 上一次点击留下的「隐藏间奏点」期限绝不能跨歌曲生效 ——
   * 否则新歌开头（前奏那一段本该出现三点的地方）也会被隐掉。
   */
  useEffect(() => {
    pendingSeekRef.current = null;
    hideInterludeUntilRef.current = 0;
    setIsSeeking(false);
    setHideInterlude(false);
  }, [current?.id, lyricsOpen]);

  /** 结束一次跳转过渡：恢复正常推进（以及在没有行级期限时恢复间奏点的显示） */
  const endSeekTransition = () => {
    pendingSeekRef.current = null;
    if (seekSettleTimerRef.current !== null) {
      window.clearTimeout(seekSettleTimerRef.current);
      seekSettleTimerRef.current = null;
    }
    if (!hideInterludeUntilRef.current) setHideInterlude(false);
  };

  /**
   * 封面是否可用，以及传给流动背景的专辑图地址。
   *
   * 背景渲染器要从专辑图采样颜色来生成流体网格 —— 拿不到图就是**全黑背景**。
   * 原来的写法是 `current?.picUrl || FALLBACK_ALBUM`，只在地址为「空」时才兜底；
   * 而网易图床链接过期、或手动添加歌曲填了失效地址时，地址非空却打不开，
   * 于是原样传进去 → 进入沉浸页就是一片纯黑（实测可复现）。
   * 这里先自己预加载验证，成功才交给渲染器，失败退回兜底渐变。
   */
  const [coverOk, setCoverOk] = useState(true);
  const [bgAlbum, setBgAlbum] = useState<string>(FALLBACK_ALBUM);
  useEffect(() => {
    const url = current?.picUrl;
    setCoverOk(true);
    if (!url) {
      setBgAlbum(FALLBACK_ALBUM);
      return;
    }
    let cancelled = false;
    const img = new Image();
    // 背景渲染器要读像素取色，不带 CORS 标头会被画布污染，等同于拿不到颜色
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!cancelled) setBgAlbum(url);
    };
    img.onerror = () => {
      if (cancelled) return;
      setBgAlbum(FALLBACK_ALBUM);
      setCoverOk(false);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [current?.picUrl]);

  /**
   * 静态背景用的「冻结帧」。
   *
   * 关闭流动背景时不该是一片纯黑：先让 BackgroundRender 正常渲染，
   * 抓到一帧后转成图片，**整首歌就只用这张图**（渲染器随即卸载，省电且观感保留）。
   * 抓帧从封面就绪（bgAlbum 定下来）那一刻就开始，不必等页面完全打开。
   *
   * 状态含义：
   *   null   → 尚未抓到，仍在渲染器上跑
   *   字符串 → dataURL（长度 > 0）即冻结帧；空串表示抓帧失败，改用封面兜底
   */
  const [bgFrozen, setBgFrozen] = useState<string | null>(null);
  /** 需要静态背景：关闭流动背景时 */
  const needStaticBg = !s.bgEnabled;

  // 换歌或开关变化时重新抓
  useEffect(() => {
    setBgFrozen(null);
  }, [current?.id, s.bgEnabled]);

  useEffect(() => {
    if (!needStaticBg || !lyricsOpen) return;
    let raf = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    };
    // 兜底用「时间」而不是帧数：某些环境（无头、后台标签页）rAF 会被节流甚至不跑，
    // 按帧计数可能永远等不到兜底，就会一直停在渲染器上。
    const fallback = window.setTimeout(() => {
      if (stopped) return;
      stop();
      setBgFrozen("");
    }, 1200);
    const tryCapture = () => {
      if (stopped) return;
      const canvas = sheetRef.current?.querySelector("canvas") as HTMLCanvasElement | null;
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        try {
          // WebGL 画布需保留绘制缓冲才能取到内容（已在模块顶部为上下文补上该属性）
          const url = canvas.toDataURL("image/jpeg", 0.82);
          // 空图（全透明/单色）编码出来会非常短，用它当失败判据
          if (url.length > 5000) {
            window.clearTimeout(fallback);
            stop();
            setBgFrozen(url);
            return;
          }
        } catch {
          /* 画布被跨域图片污染，交给兜底 */
        }
      }
      raf = requestAnimationFrame(tryCapture);
    };
    raf = requestAnimationFrame(tryCapture);
    return () => {
      window.clearTimeout(fallback);
      stop();
    };
  }, [needStaticBg, lyricsOpen, bgAlbum, current?.id]);
  /** 入场动画进行中（结束后必须摘掉，否则会和拖拽的 transform 打架） */
  const [entering, setEntering] = useState(false);
  /**
   * 正在做布局切换的 FLIP。
   * 紧凑布局的控制栏外层带 max-height + overflow:hidden，FLIP 期间控制条是被
   * translate 到旧位置再滑回来的，会被这层裁掉（表现为「快到位时被什么挡住」），
   * 所以动画期间临时放开 overflow。
   */
  const [flipping, setFlipping] = useState(false);
  /** FLIP 动画令牌：让上一次动画遗留的兜底清理失效，避免打断新动画 */
  const flipTokenRef = useRef(0);
  const coverRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);
  const prevLayoutRects = useRef<Map<string, DOMRect>>(new Map());
  const prevPortraitRef = useRef(isPortrait);

  /**
   * 量取参与 FLIP 的三个部件。
   *
   * 坐标一律「相对歌词页根节点」：入场动画给整页加了 translateY(100%)，
   * 祖先的 transform 会被算进 getBoundingClientRect，若直接用绝对坐标，
   * 入场期间的采样就会把基准记成「屏幕下方」，之后任何一次布局变化都会让
   * 这些元素从下面飞上来。减去根节点自身的位移后，入场再怎么动都不影响基准。
   */
  const measureLayout = () => {
    const map = new Map<string, DOMRect>();
    const base = sheetRef.current?.getBoundingClientRect();
    const ox = base?.left ?? 0;
    const oy = base?.top ?? 0;
    const pairs: [string, HTMLElement | null][] = [
      ["cover", coverRef.current],
      ["info", infoRef.current],
      ["controls", controlsRef.current],
      ["progress", progressRef.current],
    ];
    for (const [key, el] of pairs) {
      if (!el) continue;
      // 上一次 FLIP 可能还在动画中（行内 transform 尚未清理），带着它测量会把
      // 中间态当成基准，下一次动画的起点就错了。这里先摘掉再量，量完恢复。
      const saved = el.style.transform;
      if (saved) el.style.transform = "";
      const r = el.getBoundingClientRect();
      if (saved) el.style.transform = saved;
      map.set(key, new DOMRect(r.left - ox, r.top - oy, r.width, r.height));
    }
    return map;
  };

  useLayoutEffect(() => {
    const next = measureLayout();

    // 横竖屏是两套完全不同的 DOM，切换方向不做 FLIP
    const orientationChanged = prevPortraitRef.current !== isPortrait;
    prevPortraitRef.current = isPortrait;

    // 入场动画期间整页带着 translateY(100%)，此时量到的坐标是「屏幕下方」，
    // 若记成基准，第一次切歌就会让所有元素从下面飞上来。这里直接跳过并清空基准，
    // 等 entering 变 false（本 effect 会因依赖变化再跑一次）重新记录。
    if (entering) {
      prevLayoutRects.current = new Map();
      return;
    }

    if (!orientationChanged) {
      let applied = false;

      /**
       * 启动一次 FLIP：先瞬间把元素摆回旧位置，再开过渡滑回新位置。
       * 结束后清掉行内样式 —— 留着的话，下一次测量若落在上一次动画的中间态上，
       * 起点就会错。
       *
       * 两个坑：
       *  1) transitionend 会冒泡，子元素（切歌键/播放键自己的 transform 过渡）结束时
       *     也会派发到这一层。所以只认自己、且只认 transform 属性；
       *  2) 兜底计时器必须用 token 作废上一次动画遗留的那个，
       *     否则连续切换时它会打断正在进行的新动画（表现为「快到位时突然跳正」）。
       */
      const startFlip = (el: HTMLElement, from: string, origin: string) => {
        el.style.transition = "none";
        el.style.transformOrigin = origin;
        el.style.transform = from;
        void el.offsetHeight; // 强制 reflow
        el.style.transition = "transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)";
        el.style.transform = "translate(0px, 0px) scale(1)";

        const token = ++flipTokenRef.current;
        let finished = false;
        const finish = () => {
          if (finished || token !== flipTokenRef.current) return;
          finished = true;
          el.removeEventListener("transitionend", onEnd);
          el.style.transform = "";
          el.style.transformOrigin = "";
          el.style.transition = "";
        };
        const onEnd = (ev: TransitionEvent) => {
          if (ev.target !== el || ev.propertyName !== "transform") return;
          finish();
        };
        el.addEventListener("transitionend", onEnd);
        window.setTimeout(finish, 900); // 兜底：万一事件没来也不留残留
      };

      // 横屏左列整体带 scale()，元素自身的 translate 会再被父级缩放一次，
      // 所以位移要先除以该比例，动画终点才和基准坐标对齐。
      const k = isPortrait ? 1 : s.leftColumnScale || 1;

      for (const [key, rect] of next) {
        const el =
          key === "cover"
            ? coverRef.current
            : key === "info"
              ? infoRef.current
              : key === "progress"
                ? progressRef.current
                : controlsRef.current;
        const old = prevLayoutRects.current.get(key);
        if (!el || !old) continue;

        const sx = rect.width > 0 ? old.width / rect.width : 1;
        const sy = rect.height > 0 ? old.height / rect.height : 1;

        // 进度条：单独做「横向等比拉伸」—— 以自身中线为原点，
        // 宽度变化左右对称，纵向不变形；它跟着控制块一起上下平移，所以自己不位移。
        if (key === "progress") {
          if (Math.abs(sx - 1) < 0.01) continue;
          startFlip(el, `scale(${sx}, 1)`, "center center");
          applied = true;
          continue;
        }

        /*
         * 控制条的轴向处理：
         *
         * 竖屏 → 锁 x：两个布局下它都居中于同一中线，横向本来就只有几像素误差，
         *        锁掉更干净（宽度变化交给进度条自己横向拉伸，按钮尺寸与 x 都不动）。
         *
         * 横屏 → **不能锁 y**。之前按「横屏锁 y」把 dy 归零，但横屏这两个变体结构完全不同：
         *        有歌词是两列行布局（左列 md:w-96），无歌词是垂直居中的列（max-w-sm），
         *        控制组件的纵向位置相差很大 —— 把 dy 归零就只剩横向位移，纵向变化只能瞬移，
         *        表现正是「纯音乐与非纯音乐切换时控制组件乱跳」。交给常规 FLIP 即可。
         */
        const midAnchored = key === "controls";
        const lockX = isPortrait && midAnchored;
        const dx = lockX ? 0 : old.left - rect.left;
        const dy = old.top - rect.top;
        const sc = midAnchored ? 1 : (sx + sy) / 2;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sc - 1) < 0.02) {
          continue;
        }
        startFlip(
          el,
          `translate(${dx / k}px, ${dy / k}px) scale(${sc})`,
          lockX ? "center top" : "top left",
        );
        applied = true;
      }

      // FLIP 期间放开控制栏外层的裁剪，否则控制条滑回原位时会有一段被切掉
      if (applied) {
        setFlipping(true);
        window.setTimeout(() => setFlipping(false), 700);
      }
    }

    prevLayoutRects.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, noLyrics, current?.id, lyricsOpen, isPortrait, entering]);

  // 视口尺寸/全屏变化时重新同步基准坐标（不做动画），避免用过期坐标做 FLIP 造成跳动
  useLayoutEffect(() => {
    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        prevLayoutRects.current = measureLayout();
      });
    };
    window.addEventListener("resize", sync);
    document.addEventListener("fullscreenchange", sync);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", sync);
      document.removeEventListener("fullscreenchange", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 竖屏下滑关闭：拖拽距离 + 是否正在拖拽
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; id: number } | null>(null);
  /** 最新拖拽距离（用 ref 记录，避免松手时读到上一帧的 state） */
  const dragYRef = useRef(0);
  /** 拖拽过程中的采样（只在最近 120ms 内保留），用于松手时判断瞬时方向 */
  const dragSamplesRef = useRef<{ t: number; y: number }[]>([]);
  /** 拖拽后抑制这次点击（避免顺带触发封面切换） */
  const suppressDragClick = useRef(false);

  /*
   * 沉浸页滑入/滑出 与 内容层缩放去模糊 共用同一时长与曲线。
   * 两者必须严格同步：之前内容层的恢复要等卸载（320ms）之后才启动，
   * 而沉浸页 320ms 就滑走了，于是"背景变清晰+放大"总是慢一拍。
   */
  const SHEET_MOVE = "0.42s cubic-bezier(0.22, 1, 0.36, 1)";

  /** 背景页（被歌词页盖住的那层）随拖拽从 0.9 放大到 1.0 并去模糊 */
  const applyBehind = (progress: number, animate: boolean) => {
    const el = document.querySelector<HTMLElement>("[data-app-behind]");
    if (!el) return;
    const p = Math.max(0, Math.min(1, progress));
    el.style.transition = animate ? `transform ${SHEET_MOVE}, filter ${SHEET_MOVE}` : "none";
    el.style.transformOrigin = "center center";
    el.style.transform = `scale(${(0.9 + 0.1 * p).toFixed(4)})`;
    el.style.filter = `blur(${(6 * (1 - p)).toFixed(2)}px)`;
  };

  const resetBehind = () => {
    const el = document.querySelector<HTMLElement>("[data-app-behind]");
    if (!el) return;
    el.style.transition = `transform ${SHEET_MOVE}, filter ${SHEET_MOVE}`;
    el.style.transform = "";
    el.style.filter = "";
  };

  // 触屏设备打开时背景页缩到 0.9 并轻微模糊；下滑过程中再放大还原
  useEffect(() => {
    if (!lyricsOpen) {
      resetBehind();
      return;
    }
    if (isTouch) applyBehind(0, true);
    else resetBehind();
    return () => resetBehind();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyricsOpen, isTouch]);

  const onSheetDragStart = (e: React.PointerEvent) => {
    if (!isTouch) return;
    dragRef.current = { startY: e.clientY, id: e.pointerId };
    dragSamplesRef.current = [{ t: e.timeStamp || Date.now(), y: e.clientY }];
    suppressDragClick.current = false;
    setDragging(true);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* 合成事件 / 无效 pointerId 时忽略 */
    }
  };

  const onSheetDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = Math.max(0, e.clientY - d.startY);
    if (dy > 8) suppressDragClick.current = true;
    dragYRef.current = dy;
    setDragY(dy);
    applyBehind(dy / Math.max(1, window.innerHeight), false);

    // 只保留最近 120ms 的采样，用于松手时判断瞬时方向
    const now = e.timeStamp || Date.now();
    const arr = dragSamplesRef.current;
    arr.push({ t: now, y: e.clientY });
    while (arr.length > 2 && now - arr[0].t > 120) arr.shift();
  };

  const onSheetDragEnd = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    setDragging(false);
    const dy = dragYRef.current;
    dragYRef.current = 0;

    // 松手前的瞬时速度（px/ms，正 = 向下）
    const samples = dragSamplesRef.current;
    dragSamplesRef.current = [];
    let vy = 0;
    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      if (dt > 0) vy = (last.y - first.y) / dt;
    }

    // 位移够了、但松手前正在向上拉 → 不退出，滑回原位
    const movingUp = vy < -0.1; // 向上快于 100px/s
    const farEnough = dy > Math.min(160, window.innerHeight * 0.2);
    const shouldClose = farEnough && !movingUp;

    if (shouldClose) {
      // closeLyrics 内部会滑出并在动画结束后卸载，这里不要再自己 setDragY(0)
      applyBehind(1, true);
      closeLyrics();
    } else {
      setDragY(0);
      applyBehind(0, true);
      // 本次拖拽没触发关闭：等这一轮事件（含紧随 pointerup 的 click）走完再复位，
      // 否则「拖一下没关掉、紧接着轻点小白条」会被当成拖拽而被忽略，要点两次。
      window.setTimeout(() => {
        suppressDragClick.current = false;
      }, 0);
    }
  };

  // 供顶部区域复用的拖拽事件（仅触屏）
  const dragHandlers = isTouch
    ? {
        onPointerDown: onSheetDragStart,
        onPointerMove: onSheetDragMove,
        onPointerUp: onSheetDragEnd,
        onPointerCancel: onSheetDragEnd,
      }
    : {};

  /** 上一首歌：换歌时把旧封面 / 旧歌名留在上面淡出，做成交叉淡化。
   *  （必须放在提前 return 之前，否则违反 Hooks 规则）
   *  必须用 useLayoutEffect：useEffect 在浏览器绘制之后才跑，
   *  换歌后的第一帧会缺了旧层、只剩正在淡入的新内容 —— 那就是「先闪一下」。 */
  const [prevTrack, setPrevTrack] = useState<typeof current>(null);
  /*
   * 歌手显示值（用户在「歌曲设置」里改过就用改后的）。
   * 放在这里而不是 infoBlock 里：Hook 必须无条件、顺序稳定地调用，
   * 而 infoBlock 是渲染期被调用的内层函数。
   */
  const displayArtistsCurrent = useEffectiveArtists(current);
  const displayArtistsPrev = useEffectiveArtists(prevTrack);
  const lastTrackRef = useRef<typeof current>(current);
  useLayoutEffect(() => {
    const last = lastTrackRef.current;
    lastTrackRef.current = current;
    if (!last || !current || last.id === current.id) return;
    setPrevTrack(last);
    const t = window.setTimeout(() => setPrevTrack(null), 460);
    return () => window.clearTimeout(t);
  }, [current?.id]);

  /** 整个沉浸歌词页的根节点，用于在触屏下监听歌词行的按压 */
  const sheetRef = useRef<HTMLDivElement>(null);
  /** 正在播放退场动画，避免重复触发关闭 */
  const closingRef = useRef(false);

  /**
   * 入场动画：整页从屏幕下方滑入（触屏/鼠标、横屏/竖屏一致）。
   * 用 CSS 关键帧而不是 JS 两步翻转：挂载即播放，不依赖 rAF 时序，
   * 且此时 dragY 为 0、不产生 transform 冲突 —— 过程中内容是完整渲染好的。
   * （必须在提前 return 之前，否则违反 Hooks 规则）
   */
  useLayoutEffect(() => {
    if (lyricsOpen) {
      setEntering(true);
    } else {
      setEntering(false);
      setDragY(0);
      closingRef.current = false;
    }
  }, [lyricsOpen]);

  /**
   * 触屏点歌词的善后（两件事都在 CSS 里收尾，见 index.css）：
   *  1) 按下时给这一行挂上 .lyric-press 底色，松手/取消即摘掉；
   *  2) 把 AMLL 写在行内 style 上的 blur 镜像到 --aurora-line-filter，
   *     这样即使 :hover 粘住，也能用更高优先级的规则把模糊压回来。
   *  （必须在提前 return 之前，否则违反 Hooks 规则）
   */
  useEffect(() => {
    if (!isTouch || !lyricsOpen) return;
    const sheet = sheetRef.current;
    if (!sheet) return;

    let pressed: HTMLElement | null = null;
    const clearPressed = () => {
      pressed?.classList.remove("lyric-press");
      pressed = null;
    };
    const onDown = (e: PointerEvent) => {
      const line = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        '[class*="lyricLineWrapper"]',
      );
      if (!line) return;
      clearPressed();
      pressed = line;
      line.classList.add("lyric-press");
    };

    sheet.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", clearPressed);
    window.addEventListener("pointercancel", clearPressed);

    /*
     * 把 AMLL 写在行内 style 上的 filter 镜像成 CSS 变量，供 index.css 的
     * 触屏覆盖规则把模糊/淡化压回去（AMLL 自带的
     * `.amll-lyric-player:hover .lyricLine { filter: unset !important }` 会在触屏
     * 因 :hover 粘滞而长期生效，把每行的状态样式全部抹掉）。
     *
     * 两个必须做对的地方：
     *  1) 观察整页（稳定节点）而不是 .amll-lyric-player —— 歌词刚加载完那个元素会被重建，
     *     观察器挂在它身上就会失效（表现为「第一首歌点歌词后其余行失去模糊」）；
     *  2) **filter 被清空时也要同步**。之前这里有个 `&& el.style.filter` 的判断，
     *     于是 AMLL 把某行的 filter 移除后，变量仍停在旧值 —— 那行就被我们的
     *     !important 规则钉死（例如已播完本该淡化的行一直保持全亮）。这是「上一行播完了
     *     还整行高亮」的直接原因。
     */
    const syncFilter = (el: HTMLElement) => {
      const f = el.style.filter;
      if (f) el.style.setProperty("--aurora-line-filter", f);
      else el.style.removeProperty("--aurora-line-filter");
      /*
       * 顺便采集一份「普通行（非当前高亮行）」的样式样本到根节点上。
       * 用途：当前这句唱完、而下一句还差一点点才开始时（间隔小到放不下间奏三点），
       * 我们要把这一行恢复成普通行的观感 —— 取消高亮 + 正常虚化 —— 但**行位置不动**、
       * 也不产生任何空隙（所以只改绘制相关属性，绝不碰尺寸/时间轴）。
       * 直接复用 AMLL 自己给普通行的值，最贴近「正常」。
       *
       * 三个都要采：filter（虚化）、opacity（焦点亮度）、两个遮罩 alpha（扫词遮罩）。
       * 之前只采了 filter 与遮罩，漏掉 opacity —— 而 AMLL 正是靠给非当前行降透明度
       * 来体现「失去焦点」，所以只压遮罩时看着仍然像高亮。
       */
      const isBottom = typeof el.closest === "function" && el.closest('[class*="bottomLineWrapper"]');
      if (!isBottom) {
        if (f) sheet.style.setProperty("--aurora-passed-filter", f);
        const op = el.style.opacity || el.style.getPropertyValue("opacity");
        if (op) sheet.style.setProperty("--aurora-passed-opacity", op);
        const ba = el.style.getPropertyValue("--bright-mask-alpha");
        const da = el.style.getPropertyValue("--dark-mask-alpha");
        if (ba) sheet.style.setProperty("--aurora-passed-bright", ba);
        if (da) sheet.style.setProperty("--aurora-passed-dark", da);
      }
    };
    const lineSelector = '[class*="lyricLine"], [class*="lyricLineWrapper"]';
    const syncAll = () => sheet.querySelectorAll<HTMLElement>(lineSelector).forEach(syncFilter);
    syncAll();
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (el?.style && typeof el.matches === "function" && el.matches(lineSelector)) {
          syncFilter(el);
        }
      }
    });
    mo.observe(sheet, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    return () => {
      sheet.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", clearPressed);
      window.removeEventListener("pointercancel", clearPressed);
      clearPressed();
      mo.disconnect();
    };
  }, [isTouch, lyricsOpen, lines]);

  if (!lyricsOpen) return null;

  const handleLyricLineClick = (e: LyricLineMouseEvent) => {
    const line = e.line?.getLine();
    if (line && typeof line.startTime === "number") {
      const sec = Math.round(line.startTime / 1000);
      seek(sec);
      setCurrentTime(line.startTime);
      setProgress(sec);
      markSeek(sec, line.startTime);
    }
  };

  /**
   * 标记「刚刚发生了一次跳转到 targetSec」。
   *
   * 按 AMLL 文档：seeking 只成立一帧，且「不要长时间保持」。所以这里不是简单地
   * 把 isSeeking 挂一段时间，而是：
   *  - 记录目标位置，过渡期内让 rAF 循环推**目标值**（此刻音频往往还没追到，
   *    直接读 howl.seek() 会拿到旧位置 → 进度回退 → 又被判成一次跳转 → 间奏动画反复重启）；
   *  - 只把第一帧标成 isSeeking；
   *  - 隐掉间奏三点，直到**下一段真正的间奏开始**为止。
   *
   * 最后这点是实测修正过的：原先只隐到「跳过去的那一句播完」，结果播完三点又冒出来 ——
   * 因为 AMLL 内部仍认为处于刚跳过的那段间奏里。改成按间奏区间判断后，
   * 隐藏会一直持续到时间进入**下一段**间奏，那时才把小白点交还给 AMLL。
   *
   * @param fromMs 起算位置（点击的行起点 / 进度条目标位置），用于找它之后的下一段间奏
   */
  const markSeek = (targetSec: number, fromMs?: number) => {
    pendingSeekRef.current = targetSec;
    // 关键：跳转那一帧就要带上 isSeeking，且与 currentTime 的更新落在同一次渲染里
    // （等价于官方示例的 player.setCurrentTime(t, true)）；下一帧由循环复位。
    setIsSeeking(true);
    // 找下一段间奏的起点作为隐藏期限；若之后已无间奏，就一直隐到本曲结束（用极大值表示）
    const base = fromMs ?? targetSec * 1000;
    const nextInterlude = interludesRef.current.find((it) => it.start > base);
    hideInterludeUntilRef.current = nextInterlude ? nextInterlude.start : Number.MAX_SAFE_INTEGER;
    setHideInterlude(true);
    if (seekSettleTimerRef.current !== null) window.clearTimeout(seekSettleTimerRef.current);
    // 兜底硬上限：即便音频迟迟追不上（加载中 / 无法播放 / 用户暂停），
    // 60 秒后也必须把间奏点交还给 AMLL，不能永久隐着
    seekSettleTimerRef.current = window.setTimeout(() => {
      hideInterludeUntilRef.current = 0;
      endSeekTransition();
    }, SEEK_HIDE_MAX_MS);
  };

  /** 关闭：先向下滑出（与入场对称），动画结束后再真正卸载 */
  const closeLyrics = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    /*
     * 用户**主动**关闭沉浸歌词页（鼠标端叉号 / 触屏下滑条 / 轻点小白条都走这里）：
     *  ① 落门闩：这次全屏会话里用户不要歌词页了。「沉浸歌词跟随全屏」的门闩检查
     *     会阻止它再自动打开 —— 否则在 F11 里一关，随后任何一个 resize 信号都会
     *     把歌词页弹回来（用户看到的就是"关不掉"）。
     *  ② 若此刻是**浏览器自带全屏**（F11）：网页无权退出它，只解释一次，
     *     免得用户以为"退出全屏失败"（API 全屏我们能退，不弹）。
     * 必须在下面的 exitFullscreen() **之前**判断：那之后 API 元素可能已被清掉，
     * 会把 API 全屏误判成 F11。
     */
    markLyricsUserClosed();
    // 触屏端没有 F11 / 浏览器全屏；不要在这里弹「网页无权退出全屏」的桌面提示
    if (!isTouch) showBrowserFullscreenHintOnce(showToast);
    /*
     * 内容层的"变清晰 + 放大"必须**现在**就开始，和滑出同时进行。
     * 若等下面的 setTimeout 卸载后再由 effect 触发，它会整整晚 320ms 才开始，
     * 观感就是"沉浸页已经滑走了，背景还糊着小着、慢慢才恢复"。
     */
    applyBehind(1, true);
    setDragY(window.innerHeight);
    /*
     * 顺带退出全屏（fullscreenOnLyrics）时先登记一次标记：
     * 「沉浸歌词跟随全屏」开启后，退出全屏会要求关闭歌词页，
     * 但这次退出全屏**正是本函数自己发起的** —— 若被当成用户在退出全屏，
     * 监听器会立刻 setLyricsOpen(false)，把下面 420ms 的滑出动画截断成"闪一下"。
     * 登记后监听器读到就放行，由这里的定时器按原节奏收尾。
     * exitFullscreen() 返回 false（本来就不在全屏）时不登记：那次不会有 fullscreenchange。
     */
    if (s.fullscreenOnLyrics && exitFullscreen()) markLyricsCloseExit();
    window.setTimeout(() => {
      setLyricsOpen(false);
      setDragY(0);
      closingRef.current = false;
      // 与滑出时长（0.42s）对齐：提前卸载会把滑出动画截断
    }, 420);
  };

  // 竖屏点封面可在「大封面」与「歌词」布局间来回切
  const canToggleLayout = isPortrait && !noLyrics;

  /** 封面框：紧凑布局小方块，大封面布局大方块；竖屏有歌词时可点击切换 */
  const coverBox = (size: "compact" | "large") => (
    <div
      ref={coverRef}
      onClick={
        canToggleLayout
          ? () => {
              if (suppressDragClick.current) return; // 刚才是拖拽，不算点击
              setManualCover(size === "compact");
            }
          : undefined
      }
      className={cn(
        "relative shrink-0 overflow-hidden shadow-2xl",
        size === "compact"
          ? "h-14 w-14 rounded-xl"
          : "h-44 w-44 rounded-2xl sm:h-64 sm:w-64 md:h-96 md:w-96",
        canToggleLayout && "cursor-pointer transition-transform active:scale-95",
      )}
    >
      {current?.picUrl && coverOk ? (
        <img
          key={current.id}
          src={current.picUrl}
          onError={() => setCoverOk(false)}
          className="lyric-info-in h-full w-full object-cover"
          alt=""
        />
      ) : (
        <span className="block h-full w-full bg-muted" />
      )}
      {/* 上一首封面：盖在上面淡出 */}
      {prevTrack?.picUrl && (
        <img
          src={prevTrack.picUrl}
          aria-hidden
          className="lyric-info-out pointer-events-none absolute inset-0 h-full w-full object-cover"
        />
      )}
    </div>
  );

  /** 歌名 / 歌手（换歌时与上一首交叉淡化，避免内容突变） */
  const infoBlock = (small: boolean) => (
    <div className={cn("relative", small ? "min-w-0 flex-1" : "w-full text-center")}>      {/* FLIP 挂在这一层：它是文本自身的包围盒（w-fit）。
          两个布局下文字对齐方式不同（紧凑左对齐 / 大封面居中），
          只有量文本包围盒，动画起点才等于文字真实所在的位置；
          量外层整块会在切换瞬间把居中后的文字"传送"到另一端。 */}
      <div ref={infoRef} className={cn("relative w-fit max-w-full", !small && "mx-auto")}>
        {/* 换歌：新文字在下层由透明渐显；旧文字在上层由不透明渐隐（见 index.css） */}
        <div key={current?.id} className="lyric-text-in">
        <div
          className={cn(
            "truncate tracking-tight",
            small ? "text-base font-semibold" : "text-2xl font-bold",
          )}
        >
          {current?.name ?? "未在播放"}
        </div>
        <div
          className={cn(
            "truncate text-muted-foreground",
            small ? "mt-0.5 text-xs" : "mt-1.5 text-sm",
          )}
        >
          {displayArtistsCurrent}
        </div>
      </div>

      {prevTrack && (
        <div aria-hidden className="lyric-text-out pointer-events-none absolute inset-0">
          <div
            className={cn(
              "truncate tracking-tight",
              small ? "text-base font-semibold" : "text-2xl font-bold",
            )}
          >
            {prevTrack.name}
          </div>
          <div
            className={cn(
              "truncate text-muted-foreground",
              small ? "mt-0.5 text-xs" : "mt-1.5 text-sm",
            )}
          >
            {displayArtistsPrev}
          </div>
        </div>
      )}
      </div>
    </div>
  );

  /** 播放控制：上一首 / 播放暂停 / 下一首 + 进度条 */
  const controlsBlock = (
    <div ref={controlsRef} className="w-full">
      {/* 竖屏大封面布局（且仅它）：外层列没有 gap，信息块与按键行原本贴死（实测 0.3px），
          表现为「离歌手信息太近、离进度条太远」。按键行上方留 15px、进度条上方收到 7px，
          进度条轨道位置不变而按键中心落在「歌手文字 ↔ 进度条」中点。
          横屏左列本来就有 gap-6 的均匀节奏，必须排除在外（否则这套边距会把它撑歪）。 */}
      <div
        className={cn(
          "flex items-center justify-center gap-3",
          isPortrait && !compact ? "mt-[15px]" : undefined,
        )}
      >
        <SkipButton direction="prev" onClick={prev} />
        <PlayPauseButton playing={playing} loading={loading} onClick={toggle} />
        <SkipButton direction="next" onClick={next} />
      </div>
      {/* 竖屏紧凑布局：按键与进度条留出透气间距；其余布局沿用原来的 24px（原 coverInner 的 gap-6） */}
      {/* 按键与进度条的间距：竖屏紧凑 8px；竖屏大封面 7px；
          横屏与「歌手→按键」一样压到 12px —— 轨道在它那一行里上下各留约 6px，
          所以边距取 6px，量出来才是 12px。
          ref 供 FLIP 单独给它做「横向等比拉伸」用 */}
      <div
        ref={progressRef}
        className={cn(
          "flex w-full items-center gap-3",
          compact ? "mt-2" : isPortrait ? "mt-[7px]" : "mt-[6px]",
        )}
      >
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatTime(progress)}
        </span>
        <ProgressSlider
          value={[progress]}
          max={Math.max(duration, 1)}
          step={0.1}
          dragging={seeking}
          // 拖动过程中只更新显示（进度数字 + 歌词预览），不真的跳转歌曲
          onValueChange={([v]) => {
            if (!seekingRef.current) {
              seekingRef.current = true;
              setSeeking(true);
            }
            setProgress(v);
            setCurrentTime(Math.round(v * 1000));
          }}
          // 松手才真正 seek
          onValueCommit={([v]) => {
            seekingRef.current = false;
            setSeeking(false);
            seek(v);
            setProgress(v);
            setCurrentTime(Math.round(v * 1000));
            // 进度条跳转同样是跳转：按同一套过渡处理（推目标值 + 标记一帧 + 隐去间奏点）
            markSeek(v);
          }}
        />
        <span className="w-10 shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatTime(duration)}
        </span>
      </div>
    </div>
  );

  /** 歌词播放器（各布局共用）。外面套错误边界：AMLL 因脏数据抛错时只让歌词区为空，
      不能让整棵 React 树被卸载（那就是用户看到的整页黑屏） */
  const renderLyrics = (className: string) => (
    <LyricPlayerBoundary resetKey={current?.id}>
      <LyricPlayer
        lyricLines={lines}
        currentTime={currentTime}
        playing={playing}
        isSeeking={isSeeking}
        alignAnchor={s.alignAnchor}
        alignPosition={s.alignPosition}
        enableSpring={s.enableSpring}
        enableScale={s.enableScale}
        enableBlur={s.enableBlur}
        hidePassedLines={s.hidePassedLines}
        wordFadeWidth={s.wordFadeWidth}
        linePosXSpringParams={s.posXSpring}
        linePosYSpringParams={s.posYSpring}
        lineScaleSpringParams={s.scaleSpring}
        onLyricLineClick={handleLyricLineClick}
        className={className}
        style={
          {
            "--amll-lp-font-family": s.fontFamily || undefined,
            "--amll-lp-font-weight": String(s.fontWeight),
            "--amll-lp-font-size": `${s.fontSize}px`,
            "--amll-lp-color": s.lyricColor,
          } as React.CSSProperties
        }
      />
    </LyricPlayerBoundary>
  );

  /**
   * 横屏左列的整体比例（设置里可调）。
   * 用 transform 缩放：布局盒尺寸不变，视觉上封面 / 信息 / 控制条一起按比例变化。
   */
  const leftColumnStyle = {
    transform: `scale(${s.leftColumnScale})`,
    transformOrigin: "center center",
  } as React.CSSProperties;

  /** 横屏布局：有歌词 → 左封面右歌词；无歌词 → 居中大封面 */
  const landscapeLayout = noLyrics ? (
    <div className="relative flex h-full select-none flex-col items-center justify-center px-6 pb-8 pt-16 md:pt-0">
      {/* 无歌词时的居中大封面：与有歌词的左列用同一套间距 ——
          封面→歌手 24px，歌手→按键、按键→进度条各 12px（父级不再用 gap，
          否则三段会被绑成同一个值、后两段压不下来） */}
      <div
        className="flex w-full max-w-sm flex-col items-center"
        style={leftColumnStyle}
      >
        {coverBox("large")}
        <div className="mt-6 w-full">{infoBlock(false)}</div>
        <div className="mt-3 w-full">{controlsBlock}</div>
      </div>
    </div>
  ) : (
    <div
      className="relative flex h-full select-none flex-col gap-6 px-6 pb-8 pt-16 md:flex-row md:justify-evenly md:gap-0 md:px-0 md:pt-0"
      style={{ "--lyrics-w": `${s.lyricsWidth}px` } as React.CSSProperties}
    >
      {/* 左列：封面 → 歌名/歌手 → 控制 → 进度条（整体按比例缩放，比例在设置里调）。
          间距改成显式控制：封面→歌手保持 24px，歌手→按键、按键→进度条各压到 12px
          （父级不再用 gap，否则三段会被绑成同一个值）。 */}
      <div
        className="flex w-full flex-col items-center justify-center md:w-96 md:shrink-0"
        style={leftColumnStyle}
      >
        {coverBox("large")}
        <div className="mt-6 w-full">{infoBlock(false)}</div>
        <div className="mt-3 w-full">{controlsBlock}</div>
      </div>

      {/* 右列：歌词（底部柔和渐隐，边界即容器底部） */}
      <div
        key={current?.id}
        className="lyrics-fade lyrics-bottom-fade relative min-h-0 w-full flex-1 overflow-hidden md:w-[var(--lyrics-w)] md:max-w-[calc(100%_-_30rem)] md:flex-none"
      >
        {renderLyrics("absolute inset-0")}
      </div>
    </div>
  );

  /**
   * 竖屏布局：紧凑（有歌词）与居中大封面共用同一套 DOM，
   * 只是换类名，因此封面 / 信息 / 控制条都能做 FLIP 动画。
   */
  const portraitLayout = (
    <div
      className={cn(
        "relative flex h-full select-none flex-col",
        !compact && "items-center justify-center px-6 pb-8 pt-16",
      )}
    >
      {/* 顶部 / 居中块：封面 + 歌名歌手（触屏按住这里可下滑关闭） */}
      <div
        {...dragHandlers}
        className={cn(
          "flex",
          isTouch && "touch-none select-none",
          compact
            ? "shrink-0 flex-row items-center gap-3 pb-3 pl-5 pr-16 pt-9"
            : "w-full max-w-sm flex-col items-center gap-6",
        )}
      >
        {coverBox(compact ? "compact" : "large")}
        {infoBlock(compact)}
      </div>

      {/* 歌词（仅紧凑布局展开）：高度恒定 —— 控制栏绝对定位不占布局空间，
          所以显示 / 隐藏控制栏时歌词位置完全不动，只有底部渐隐落点在移动。
          大封面布局下不能写 hidden（display:none 会让容器尺寸归零，AMLL 的内部
          布局与虚拟化会随之退化：每切一次少一点歌词、高亮错乱，多次后彻底没有）；
          也不能用 opacity-0 —— .lyrics-fade 的动画关键帧里有显式的 to{opacity:1}
          且 fill-mode 为 both，动画值会压过普通声明，opacity 根本不生效。
          这里用 visibility（不参与那条动画）隐藏，同时保留尺寸供 AMLL 正常布局。 */}
      <div
        key={current?.id}
        ref={lyricsBoxRef}
        className={cn(
          "lyrics-fade lyrics-bottom-fade min-h-0 overflow-hidden",
          compact ? "relative flex-1" : "lyrics-hidden absolute inset-0",
        )}
      >
        {renderLyrics("absolute inset-0")}
      </div>

      {/* 底部控制栏：绝对贴底，不占布局空间；隐藏时高度归零。
          max-height 用「实测高度」而不是固定 220px：
          否则展开时可见部分在曲线上半段就长完了，显得比收起快一截 */}
      <div
        className={cn(compact ? "absolute inset-x-0 bottom-0 z-20 px-5" : "w-full max-w-sm")}
        style={
          compact
            ? {
                maxHeight: controlsVisible ? Math.max(controlsHeight, 1) : 0,
                opacity: controlsVisible ? 1 : 0,
                pointerEvents: controlsVisible ? "auto" : "none",
                // FLIP 期间放开裁剪：控制条要先滑到旧位置再回来，被裁会缺一截
                overflow: flipping ? "visible" : "hidden",
                transition:
                  "max-height 0.45s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1)",
              }
            : undefined
        }
      >
        <div ref={controlsInnerRef} className={compact ? "pb-7" : undefined}>
          {controlsBlock}
        </div>
      </div>

      {/* 底部点击区：点这里唤出控制栏，而不是触发歌词跳转（z 低于控制栏，不挡按钮） */}
      {compact && (
        <button
          type="button"
          aria-label="显示播放控制"
          onClick={(e) => {
            e.stopPropagation();
            showControls();
          }}
          className="absolute inset-x-0 bottom-0 z-10 h-32"
        />
      )}

      {/* 稳定的唤回热区：控制栏隐藏后靠近它仍能重新唤出 */}
      {compact && (
        <div
          ref={controlsZoneRef}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-40"
        />
      )}
    </div>
  );

  return (
    <div
      ref={sheetRef}
      onAnimationEnd={(e) => {
        // 只认自己这一层的入场动画，避免子元素动画冒泡上来
        if (e.target === e.currentTarget && e.animationName === "sheet-enter") setEntering(false);
      }}
      className={cn(
        "fixed inset-0 z-40 overflow-hidden bg-background",
        // 入场：从下方整体滑入（触屏/鼠标、横屏/竖屏一致）
        entering && "sheet-enter",
        // 触屏：交给 CSS 抹平 AMLL 自带 hover 的粘滞残留（见 index.css）
        isTouch && "is-touch",
        // 跳转过渡期内直接隐掉间奏三点：点击歌词后小圆点应立刻消失（见 index.css）
        hideInterlude && "lyrics-hide-interlude",
        // 当前句已唱完、下一句尚未开始（间隔小到放不下间奏三点）：
        // 替 AMLL 清掉这一行的高亮并恢复普通模糊，行位置不动（见 index.css）
        currentLineDone && "lyrics-line-done",
        dragY > 0 && "rounded-t-[22px] shadow-2xl",
      )}
      style={{
        transform: dragY ? `translateY(${dragY}px)` : undefined,
        transition: dragging ? "none" : `transform ${SHEET_MOVE}`,
      }}
    >
      {/* AMLL 流动背景（其根元素是 display:contents，须用外层容器定位）
          即使没有在播放歌曲也要渲染，此时由渲染器使用默认底色生成流动效果；
          playing 固定为 true，避免暂停时背景冻结。
          设置里关掉流动背景后整块不渲染 —— 根节点自带 bg-background，会落到静态底色。 */}
      {/*
        背景分三种情况：
        1. 开着流动背景 → 渲染器一直跑；
        2. 关了流动背景、且已抓到冻结帧 → 只显示那张图（渲染器已卸载，省电）；
        3. 关了但还没抓到 → 先让渲染器把画面画出来供抓帧；若始终抓不到（画布被污染等），
           退回「封面模糊+压暗」的静态背景 —— 任何情况下都不能是一片纯黑。
      */}
      {s.bgEnabled ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <BackgroundRender
            album={bgAlbum}
            playing
            fps={s.bgFps}
            renderScale={s.bgRenderScale}
            flowSpeed={s.bgFlowSpeed}
            staticMode={s.bgStaticMode}
            hasLyric={!noLyrics}
          />
        </div>
      ) : bgFrozen ? (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${bgFrozen})` }}
        />
      ) : bgFrozen === "" ? (
        <div className="absolute inset-0 overflow-hidden">
          {/* 抓帧失败：用封面做静态背景，模糊并压暗，保证文字可读 */}
          <img
            src={bgAlbum}
            alt=""
            className="h-full w-full scale-110 object-cover blur-2xl brightness-[0.55]"
          />
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <BackgroundRender
            album={bgAlbum}
            playing
            fps={s.bgFps}
            renderScale={s.bgRenderScale}
            flowSpeed={s.bgFlowSpeed}
            staticMode={s.bgStaticMode}
            hasLyric={!noLyrics}
          />
        </div>
      )}
      {/* 暗色遮罩，保证文字可读 */}
      <div className="absolute inset-0 bg-background/55 backdrop-blur-2xl" />

      {/* 鼠标设备：叉号关闭（横竖屏位置一致） */}
      {!isTouch && (
        <CloseButton
          className="absolute right-7 top-6 z-20"
          sensitivity={s.closeButtonSensitivity}
          onClick={closeLyrics}
        />
      )}

      {/* 触屏设备：顶部下滑条（横竖屏位置一致）。
          按住下滑可以关闭；触屏没有右上角的叉号，所以**轻点小白条也直接关闭**。 */}
      {isTouch && (
        <>
          <div
            {...dragHandlers}
            onClick={() => {
              if (suppressDragClick.current) return; // 刚才是拖拽，不算点击
              closeLyrics();
            }}
            className="absolute inset-x-0 top-0 z-30 flex h-7 cursor-grab touch-none select-none items-center justify-center active:cursor-grabbing"
          >
            <span className="h-1 w-11 rounded-full bg-foreground/45" />
          </div>
          {/* 下滑条「附近」的加宽热区：小白条周围也能按住往下拖。
              刻意只占中间一带，避开左上角可点击的封面；
              并且从 top-7 开始（而不是 top-0）—— 否则它是后面的兄弟节点，
              会盖住上面的小白条，把轻点事件一起吃掉。 */}
          <div
            {...dragHandlers}
            aria-hidden
            className="absolute left-1/2 top-7 z-30 h-[68px] w-40 -translate-x-1/2 cursor-grab touch-none select-none"
          />
        </>
      )}

      {isPortrait ? portraitLayout : landscapeLayout}
    </div>
  );
}
