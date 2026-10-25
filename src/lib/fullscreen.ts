/**
 * 带 webkit 前缀的全屏 API。
 * 老版 Safari / 部分 iOS、Android WebView 只暴露 webkit 前缀版，
 * 只读标准属性会一直读到 undefined（"明明全屏了却说没全屏"）。
 */
type WebkitFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/** 进入浏览器 / WebView 全屏（"全屏网页"） */
export function requestFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) {
    el.requestFullscreen().catch(() => {
      /* 忽略：可能因权限或用户手势被拒绝 */
    });
  }
}

/**
 * 当前处于全屏的元素；不在全屏时为 null。
 * 标准属性与 webkit 前缀属性都读（两者都没有的浏览器视为不在全屏）。
 */
export function getFullscreenElement(): Element | null {
  const d = document as WebkitFullscreenDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/**
 * 浏览器自带全屏（F11 / 浏览器"全屏"菜单项）是否处于开启状态。
 *
 * 实机反馈确认：这条路**不走 Fullscreen API** ——
 *   · document.fullscreenElement 一直是 null（所以 getFullscreenElement() 看不见它）；
 *   · **不会派发** fullscreenchange（所以只监听事件永远收不到"按了 F11"）。
 * 唯一可用的判据是"窗口尺寸变成铺满屏幕"。两个方向都比对，
 * 避免"窗口很宽但很矮"（或反之）被误判成全屏；各留 4px 容差。
 */
export function isWindowFullscreen(): boolean {
  if (typeof window === "undefined" || typeof screen === "undefined") return false;
  const screenH = screen.height;
  const screenW = screen.width;
  if (!(screenH > 0) || !(screenW > 0)) return false;
  return window.innerHeight >= screenH - 4 && window.innerWidth >= screenW - 4;
}

/**
 * 当前是否「处于全屏」——两种"全屏"取并集：
 *  · Fullscreen API 全屏（沉浸歌词页请求的、或 Esc 退出会派发事件的那种）；
 *  · 浏览器自带全屏（F11，见 isWindowFullscreen）。
 */
export function isFullscreenNow(): boolean {
  return getFullscreenElement() !== null || isWindowFullscreen();
}

/**
 * 退出全屏。
 *
 * 返回值表示「这一次调用是否真的发起了退出」—— 沉浸歌词页关闭时据此决定
 * 要不要登记 markLyricsCloseExit()（本来就不在全屏时不会有 fullscreenchange，
 * 登记了反而会误吃下一次真正的退出全屏事件）。
 * 注意：F11 全屏不属于 API 全屏，这里读不到元素、也退不掉（浏览器不允许脚本退 F11）。
 */
export function exitFullscreen(): boolean {
  if (!getFullscreenElement()) return false;
  const d = document as WebkitFullscreenDocument;
  try {
    const ret = d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.();
    if (ret && typeof ret.catch === "function") {
      ret.catch(() => {
        /* 忽略 */
      });
    }
  } catch {
    /* 忽略 */
  }
  return true;
}

/**
 * 全屏状态变化事件名：标准事件与 webkit 前缀事件**都要听**，
 * 只用其中一个的话，某些 WebView 上会完全收不到通知。
 */
const FULLSCREEN_CHANGE_EVENTS = ["fullscreenchange", "webkitfullscreenchange"] as const;

/**
 * 订阅一切「全屏状态可能变了」的信号，回调里请自己用 isFullscreenNow() 重新判定。
 *
 * 两个事件源合并成一条通路：
 *  1) fullscreenchange / webkitfullscreenchange —— Fullscreen API 路径；
 *  2) resize —— 浏览器自带全屏（F11）**唯一**可用的信号（它不派发 fullscreenchange）。
 *     顺带也覆盖"把窗口拖到正好铺满屏幕"这种边缘情况。
 *
 * resize 在拖动窗口时会每帧连发，用 requestAnimationFrame 合并成每帧最多一次，
 * 既省掉重复评估，也让判定发生在布局稳定之后（innerHeight/screen.height 已更新完）。
 */
export function onFullscreenSignal(handler: () => void): () => void {
  let raf = 0;
  const run = () => {
    raf = 0;
    handler();
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(run);
  };

  for (const ev of FULLSCREEN_CHANGE_EVENTS) document.addEventListener(ev, schedule);
  window.addEventListener("resize", schedule);

  return () => {
    for (const ev of FULLSCREEN_CHANGE_EVENTS) document.removeEventListener(ev, schedule);
    window.removeEventListener("resize", schedule);
    if (raf) cancelAnimationFrame(raf);
  };
}

/**
 * 「这一段"非全屏"是**关闭沉浸歌词页**自己造成的」保护窗口（毫秒）。
 *
 * 为什么需要一个**时间窗**而不是一次性的布尔标记：
 * 退出全屏会**同时**触发 resize（窗口变小）与 fullscreenchange，谁先到并不确定；
 * 一次性标记会被先到的那个信号吃掉，后到的信号随即把还在播滑出动画（420ms，
 * 见 LyricsSheet.closeLyrics）的沉浸歌词页立刻卸载 —— 视觉上就是"闪一下"。
 * 窗口内所有"非全屏"判定一律放行（不做任何动作），到点自动过期、不会残留。
 */
const LYRICS_CLOSE_EXIT_GUARD_MS = 1000;
let lyricsCloseExitUntil = 0;

/** 登记「刚才这次退出全屏来自关闭沉浸歌词页」 */
export function markLyricsCloseExit() {
  lyricsCloseExitUntil = Date.now() + LYRICS_CLOSE_EXIT_GUARD_MS;
}

/** 当前是否仍处在该保护窗口内 */
export function isLyricsCloseExitPending(): boolean {
  return Date.now() < lyricsCloseExitUntil;
}

/** 立即作废该保护窗口（例如歌词页已经关完、又回到了全屏时） */
export function clearLyricsCloseExit() {
  lyricsCloseExitUntil = 0;
}

/**
 * 「浏览器全屏要按 Esc / F11 才能退出」的说明是否已经提示过。
 * 同一页面会话只提示一次：这是浏览器的安全规则，反复弹只是噪音。
 */
let browserFullscreenHintShown = false;

/** 提示原文（测试与文案都以此为准） */
export const BROWSER_FULLSCREEN_HINT = "浏览器全屏需要按 Esc 或 F11 退出（网页无权退出）";

/**
 * 用户在**浏览器自带全屏**（F11）里关闭沉浸歌词页时，解释一次"为什么全屏没退"。
 *
 * 「浏览器权限边界」这一事实（无法用代码绕过，也不是我们的 bug）：
 *  · 网页只能退出**自己通过 Fullscreen API 请求的**全屏（document.exitFullscreen）；
 *  · **F11 / 浏览器"全屏"菜单项属于浏览器自身的窗口状态，网页没有任何 API 能退出它**，
 *    既读不到元素（fullscreenElement 是 null），也收不到可用的退出手段。
 * 所以这里不尝试"修好"它，只把事实讲清楚。
 *
 * 触发条件严格限定为「窗口铺满 **且** 没有 API 全屏元素」：
 * 后者我们能退（exitFullscreen 已经在退），不需要也不该弹这条提示。
 * 返回是否真的弹了（便于调用方/测试判断）。
 */
export function showBrowserFullscreenHintOnce(showToast: (message: string) => void): boolean {
  if (browserFullscreenHintShown) return false;
  if (!isWindowFullscreen() || getFullscreenElement()) return false;
  browserFullscreenHintShown = true;
  showToast(BROWSER_FULLSCREEN_HINT);
  return true;
}
