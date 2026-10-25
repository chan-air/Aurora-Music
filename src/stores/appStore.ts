import { create } from "zustand";

/** 一条提示框。id 唯一，用来让 React 为每条提示建立独立元素（进出场动画才能各自播放） */
export interface ToastItem {
  id: number;
  message: string;
}

/**
 * 同时最多保留几条提示。
 * 需求：新的入场时旧的被压在下面，**下面最多显示 2 个压住的** —— 也就是总共 3 条。
 * 超出的丢掉最旧的。
 */
export const TOAST_MAX = 3;

let toastSeq = 0;

interface AppState {
  /** 全屏歌词页是否展开 */
  lyricsOpen: boolean;
  setLyricsOpen: (open: boolean) => void;

  /**
   * 「这次全屏会话里用户不要歌词页」门闩。
   *
   * 为什么要有它：浏览器自带全屏（F11）**网页无权退出**，用户只能在 F11 里点关闭键
   * 关掉沉浸歌词页。若跟随逻辑不管这件事，此后任何一个 resize 信号（窗口一有风吹草动）
   * 都会把歌词页**再弹回来**，与用户刚做的操作打架 —— 用户看到的就是"关不掉"。
   * 所以用户主动关闭时落门闩，门闩生效期间跟随逻辑不得自动打开。
   *
   * 抬起时机（见 hooks/useLyricsFollowFullscreen.ts 与下面的 setLyricsOpen）：
   *  ① 全屏状态**真的**发生变化（退出全屏 → 再进入全屏应重新自动打开）；
   *  ② 用户自己重新打开歌词页（任何 setLyricsOpen(true) 都会顺带抬起）。
   */
  lyricsUserClosed: boolean;
  /** 用户主动关闭沉浸歌词页（关闭按钮 / 下滑手势 / 任何 UI 途径）→ 落门闩 */
  markLyricsUserClosed: () => void;
  /** 抬起门闩（全屏状态变化 / 用户重新打开歌词页时） */
  clearLyricsUserClosed: () => void;

  /** 列表中选中的歌曲（单击选中，双击执行动作） */
  selectedId: number | null;
  setSelectedId: (id: number | null) => void;

  /**
   * 最近一次**归属明确**的导航路径（也就是最近一次「当前页确实是底栏四项里某一项」的路径）。
   *
   * 用途：/favorites、/playlist/:id 这类页面本身不属于导航四项，
   * 高亮要「从哪来回哪去」—— 沿用来源那一项（详见 components/layout/nav.ts）。
   *
   * 存路径而不是下标：导航项顺序若调整，下标就失效了，而路径永远能重新解析出归属。
   * 初始为 null：此时没有任何来源可沿用，解析函数会退回 -1（不高亮）。
   */
  lastNavPath: string | null;
  /** 记录来源路径。只在值真的变化时写入，避免每帧渲染都触发一次订阅更新 */
  recordNavPath: (path: string) => void;

  /** 提示框队列（按到达顺序，末尾最新） */
  toasts: ToastItem[];
  showToast: (msg: string) => void;
  /** 移除某一条（退场动画播完后调用） */
  dismissToast: (id: number) => void;
  clearToast: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  lyricsOpen: false,
  lyricsUserClosed: false,
  /*
   * 打开歌词页一律视为"用户要它"，顺带抬起门闩 —— 鼠标端的封面/话筒按钮、
   * 触屏端的歌曲栏与药丸都只是调 setLyricsOpen(true)，不必各自记得清门闩。
   * 关闭时不落门闩：跟随逻辑退出全屏时也会调 setLyricsOpen(false)，
   * 那**不是**用户主动关闭（落门闩只发生在 LyricsSheet.closeLyrics 这一个入口）。
   */
  setLyricsOpen: (open) =>
    set(open ? { lyricsOpen: true, lyricsUserClosed: false } : { lyricsOpen: false }),

  markLyricsUserClosed: () => set({ lyricsUserClosed: true }),
  // 返回原 state 时 zustand 判定为「无变化」，不会触发订阅者重渲染
  clearLyricsUserClosed: () => set((s) => (s.lyricsUserClosed ? { lyricsUserClosed: false } : s)),

  selectedId: null,
  setSelectedId: (id) => set({ selectedId: id }),

  lastNavPath: null,
  // 返回原 state 时 zustand 判定为「无变化」，不会触发订阅者重渲染
  recordNavPath: (path) => set((s) => (s.lastNavPath === path ? s : { lastNavPath: path })),

  toasts: [],
  showToast: (msg) =>
    set((s) => ({
      toasts: [...s.toasts, { id: ++toastSeq, message: msg }].slice(-TOAST_MAX),
    })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearToast: () => set({ toasts: [] }),
}));
