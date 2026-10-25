import { useEffect, useRef, useState } from "react";

import { useSyncExternalStore } from "react";

/**
 * 触屏竖屏底栏「两栏展开态 ↔ 一行合一态」的**形变（FLIP）**协调器。
 *
 * 三对元素的对应关系（合一态 ← 展开态）：
 *
 *   左圆（当前页图标） ← 停靠栏里的**高亮胶囊**（`[role="slider"]`，也就是变色透镜的本体）
 *   右圆（搜索）       ← 停靠栏本身（nav，那颗大药丸）
 *   中间歌曲胶囊       ← 展开态的歌曲栏（TouchSongBar）
 *
 * 做法是最朴素的 FLIP：切换**之前**先量出源元素的真实矩形，切换之后再让目标元素
 * 从这个矩形（位置 + 尺寸）动画到它自己的最终位置。
 *
 * ── 为什么每帧自己算，而不是丢给一条 CSS transition ──────────────────────
 * 需求要三件事同时成立，一条 CSS transition 做不到：
 *
 *  1) **到底之后要朝运动方向多走一小段再回弹**（不是平滑到位就停）；
 *  2) 过程中允许**挤压-拉伸**（沿运动主轴轻微变形，稳定后回到常态）；
 *  3) 圆圈里的**图标不能被拉扁**（非等比缩放会把 SVG 字形拉长）。
 *
 * 其中第 3 点决定了必须是逐帧计算：图标的反向缩放要**逐帧精确等于**当前缩放比的
 * 倒数（`scale(1/k)`），CSS 并行动画只能做到关键帧处近似相等，中间会露馅。
 *
 * ── 曲线 ────────────────────────────────────────────────────────────────
 * 行程比例用项目既有的 `cubic-bezier(.34,1.56,.64,1)`（TouchDockNav 的 SPRING）：
 * 它在 t≈0.6 之后会**越过 1**（最大约 1.10），越过的部分正是「多走一小段」。
 * 但越界量是**相对总行程**的 —— 右圆 ← 大药丸是 370px → 52px（约 7 倍比例），
 * 直接拿它乘尺寸比例会瞬间把元素缩到几像素甚至翻面。所以这里把它拆开用：
 *
 *   · 位置与尺寸：`min(p, 1)` —— 单调、不越界，从源矩形长到自己的位置；
 *   · 越界部分 `max(p - 1, 0)`：归一化成 0..1 的“过冲包络”，只**额外推动一小段位移**
 *     （最多 OVERSHOOT_PX 像素，与行程长短无关，因此不会失控），并驱动挤压-拉伸。
 *
 * 合起来就是：**先到位、再朝运动方向弹出去一点、然后回弹归位**。
 */

/** 形变方向：collapse = 两栏 → 一行；expand = 一行 → 两栏 */
export type MorphDirection = "collapse" | "expand";

/**
 * 参与形变的槽位。前缀是「图层」：
 *   full:* = 展开态那一叠（歌曲栏 + 大药丸）；mini:* = 合一态那一行。
 */
export type MorphSlot =
  | "full:left"
  | "full:song"
  | "full:dock"
  | "mini:left"
  | "mini:song"
  | "mini:right";

/** 折叠（两栏 → 一行）：目标元素 ← 源元素 */
const COLLAPSE_PAIRS: [MorphSlot, MorphSlot][] = [
  ["full:left", "mini:left"],
  ["full:song", "mini:song"],
  ["full:dock", "mini:right"],
];

/** 展开（一行 → 两栏）：正是上面三对的逆映射 */
const EXPAND_PAIRS: [MorphSlot, MorphSlot][] = [
  ["mini:left", "full:left"],
  ["mini:song", "full:song"],
  ["mini:right", "full:dock"],
];

/**
 * 形变总时长（ms）。
 *
 * 用户明确要求「丝滑、有弹性，不要求快」，所以这里给得比停靠栏的吸附节奏
 * （460ms）更宽裕：过冲与挤压-拉伸都要有时间被看见，太快就只剩"闪一下"。
 * 想再慢/再快只改这一个数（520 偏利落，800 偏悠长）。
 */
export const MORPH_MS = 680;

/** 项目既有的弹性曲线（TouchDockNav 的 SPRING） */
const SPRING = { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };

/** 过冲位移上限（px）：与行程长短无关，避免大比例形变时冲出屏幕 */
const OVERSHOOT_PX = 10;
/** 挤压-拉伸的最大幅度（沿运动主轴的比例） */
const STRETCH = 0.04;

/**
 * 需要「反向缩放补偿」的内容元素：形变过程中它们的**形状不能被拉变形**。
 *
 * 只登记**目标尺寸仍装得下它们原本大小**的元素 —— 也就是左右两个小圆里的图标：
 * 图标 24px，圆形按钮最小也有 52px，反向补偿后图标始终是 24px 的正圆比例。
 * 歌曲胶囊 / 歌曲栏 / 大药丸**不能**这么做：它们的内容（歌名、四个导航项）
 * 在最小那一端根本放不下原始宽度，补偿后会直接溢出玻璃；
 * 大药丸更不能碰 —— 变色透镜靠「高亮层与底层像素严格重合」工作，
 * 给它的子树单独加变换会破坏这份重合（见 TouchDockNav 顶部的几何说明）。
 */
const CONTENT_SELECTOR: Partial<Record<MorphSlot, string>> = {
  "mini:left": "svg",
  "mini:right": "svg",
};

/* ---------------- 三次贝塞尔求值（把 SPRING 变成可逐帧调用的函数） ---------------- */

const bezA = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
const bezB = (a1: number, a2: number) => 3 * a2 - 6 * a1;
const bezC = (a1: number) => 3 * a1;
const bezAt = (u: number, a1: number, a2: number) => ((bezA(a1, a2) * u + bezB(a1, a2)) * u + bezC(a1)) * u;
const bezSlope = (u: number, a1: number, a2: number) => 3 * bezA(a1, a2) * u * u + 2 * bezB(a1, a2) * u + bezC(a1);

/** 由 x 反解参数 u：牛顿迭代 + 二分兜底 */
function solveU(x: number, p1x: number, p2x: number): number {
  let u = x;
  for (let i = 0; i < 8; i++) {
    const err = bezAt(u, p1x, p2x) - x;
    if (Math.abs(err) < 1e-4) return u;
    const d = bezSlope(u, p1x, p2x);
    if (Math.abs(d) < 1e-6) break;
    u -= err / d;
  }
  let lo = 0;
  let hi = 1;
  u = x;
  for (let i = 0; i < 40; i++) {
    const v = bezAt(u, p1x, p2x);
    if (Math.abs(v - x) < 1e-5) break;
    if (v < x) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return u;
}

/** 归一化时间 → SPRING 的行程比例（中段会越过 1） */
export function springProgress(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return bezAt(solveU(x, SPRING.x1, SPRING.x2), SPRING.y1, SPRING.y2);
}

/** SPRING 的最大越界量（约 0.10），用来把过冲包络归一化到 0..1 */
const SPRING_PEAK = (() => {
  let peak = 0;
  for (let i = 0; i <= 200; i++) peak = Math.max(peak, springProgress(i / 200) - 1);
  return peak > 0.001 ? peak : 1;
})();

/* ---------------- 槽位登记 ---------------- */

const slots = new Map<MorphSlot, HTMLElement>();

export function registerMorphSlot(slot: MorphSlot, el: HTMLElement | null): void {
  if (el) slots.set(slot, el);
  else slots.delete(slot);
}

/* ---------------- 逐帧形变 ---------------- */

interface ContentSave {
  el: HTMLElement;
  transform: string;
  transformOrigin: string;
}

interface MorphRun {
  token: number;
  el: HTMLElement;
  content: ContentSave[];
  savedTransform: string;
  savedOrigin: string;
  savedWillChange: string;
  /** 元素自身行内 transform 里的**基础位移**（高亮胶囊靠它定位，形变必须与它复合） */
  base: { x: number; y: number };
  from: DOMRect;
  to: DOMRect;
  /** 运动方向的单位向量与距离（决定过冲方向与挤压轴） */
  ux: number;
  uy: number;
  /** 位置：源中心 - 目标中心 */
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  start: number;
  raf: number;
  /** rAF 被饿死时的收尾兜底 */
  backstop: number;
  /** 本帧写进行内的 transform 原文：用来识别「被别人覆盖了」 */
  lastWritten: string;
  /**
   * 行内 transform 的守卫。
   *
   * 形变是逐帧写 `el.style.transform` 的，而 React 在重渲染时**也会**写这个元素的
   * 行内 transform（高亮胶囊的定位、大药丸的按压位移都在 style 里）。一旦撞上，
   * 那一帧就会退回 React 写的值 —— 表现是元素"抖一下/顿一下"，极端情况下看着像
   * "晚一点才开始动"。MutationObserver 在**绘制前**（微任务）回调，所以这里发现
   * 被覆盖就立刻把本帧的值写回去，用户完全看不到那一帧。
   */
  guard: MutationObserver | null;
}

const runs = new WeakMap<HTMLElement, MorphRun>();
/** 正在跑的形变数量（WeakMap 没有 size） */
let activeRuns = 0;
let tokenSeq = 0;

/* ---------------- 「正在形变」与「按压反馈是否可用」广播 ----------------
 *
 * 为什么需要它：形变和「跟随手指改变形状」那套反馈（大药丸的按压位移/拉伸、
 * 高亮胶囊的按下放大与跟手位移、圆形按钮的 active 缩放）**都写在 transform 上**。
 * 两者同时生效时元素会被二次缩放 —— 用户实测到的正是「切换动画进行中按住不放，
 * 两侧圆被压扁，约 0.5s（= 动画时长）后自己恢复」。
 *
 * 规矩：
 *   · 形变开始时，**如果此刻正有一根手指按着**，按压反馈一律停用（并把已生效的按压态收掉）；
 *     若没有手指按着（滚动触发的形变、点完才展开的形变），则完全不受影响 ——
 *     否则「形变之后第一次按下没反应」会变成新的 bug。
 *   · 被停用的那次，形变结束后**不能立刻恢复** —— 那根还按着的手指会在动画结束的瞬间
 *     弹出一个形变。必须等这一次按下结束（pointerup / pointercancel / touchend）
 *     才重新可用，也就是「要重新按一次」。
 */
const morphListeners = new Set<() => void>();
const pressListeners = new Set<() => void>();
let morphingNow = false;
let pressSuppressed = false;
let pointerHeld = false;
let releaseBound = false;

function emit(listeners: Set<() => void>) {
  listeners.forEach((fn) => fn());
}

function setMorphing(next: boolean) {
  if (morphingNow === next) return;
  morphingNow = next;
  emit(morphListeners);
}

function setPressSuppressed(next: boolean) {
  if (pressSuppressed === next) return;
  pressSuppressed = next;
  emit(pressListeners);
}

/** 全局只需挂一次：跟踪「现在有没有手指按着」，并在抬起时解除抑制 */
function bindPointerTracking() {
  if (releaseBound || typeof window === "undefined") return;
  releaseBound = true;
  const down = () => {
    pointerHeld = true;
  };
  const up = () => {
    pointerHeld = false;
    setPressSuppressed(false);
  };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("touchend", up, true);
  window.addEventListener("touchcancel", up, true);
}

function subscribeMorph(fn: () => void): () => void {
  morphListeners.add(fn);
  return () => morphListeners.delete(fn);
}

function subscribePress(fn: () => void): () => void {
  pressListeners.add(fn);
  return () => pressListeners.delete(fn);
}

/** 此刻是否正处于形变动画中 */
export function isMorphing(): boolean {
  return morphingNow;
}

/** React 侧读取「是否正在形变」（形变开始 / 结束时各触发一次重渲染） */
export function useMorphing(): boolean {
  return useSyncExternalStore(subscribeMorph, isMorphing, () => false);
}

/**
 * 按压反馈（按下放大 / 跟手拉伸 / active 缩放）现在能不能生效。
 * 形变期间为 false；形变结束后若那根手指还按着，仍然为 false，直到抬起。
 */
export function usePressFeedbackEnabled(): boolean {
  return useSyncExternalStore(
    subscribePress,
    () => !pressSuppressed,
    () => true,
  );
}

/** 从行内 transform 里取出基础位移（只认纯位移：本项目里只有高亮胶囊的定位用） */
function parseBaseTranslate(transform: string): { x: number; y: number } {
  if (!transform) return { x: 0, y: 0 };
  const m =
    /translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(transform) ??
    /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(transform);
  if (!m) return { x: 0, y: 0 };
  return { x: Number.parseFloat(m[1]) || 0, y: Number.parseFloat(m[2]) || 0 };
}

/** 收尾：把行内样式还原成动画开始前的样子（React 写的值原样还回去） */
function finishRun(run: MorphRun): void {
  if (runs.get(run.el) !== run) return;
  runs.delete(run.el);
  activeRuns = Math.max(0, activeRuns - 1);
  if (run.raf) cancelAnimationFrame(run.raf);
  if (run.backstop) window.clearTimeout(run.backstop);
  if (run.guard) {
    run.guard.disconnect();
    run.guard = null;
  }
  run.el.style.transform = run.savedTransform;
  run.el.style.transformOrigin = run.savedOrigin;
  run.el.style.willChange = run.savedWillChange;
  for (const c of run.content) {
    c.el.style.transform = c.transform;
    c.el.style.transformOrigin = c.transformOrigin;
  }
  // 最后一个形变结束：解除「正在形变」。按压反馈不会因此立刻恢复 ——
  // 还要等这一次按下抬起（见 usePressFeedbackEnabled）
  setMorphing(activeRuns > 0);
  // 兜底：如果此刻并没有手指按着，就没有什么好等的，直接解除抑制
  // （防止某次 pointerup 没被监听到，导致之后所有按压反馈都失效）
  if (activeRuns === 0 && !pointerHeld) setPressSuppressed(false);
}

/** 立刻收尾某个元素上正在进行的形变（连续切换时必须先收尾再重新量） */
export function cancelMorph(el: HTMLElement | null): void {
  if (!el) return;
  const run = runs.get(el);
  if (run) finishRun(run);
}

/** 第 ts（0..1）帧的形变状态 */
function applyRun(run: MorphRun, ts: number): void {
  const p = springProgress(ts);
  /** 单调段：位置与尺寸从这里插值 */
  const g = Math.min(p, 1);
  /** 过冲包络：只有越过终点之后才 > 0，稳定时回到 0 */
  const over = Math.max(p - 1, 0) / SPRING_PEAK;

  // 尺寸比例：从“源矩形 / 目标矩形”长到 1
  const sx = run.sx + (1 - run.sx) * g;
  const sy = run.sy + (1 - run.sy) * g;

  /*
   * 挤压-拉伸：**只有一次**，而且只发生在过冲那一段。
   *
   * 之前还在起步阶段加过一次「被拽出来」的轻挤，那样形状信号会出现两个峰
   * （先挤后拉），数起来像弹了两次。现在去掉起步挤压：形变过程中的形状变化
   * 由「源矩形 → 目标矩形」的非等比插值本身给出，过冲段再叠一次拉伸即可，
   * 到位后形状一动不动。
   */
  const stretch = STRETCH * over;
  const axisX = Math.abs(run.ux) >= Math.abs(run.uy);
  const along = 1 + stretch;
  const across = 1 - stretch * 0.5;
  const kx = sx * (axisX ? along : across);
  const ky = sy * (axisX ? across : along);

  // 位置：中心对齐插值 + 沿运动方向越过终点的一小段（过冲）
  const tx = run.dx * (1 - g) + run.ux * OVERSHOOT_PX * over;
  const ty = run.dy * (1 - g) + run.uy * OVERSHOOT_PX * over;

  /*
   * 与元素自身的基础位移复合。
   * 形变是「绕自身中心缩放 + 平移」，而高亮胶囊的定位也是 transform：
   *   transform: T_m S T_b   →   元素中心 = 布局中心 + T_m + S·T_b
   * 要让它在 ts=1 时正好回到基础位移处、在 ts=0 时落在源矩形中心，
   * 取 T_m = 目标位移 + (1 - S)·T_b 即可（基础位移是纯位移，本项目只有这一种）。
   */
  const bx = run.base.x;
  const by = run.base.y;
  const mx = tx + (1 - kx) * bx;
  const my = ty + (1 - ky) * by;
  run.el.style.transform =
    `translate3d(${mx.toFixed(2)}px, ${my.toFixed(2)}px, 0) scale(${kx.toFixed(4)}, ${ky.toFixed(4)})` +
    (bx || by ? ` translate3d(${bx.toFixed(2)}px, ${by.toFixed(2)}px, 0)` : "");
  // 记下本帧写进去的原文，供守卫识别"被 React 覆盖了"
  run.lastWritten = run.el.style.transform;

  // 内容反向缩放：逐帧精确取倒数，图标因此全程保持原始比例
  for (const c of run.content) {
    c.el.style.transform = `scale(${(1 / kx).toFixed(5)}, ${(1 / ky).toFixed(5)})`;
  }
}

/** 让某个元素从 from 矩形形变回它自己的位置 */
function startFlip(dstSlot: MorphSlot, el: HTMLElement, from: DOMRect): void {
  cancelMorph(el);
  const to = el.getBoundingClientRect();
  if (to.width <= 0 || to.height <= 0) return;

  const sx = from.width / to.width;
  const sy = from.height / to.height;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
  // 位置与尺寸都几乎没变（例如胶囊正好落在圆里）就不用动画了
  if (Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01 && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

  const dist = Math.hypot(dx, dy);
  /*
   * 运动方向 = **从源指向目标** 的单位向量。
   * dx/dy 是「源中心 - 目标中心」（源在目标的哪一侧），方向正好相反，所以取负号 ——
   * 过冲必须沿**运动方向**再多走一小段（越过目标），否则就成了"往回缩"。
   */
  const ux = dist > 0.5 ? -dx / dist : 0;
  const uy = dist > 0.5 ? -dy / dist : 0;

  const savedTransform = el.style.transform;
  const savedOrigin = el.style.transformOrigin;
  const savedWillChange = el.style.willChange;
  const contentSel = CONTENT_SELECTOR[dstSlot];
  const contentEls = contentSel ? Array.from(el.querySelectorAll<HTMLElement>(contentSel)) : [];
  const content: ContentSave[] = contentEls.map((c) => ({
    el: c,
    transform: c.style.transform,
    transformOrigin: c.style.transformOrigin,
  }));

  const run: MorphRun = {
    token: ++tokenSeq,
    el,
    content,
    savedTransform,
    savedOrigin,
    savedWillChange,
    base: parseBaseTranslate(savedTransform),
    from,
    to,
    ux,
    uy,
    dx,
    dy,
    sx,
    sy,
    start: performance.now(),
    raf: 0,
    backstop: 0,
    lastWritten: "",
    guard: null,
  };

  el.style.transformOrigin = "50% 50%";
  el.style.willChange = "transform";
  for (const c of content) c.el.style.transformOrigin = "50% 50%";
  runs.set(el, run);
  activeRuns++;
  // 形变期间一切「跟随手指改变形状」的反馈都要让路 —— 但只在**正按着手指**时才需要抑制
  // （详见文件里 usePressFeedbackEnabled 的说明）
  bindPointerTracking();
  if (pointerHeld) setPressSuppressed(true);
  setMorphing(true);

  // 先**同步**落到源矩形：这样切换后的第一帧（还没跑到 rAF）就是精确的起点
  applyRun(run, 0);

  /*
   * 守卫：React 在这个元素上重渲染时也会写它的行内 transform（高亮胶囊的定位、
   * 大药丸的按压位移都在 style 里），撞上就会让形变"退回一帧"。MutationObserver
   * 在绘制前回调，发现行内值不等于我们本帧写的，就立刻写回 —— 用户看不到那一帧，
   * 三个槽位也就不会出现"某个晚一拍"的错觉。
   */
  if (typeof MutationObserver !== "undefined") {
    run.guard = new MutationObserver(() => {
      if (runs.get(el) !== run) return;
      if (run.lastWritten && el.style.transform !== run.lastWritten) {
        el.style.transform = run.lastWritten;
      }
    });
    run.guard.observe(el, { attributes: true, attributeFilter: ["style"] });
  }

  const tick = () => {
    if (runs.get(el) !== run) return;
    const ts = (performance.now() - run.start) / MORPH_MS;
    if (ts >= 1) {
      finishRun(run);
      return;
    }
    applyRun(run, ts);
    run.raf = requestAnimationFrame(tick);
  };
  run.raf = requestAnimationFrame(tick);
  /*
   * 兜底：后台标签页 / 无头环境里 rAF 可能被饿死，那样「正在形变」的标记会一直挂着，
   * 按压反馈就永久失效了。定时器到点直接收尾（正常情况早就收过了，是空操作）。
   */
  run.backstop = window.setTimeout(() => finishRun(run), MORPH_MS + 240);
}

/** 一次形变所需的全部信息：配对关系 + 切换前量到的源矩形 */
export interface MorphPlan {
  pairs: [MorphSlot, MorphSlot][];
  from: Map<MorphSlot, DOMRect>;
}

/**
 * 切换**之前**调用：量出这一次形变要用到的所有源矩形。
 * 此刻界面还停在旧形态上（动画尚未开始），量到的就是源元素的真实矩形。
 */
export function captureMorph(direction: MorphDirection): MorphPlan | null {
  const pairs = direction === "collapse" ? COLLAPSE_PAIRS : EXPAND_PAIRS;
  const from = new Map<MorphSlot, DOMRect>();
  for (const [srcSlot] of pairs) {
    const el = slots.get(srcSlot);
    if (!el) continue;
    // 源元素若还在上一次形变里，先收尾（还原行内样式），量出来的才是真实矩形
    cancelMorph(el);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    from.set(srcSlot, r);
  }
  return from.size ? { pairs, from } : null;
}

/**
 * 切换**之后**（DOM 已更新到新形态）调用：让每个目标元素从源矩形形变到自己的位置。
 * 目标元素不存在（例如没有正在播放的歌）就跳过那一对，其余照常。
 */
export function playMorph(plan: MorphPlan): void {
  for (const [srcSlot, dstSlot] of plan.pairs) {
    const from = plan.from.get(srcSlot);
    if (!from) continue;
    const el = slots.get(dstSlot) ?? null;
    if (!el) continue;
    startFlip(dstSlot, el, from);
  }
}

