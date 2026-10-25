import { GLASS_TRANSPARENCY_DEFAULT } from "./glassTone";

export type DoubleClickAction = "next" | "append" | "replace";
export type AlignAnchor = "top" | "bottom" | "center";
/** 退出沉浸歌词页按钮（关闭键）的灵敏度 */
export type CloseButtonSensitivity = "low" | "medium" | "high";
/**
 * 触屏竖屏底栏「展开态静置自动折成一行」的灵敏度。
 * 「高」= 等待时间最短 = 更容易自动折叠；「低」= 最不容易折叠。
 */
export type AutoCollapseSensitivity = "low" | "medium" | "high";
/** 横屏 / 竖屏 */
export type OrientationScope = "portrait" | "landscape";
/** 触屏设备 / 鼠标设备 */
export type DeviceMode = "touch" | "mouse";
/** 一台设备最多 4 档：触屏·横屏 / 触屏·竖屏 / 鼠标·横屏 / 鼠标·竖屏 */
export type SettingsProfileKey = `${DeviceMode}_${OrientationScope}`;

export interface SpringParams {
  mass: number;
  damping: number;
  stiffness: number;
  soft: boolean;
}

export interface AppSettings {
  // 通用
  neteaseHomeUrl: string;
  doubleClickAction: DoubleClickAction;
  fullscreenOnLyrics: boolean; // 进入全屏歌词页时是否自动全屏网页
  /**
   * 沉浸歌词跟随全屏（**仅电脑端**）：
   * 开启后「网页进入全屏 → 自动打开沉浸歌词页」「退出全屏 → 自动关闭沉浸歌词页」。
   * 默认关闭，此时全屏与沉浸歌词页互不影响（既有行为）。
   * 注意它与 fullscreenOnLyrics 是**两个方向**的联动，互为逆操作，都做了幂等处理
   * （见 hooks/useLyricsFollowFullscreen.ts 与 lib/fullscreen.ts）。
   */
  lyricsFollowFullscreen: boolean;
  preloadEnabled: boolean; // 歌曲预加载：剩余 10s 时提前加载下一首
  appFontFamily: string; // 软件字体（界面/歌曲信息），system-ui 表示系统默认
  closeButtonSensitivity: CloseButtonSensitivity; // 退出歌词页按钮灵敏度

  // AMLL 歌词
  alignAnchor: AlignAnchor;
  alignPosition: number; // 0 - 1
  lyricsWidth: number; // px，全屏歌词组件宽度（间距自动计算）
  /**
   * 锁屏上行歌词的时间偏移（毫秒）。
   * 符号约定：**负数 = 提前显示，正数 = 延后**（即偏移直接加在「播放位置」上）。
   * 默认 -600，即每句歌词提前 0.6 秒更新。
   */
  lockLyricOffsetMs: number;
  /** 锁屏上行每句歌词的最短停留（毫秒，0=不限制；短句密集时避免闪个不停） */
  lockLyricMinDwellMs: number;
  /** 触屏底栏液态玻璃的透明度（百分比，80=最实，94=接近全透明） */
  glassTransparency: number;
  /** 滑动选择器阻力（0=最滑，甩得最远；100=最涩，几乎甩不动） */
  flingResistance: number;
  /*
   * 下面三项是触屏停靠栏「液态玻璃手感」的三个旋钮。
   *
   * 与 glassTransparency / flingResistance 同属**分档保存**（不进 SHARED_SETTING_KEYS）：
   * 它们描述的是「手机竖屏那颗玻璃药丸的手感」，横屏 / 鼠标档本来就是另一套底栏，
   * 沿用既有玻璃项的处理方式即可。
   *
   * 映射公式只有一处定义（见文件末尾的 glassSnapMs / glassSpring / glassPress），
   * 组件与设置页说明都从那里取，避免文案与实际行为走偏。
   * 三个默认值 50 都精确落在「加这三个旋钮之前」的实测常量上。
   */
  /** 回位速度：松手后回到正确位置的快慢（0=最慢，100=最快；默认 50） */
  glassReturnSpeed: number;
  /** 回弹幅度：吸附时越过目标位置多远（0=完全不越界，100=冲过头最明显；默认 50） */
  glassBounce: number;
  /** 按压形变：按住时按钮 / 胶囊的形变幅度（默认 50） */
  glassPressDeform: number;
  /**
   * 触屏竖屏底栏：两栏展开态静置多久**自动折成一行**（三档灵敏度）。
   * 只要有任何交互（触摸 / 点击 / 滚动）就重新计时；合一态不计时。
   */
  autoCollapseSensitivity: AutoCollapseSensitivity;
  /**
   * 触屏竖屏底栏：内容区滚动**累计位移**（px，**不分方向**）达到该值 → 收成合一态。
   * 「累计」是相对**上次切换时**的位置：没到阈值的滚动不更新基线，所以小幅慢滑会一路累加。
   * 区间 20..400（见 clampDockCollapseDistance），默认 28 —— 精确等于引入这个设置项之前
   * 写死在 AppLayout 里的 SCROLL_DEAD_ZONE，不动滑块 = 今天的行为。
   */
  dockCollapseDistance: number;
  /** 横屏左侧一列（封面 / 歌曲信息 / 控制条）的整体比例，1 = 基准大小 */
  leftColumnScale: number;
  enableSpring: boolean;
  enableScale: boolean;
  enableBlur: boolean;
  hidePassedLines: boolean;
  wordFadeWidth: number;
  fontFamily: string; // 沉浸歌词字体，system-ui 表示系统默认
  fontWeight: number; // 100 - 900
  fontSize: number; // px
  lyricColor: string;
  posXSpring: SpringParams;
  posYSpring: SpringParams;
  scaleSpring: SpringParams;

  // AMLL 流动背景
  /** 是否开启流动背景。关闭后沉浸页用静态底色，下方各项也随之折叠 */
  bgEnabled: boolean;
  bgFps: number;
  bgFlowSpeed: number;
  bgRenderScale: number;
  bgStaticMode: boolean;

  /**
   * 是否把本机的「歌曲设置」（逐首的歌词 / 纯音乐标记等）共享给局域网内的其它设备。
   * 默认关闭；开启后本机代理会对外提供 GET /share/song-settings，
   * 其它设备在设置页填入本机 IP 即可一键添加。
   */
  shareSongSettings: boolean;

  /*
   * 锁屏兼容（进阶设置）：控制 iPhone/WebKit 锁屏媒体会话的两种行为。
   * 设置页有同名卡片（components/common/LockCompatExperiment.tsx）逐项解释。
   *
   * 已被实机验证的因果与取舍（改默认值前请先读）：
   *   · 不撤回 seekbackward/seekforward → 锁屏**进度条可拖**；代价是系统默认的
   *     「±10 秒」进退键会顶掉我们注册的 ⏮/⏭（WebKit 在该布局下忽略 previoustrack/nexttrack）。
   *   · 显式撤回这两个动作 → 锁屏恢复 ⏮/⏭，但**进度条变回只读**（两次实机验证）。
   *   · 关掉「把 <audio> 挂进文档」→ 锁屏的动作回调收不到（已实测）。
   *   · 关掉「每秒推 positionState」→ 进度条很可能不再可拖。
   *
   * **当前默认值（true / true）就是已验证可用的那套组合，不要随意改动。**
   */

  /** 是否把 Howler 的 `<audio>` 挂进文档（默认开：游离节点收不到锁屏动作回调） */
  lockMountAudio: boolean;
  /** 是否每秒推一次 positionState（默认开：锁屏进度条据此保持可拖） */
  lockPushPosition: boolean;
}

/**
 * 「收起触发距离」（设置项 dockCollapseDistance）的取值范围与默认值（px）。
 *
 * 默认 28 **精确等于**引入这个设置项之前 AppLayout 里写死的 SCROLL_DEAD_ZONE：
 * 不动滑块时，滚动切形态的行为与改动前逐像素一致。
 * 上下限 20 / 400 是可用性区间（20 已经相当灵敏，400 基本等于「半屏才收」）。
 */
export const DOCK_COLLAPSE_DISTANCE_MIN = 20;
export const DOCK_COLLAPSE_DISTANCE_MAX = 400;
export const DOCK_COLLAPSE_DISTANCE_DEFAULT = 28;

/**
 * 把「收起触发距离」钳到 20..400 的整数像素。
 * 非数字 / 缺失（老版本数据里没有这个键）时回落默认值 28；越界的手改值也在这里矫正。
 */
export function clampDockCollapseDistance(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : DOCK_COLLAPSE_DISTANCE_DEFAULT;
  return Math.min(DOCK_COLLAPSE_DISTANCE_MAX, Math.max(DOCK_COLLAPSE_DISTANCE_MIN, Math.round(n)));
}

export const DEFAULT_SETTINGS: AppSettings = {
  neteaseHomeUrl: "",
  doubleClickAction: "replace",
  fullscreenOnLyrics: true,
  // 默认关闭：「全屏」与「沉浸歌词页」保持互不影响（沿用既有行为）
  lyricsFollowFullscreen: false,
  preloadEnabled: true,
  appFontFamily: "system-ui",
  closeButtonSensitivity: "medium",

  alignAnchor: "center",
  alignPosition: 0.5,
  lyricsWidth: 600,
  /*
   * 锁屏歌词默认提前 0.6 秒：歌词行略早于实际人声出现，锁屏看起来更跟得上。
   * 符号约定见字段声明：负数=提前，正数=延后。
   */
  lockLyricOffsetMs: -600,
  lockLyricMinDwellMs: 0,
  /*
   * 默认 80%：滑块区间是 80..94（越大越透明），默认落在**最实**的那一端。
   * 映射公式见 lib/glassTone.ts：80% → 大胶囊透明度 0.20 + blur(18px) saturate(180%)。
   */
  glassTransparency: GLASS_TRANSPARENCY_DEFAULT,
  // 默认 50：居中的阻尼手感
  flingResistance: 50,
  /*
   * 三个玻璃手感旋钮的默认值都是 50 —— 它们逐项复现了「没有这三个滑块时」写死的常量：
   *   回位速度 50 → 吸附 460ms
   *   回弹幅度 50 → cubic-bezier(.34, 1.56, .64, 1)
   *   按压形变 50 → sx 1.015 / sy 1.003 / 拖动拉伸上限 0.035
   * 所以不动滑块时手感与改动前完全一致。公式见下方的 glassSnapMs / glassSpring / glassPress。
   */
  glassReturnSpeed: 50,
  glassBounce: 50,
  glassPressDeform: 50,
  // 默认「中」= 静置 10 秒自动折叠
  autoCollapseSensitivity: "medium",
  // 默认 28px = 引入这个设置项之前写死的 SCROLL_DEAD_ZONE
  dockCollapseDistance: DOCK_COLLAPSE_DISTANCE_DEFAULT,
  leftColumnScale: 1,
  enableSpring: true,
  enableScale: true,
  enableBlur: true,
  hidePassedLines: false,
  wordFadeWidth: 0.5,
  fontFamily: "system-ui",
  fontWeight: 600,
  fontSize: 32,
  lyricColor: "#ffffff",
  posXSpring: { mass: 1, damping: 10, stiffness: 100, soft: false },
  posYSpring: { mass: 0.9, damping: 15, stiffness: 90, soft: false },
  scaleSpring: { mass: 2, damping: 25, stiffness: 100, soft: false },

  bgEnabled: true,
  bgFps: 60,
  bgFlowSpeed: 2,
  bgRenderScale: 1,
  bgStaticMode: false,

  shareSongSettings: false,

  // 锁屏兼容：默认「开 + 开」= 实机验证过可用的组合（进度条可拖、锁屏按钮/切歌回调可用）
  lockMountAudio: true,
  lockPushPosition: true,
};

/**
 * 三档灵敏度对应的「静置时长」（毫秒）。
 * 只在这一处定义：AppLayout 用它计时，设置页用它写说明文案，两边不会走偏。
 */
export const AUTO_COLLAPSE_DELAY_MS: Record<AutoCollapseSensitivity, number> = {
  high: 5_000,
  medium: 10_000,
  low: 20_000,
};

/* ------------------------------------------------------------------
 * 触屏底栏「液态玻璃手感」的映射（唯一出处）
 *
 * 三个滑块都是 0..100，默认 50，且默认值逐项等于改动前写死在
 * components/layout/TouchDockNav.tsx 里的常量 —— 不动滑块 = 今天的观感。
 *
 *   回位速度 v：吸附时长 = 720 - (v/100)*520 ms
 *               0 → 720ms，50 → 460ms（原 SNAP_EASE），100 → 200ms
 *   回弹幅度 v：cubic-bezier(.34, y1, .64, 1)，y1 = 1.0 + (v/100)*1.12
 *               0 → 1.00（完全不越过目标），50 → 1.56（原 SPRING），100 → 2.12
 *   按压形变 v：sx = 1 + (v/100)*0.03，sy = 1 + (v/100)*0.006，
 *               拖动拉伸上限 = (v/100)*0.07
 *               0 → 1 / 1 / 0（无形变），50 → 1.015 / 1.003 / 0.035（原常量），
 *               100 → 1.03 / 1.006 / 0.07
 *
 * 注意「回弹幅度」改的是**越过目标位置多远**（过冲量），不是弹几下：
 * 曲线仍是单调到位的一次落定（x1 < 1 保证不来回振荡），只是 y1 越大冲得越远。
 * 「滑动阻力」（flingResistance）管的是甩动能滑多远，与本组吸参数互不影响。
 * ------------------------------------------------------------------ */

/** 吸附 / 回位时长（毫秒）：0 → 720ms，50 → 460ms，100 → 200ms */
export const GLASS_SNAP_MS_SLOW = 720;
export const GLASS_SNAP_MS_FAST = 200;

export function glassSnapMs(v: number): number {
  const t = Math.min(100, Math.max(0, v ?? 50)) / 100;
  return Math.round(GLASS_SNAP_MS_SLOW - t * (GLASS_SNAP_MS_SLOW - GLASS_SNAP_MS_FAST));
}

/** 弹性曲线的第二个控制点的 y（越大越冲过头）：0 → 1.0，50 → 1.56，100 → 2.12 */
export function glassBounceY1(v: number): number {
  const t = Math.min(100, Math.max(0, v ?? 50)) / 100;
  return Number((1 + t * 1.12).toFixed(3));
}

/** 弹性曲线（先冲过目标一点再回来）：x1/x2 固定，只有 y1 随「回弹幅度」变 */
export function glassSpring(v: number): string {
  return `cubic-bezier(.34,${glassBounceY1(v)},.64,1)`;
}

export interface GlassPressGeometry {
  /** 按住 / 点击时的横向放大 */
  sx: number;
  /** 按住 / 点击时的纵向放大 */
  sy: number;
  /** 拖动时额外拉伸的上限（越大跟手拉得越长） */
  stretch: number;
}

/** 按压形变：0 → 1 / 1 / 0，50 → 1.015 / 1.003 / 0.035，100 → 1.03 / 1.006 / 0.07 */
export function glassPress(v: number): GlassPressGeometry {
  const t = Math.min(100, Math.max(0, v ?? 50)) / 100;
  return {
    sx: Number((1 + t * 0.03).toFixed(4)),
    sy: Number((1 + t * 0.006).toFixed(4)),
    stretch: Number((t * 0.07).toFixed(4)),
  };
}

/**
 * 高亮胶囊（按住拖动时那枚「变色透镜」）的按下放大系数。
 *
 * 它和 glassPress 的 sx **同一条轴**，只是倍率不同 —— 原来这里写死 `scale(1.05)`，
 * 于是「按压形变」这个滑块对胶囊完全无效（实测：滑块 0 与 100 时内层矩阵都是
 * 1.0307，差别在噪声里）。
 *
 * 标定方式：让**默认值 50 精确等于原来的 1.05**（硬标准：不动滑块 = 今天的观感），
 * 同时让 0 真的「完全无形变」：
 *   0   → 1.000（不放大）
 *   50  → 1.050（= 改动前写死的值）
 *   100 → 1.100
 * 放大上限不会溢出药丸：透镜层被 rounded-full + 父层裁切。
 */
export function glassLensScale(v: number): number {
  const t = Math.min(100, Math.max(0, v ?? 50)) / 100;
  const sx = 1 + t * 0.03;
  // 以 sx 的 0.015 增量对应透镜的 0.05 增量（50 时正好 1.05）等比放大
  return Number((1 + (sx - 1) * (0.05 / 0.015)).toFixed(4));
}


/**
 * 这些设置「所有设备状态共用」，不随「触屏/鼠标」「横屏/竖屏」变化：
 *  - 网易云个人主页链接
 *  - 双击歌曲的行为
 *  - 是否启用歌曲预加载
 *  - 沉浸歌词是否跟随全屏（仅电脑端）
 *
 * 其余**全部**设置都会按 4 种设备状态分别保存，互不影响。
 *
 * 注意触屏底栏那几项设置（glassTransparency / flingResistance /
 * glassReturnSpeed / glassBounce / glassPressDeform / autoCollapseSensitivity /
 * dockCollapseDistance）**都不在这里** ——
 * 它们只在「触屏 + 竖屏」那颗玻璃药丸上生效，横屏用 Sidebar、鼠标用 BottomNav，
 * 按档保存正好让手机与桌面各留一套手感，沿用既有玻璃项的写法。
 * 新增的 dockCollapseDistance（收起触发距离）与同一张卡片里的静置折叠灵敏度同类：
 * 它只对触屏竖屏的滚动切形态生效，所以同样**分档保存**。
 */
export const SHARED_SETTING_KEYS = [
  "neteaseHomeUrl",
  "doubleClickAction",
  "preloadEnabled",
  // 共享开关是「这台机器对外的行为」，与触屏/横竖屏无关，所以也是共用项
  "shareSongSettings",
  /*
   * 「沉浸歌词跟随全屏」同样共用：它是「这台电脑的全屏 ↔ 歌词页联动行为」，
   * 与触屏/鼠标、横屏/竖屏无关。桌面窗口拖窄后会被判成竖屏档，若按档保存就会出现
   * "竖屏开了、拉宽又关掉"的迷之现象（与下面两个锁屏兼容开关同理）。
   */
  "lyricsFollowFullscreen",
  /*
   * 两个「锁屏兼容」开关也共用：它们描述的是"这台设备上跑的是哪套锁屏方案"，
   * 与横竖屏/触屏无关；按档保存会出现"竖屏关掉了、转横屏又打开"这种迷之现象。
   */
  "lockMountAudio",
  "lockPushPosition",
] as const satisfies readonly (keyof AppSettings)[];

export type SharedKey = (typeof SHARED_SETTING_KEYS)[number];
export type ScopedKey = Exclude<keyof AppSettings, SharedKey>;
export type ScopedSettings = Pick<AppSettings, ScopedKey>;
export type SharedSettings = Pick<AppSettings, SharedKey>;

const SHARED_KEY_SET: ReadonlySet<string> = new Set(SHARED_SETTING_KEYS);

/** 除上面这些「共用项」外，全部按档保存（直接从默认设置的键推导，避免以后加设置漏项） */
export const SCOPED_SETTING_KEYS = (Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]).filter(
  (k): k is ScopedKey => !SHARED_KEY_SET.has(k),
);

export function isSharedKey(key: string): boolean {
  return SHARED_KEY_SET.has(key);
}

/** 取出「分档保存」的键 */
export function pickScoped(source: Partial<AppSettings>): ScopedSettings {
  const out: Record<string, unknown> = {};
  for (const k of SCOPED_SETTING_KEYS) {
    if (k in source) out[k] = (source as Record<string, unknown>)[k];
  }
  return out as ScopedSettings;
}

/** 取出「共用」的键 */
export function pickShared(source: AppSettings): SharedSettings {
  const out: Record<string, unknown> = {};
  const bag = source as unknown as Record<string, unknown>;
  for (const k of SHARED_SETTING_KEYS) {
    out[k] = bag[k];
  }
  return out as SharedSettings;
}
