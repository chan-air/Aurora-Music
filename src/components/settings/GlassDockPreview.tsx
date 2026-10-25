import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { glassLensScale, glassPress, glassSnapMs, glassSpring } from "@/lib/settings";
import { useSettingsStore } from "@/stores/settingsStore";
import { CAPSULE_H, DOCK_H } from "@/components/layout/TouchDockNav";
import { cn } from "@/lib/utils";

/*
 * 设置页里的「液态玻璃预览条」。
 *
 * 为什么需要它：玻璃透不透、松手回位快不快、过冲多大、按住形变多明显，
 * 全都是「动起来才看得出来」的；只看滑块数字判断不了。所以在同一张卡片里
 * 放一条**缩小版**的真实底栏：材质、胶囊、手势与真实底栏走同一套做法，
 * 四项设置**当场生效**。
 *
 * ── 位置 ────────────────────────────────────────────────────────────
 * 触屏底栏那张卡片里、四个滑块下方（SettingsPage 直接引这个组件）。
 *
 * ── 与真实底栏的关系：只做预览 ──────────────────────────────────────
 *  · 不共享任何拖拽状态（自己一套 ref/state，不碰 TouchDockNav 内部状态）；
 *  · 不导航：松手只让它自己的胶囊吸附到最近一项，**不改路由、不动 store 当前项**；
 *  · 复用同一套材质类（.liquid-glass + .liquid-glass--tone + 高亮胶囊做法）
 *    与同一套几何常量（DOCK_H / CAPSULE_H / 同心内缩），所以「一眼是同一种东西」。
 *
 * ── 对比背景（关键）────────────────────────────────────────────────
 * 预览条背后垫了一块从左到右由亮到暗的渐变（近白 → 淡紫 → 紫 → 深灰 → 近黑）。
 * 不垫的话，它和设置页一样是深色，本体 alpha 0.40 与 0.05 照样看不出区别
 * —— 那正是「滑块生效但看不出来」的根因。
 * 渐变也顺便把玻璃色调自适应的两端都覆盖到了：左端亮、右端暗。
 */

/** 预览条高度：真实停靠栏 56px 的 ~0.64 倍（仍能看清胶囊与文字结构） */
const PREVIEW_H = 36;
/** 缩放比例 = 预览高度 / 真实高度，用来把真实几何常量等比缩小 */
const SCALE = PREVIEW_H / DOCK_H;
/** 胶囊高度按同一比例缩（真实 48px → 约 31px） */
const PREVIEW_CAPSULE_H = CAPSULE_H * SCALE;
/** 内缩同样等比缩：真实 4px（同心内缩）→ 约 2.6px */
const PREVIEW_INSET = ((DOCK_H - CAPSULE_H) / 2) * SCALE;

/** 预览用的四个选项（与真实底栏同构，但不导航、不读路由） */
const ITEMS = [
  { key: "home", label: "首页", icon: "M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z" },
  { key: "songs", label: "歌曲", icon: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" },
  { key: "settings", label: "设置", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2z" },
  { key: "search", label: "搜索", icon: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2l-4.35-4.35" },
];

/** 触发惯性的最小速度（px/ms）—— 与真实底栏同一个常数 */
const FLING_MIN_V = 0.35;
/** 惯性滑行的减速曲线（与真实底栏同一套） */
const FLING_EASE = "cubic-bezier(.12,.62,.2,1)";
/** 居中态：胶囊默认停在第 3 项（与真实底栏拖动时的高亮居中手感一致） */
const START_INDEX = 2;

/**
 * 对比背景（预览条的关键道具，见下面注释）：
 *   ① 底层 —— 左亮右暗的横向渐变：保证「大胶囊的透明度」在两端都能被看见；
 *   ② 上层 —— 一层很细的斜条纹：给玻璃背后**高频细节**。没有它的话，
 *      背景是一大片平滑渐变，18px 模糊与 0px 模糊在观感上几乎一样
 *      （实测：只放平滑渐变时，80% 与 94% 的截图几乎分不出差别）。
 *      有了条纹，80% 时背后是柔化的斜纹、94% 时能看清一根根纹路 + 背景原色。
 */
const COMPARE_GRADIENT =
  "repeating-linear-gradient(115deg, rgb(255 255 255 / 0.14) 0 3px, rgb(255 255 255 / 0) 3px 7px), " +
  "linear-gradient(100deg, rgb(248 250 252) 0%, rgb(199 210 254) 24%, rgb(167 139 250) 46%, rgb(76 29 149) 68%, rgb(24 24 27) 86%, rgb(9 9 11) 100%)";
/** 压在渐变上的深色薄纱：保住「左亮右暗」的对比，同时压住整体亮度（见用法处注释） */
const SCRIM = "linear-gradient(0deg, rgb(9 9 11 / 0.55), rgb(9 9 11 / 0.55))";

function nearest(centers: number[], v: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  centers.forEach((c, i) => {
    const d = Math.abs(c - v);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

export default function GlassDockPreview() {
  /* 四项设置：与真实底栏读的是同一批键，改滑块这里立刻变 */
  const returnSpeed = useSettingsStore((s) => s.glassReturnSpeed);
  const bounce = useSettingsStore((s) => s.glassBounce);
  const pressDeform = useSettingsStore((s) => s.glassPressDeform);
  const flingResistance = useSettingsStore((s) => s.flingResistance);

  const spring = glassSpring(bounce ?? 50);
  const snapMs = glassSnapMs(returnSpeed ?? 50);
  const snapEase = `${snapMs}ms ${spring}`;
  const press = glassPress(pressDeform ?? 50);
  /**
   * 拖动时那枚透镜的放大：用 lib/settings.ts 的 glassLensScale（与真实底栏同一出处）。
   *   按压形变 0   → 1.0000（完全不放大）
   *   按压形变 50  → 1.0500（= 原来写死的 1.05，默认观感不变）
   *   按压形变 100 → 1.1000
   */
  const lensScale = glassLensScale(pressDeform ?? 50);

  /* 滑动阻力：与真实底栏同一套映射（只影响甩动能滑多远） */
  const resistance = Math.min(100, Math.max(0, flingResistance ?? 50));
  const projectMs = 340 - (resistance / 100) * (340 - 40);
  const maxSteps = 8 - (resistance / 100) * (8 - 2);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [centers, setCenters] = useState<number[]>([]);
  const [trackW, setTrackW] = useState(0);
  const [index, setIndex] = useState(START_INDEX);

  const [dragging, setDragging] = useState(false);
  const [dragX, setDragX] = useState<number | null>(null);
  const [flingX, setFlingX] = useState<number | null>(null);
  const [flingDur, setFlingDur] = useState(300);
  const [settling, setSettling] = useState(false);
  /** 松手落点：立刻用它定位，避免闪一帧旧位置 */
  const [snapIndex, setSnapIndex] = useState<number | null>(null);
  /** 按下点（相对预览条）：用于那圈很淡的光晕，与真实底栏同一观感 */
  const [glow, setGlow] = useState<{ x: number; y: number } | null>(null);

  const dragRef = useRef<{ id: number; startX: number; startCenter: number } | null>(null);
  const dragXRef = useRef(0);
  const velRef = useRef<{ x: number; t: number }[]>([]);
  const flingTimerRef = useRef<number | null>(null);
  const pressRef = useRef(press);
  pressRef.current = press;

  /* ---------------- 量几何：与真实底栏同样的「量底层各项中心」做法 ---------------- */
  const measure = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(surface).borderLeftWidth) || 0;
    const base = rect.left + border;
    const next = ITEMS.map((_, i) => {
      const el = itemRefs.current[i];
      if (!el) return Number.NaN;
      const r = el.getBoundingClientRect();
      return r.left - base + r.width / 2;
    });
    if (next.some((v) => !Number.isFinite(v))) return;
    const w = rect.width - border * 2;
    setCenters((prev) =>
      prev.length === next.length && prev.every((v, i) => Math.abs(v - next[i]) < 0.25) ? prev : next,
    );
    setTrackW((prev) => (Math.abs(prev - w) < 0.25 ? prev : w));
  }, []);

  useLayoutEffect(() => {
    measure();
    const surface = surfaceRef.current;
    let ro: ResizeObserver | null = null;
    if (surface && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => measure());
      ro.observe(surface);
    }
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    // 字体 / 安全区刚生效时宽度可能还没稳定，补量一次（与真实底栏一致）
    const t = window.setTimeout(onResize, 300);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
      window.clearTimeout(t);
    };
  }, [measure]);

  /* ---------------- 位置推导（与真实底栏同一套：跟手 → 滑行 → 吸附） ---------------- */
  const ready = centers.length === ITEMS.length && trackW > 0;
  const activeIndex = snapIndex ?? Math.min(index, ITEMS.length - 1);
  const snapX = ready ? centers[activeIndex] : 0;
  const following = dragX !== null || flingX !== null;
  const x = dragX ?? flingX ?? snapX;
  const flinging = flingX !== null && !settling;
  const posTransition = dragging ? "none" : flinging ? `transform ${flingDur}ms ${FLING_EASE}` : `transform ${snapEase}`;

  const nearestIndex = useCallback((v: number) => (ready ? nearest(centers, v) : 0), [centers, ready]);

  /* ---------------- 拖拽：胶囊跟手，松手回弹吸附（只动预览条自己） ---------------- */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (flingTimerRef.current !== null) {
      window.clearTimeout(flingTimerRef.current);
      flingTimerRef.current = null;
    }
    setSettling(false);
    setFlingX(null);
    velRef.current = [];
    dragRef.current = { id: e.pointerId, startX: e.clientX, startCenter: snapX };
    dragXRef.current = snapX;
    setDragging(true);
    setDragX(snapX);
    const r = e.currentTarget.getBoundingClientRect();
    setGlow({ x: e.clientX - r.left, y: e.clientY - r.top });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件 / 无效 pointerId 时忽略 */
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId || !ready) return;
    // 拖动时也不要把页面带着滚（真机上 touch-action: none 已挡住，这里再兜一层）
    e.preventDefault();
    const next = Math.min(Math.max(d.startCenter + (e.clientX - d.startX), centers[0]), centers[centers.length - 1]);
    dragXRef.current = next;
    const now = performance.now();
    const samples = velRef.current;
    samples.push({ x: e.clientX, t: now });
    while (samples.length > 2 && now - samples[0].t > 120) samples.shift();
    setDragX(next);
    const r = e.currentTarget.getBoundingClientRect();
    setGlow({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const releaseX = dragXRef.current;
    const samples = velRef.current;
    let velocity = 0;
    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      if (dt > 0) velocity = (last.x - first.x) / dt;
    }
    velRef.current = [];
    setDragging(false);
    setGlow(null);

    /*
     * 先切回弹性曲线（位置不动），下一帧再交给目标项中心 ——
     * 这样「松手回弹」才是一段动画，而不是瞬移（与真实底栏同一个顺序）。
     */
    const finish = (idx: number) => {
      setSettling(true);
      requestAnimationFrame(() => {
        setDragX(null);
        setFlingX(null);
        setSnapIndex(idx);
        setIndex(idx);
      });
    };

    if (Math.abs(velocity) >= FLING_MIN_V) {
      const step = trackW / ITEMS.length;
      const reachLimit = step * maxSteps;
      const reach = Math.max(-reachLimit, Math.min(reachLimit, velocity * projectMs));
      const projected = Math.min(Math.max(releaseX + reach, centers[0]), centers[centers.length - 1]);
      const idx = nearestIndex(projected);
      const dur = Math.round(Math.min(700, Math.max(220, 200 + Math.abs(reach) * 1.2)));
      requestAnimationFrame(() => {
        setFlingDur(dur);
        setFlingX(projected);
        setDragX(null);
        flingTimerRef.current = window.setTimeout(() => {
          flingTimerRef.current = null;
          finish(idx);
        }, dur);
      });
    } else {
      finish(nearestIndex(releaseX));
    }
  };

  /* 卸载时清掉滑行定时器，避免对着已卸载组件 setState */
  useEffect(
    () => () => {
      if (flingTimerRef.current !== null) window.clearTimeout(flingTimerRef.current);
    },
    [],
  );

  /* ---------------- 高亮胶囊几何（与真实底栏同一套同心算法） ---------------- */
  const capW = ready ? trackW / ITEMS.length : 0;
  const capH = PREVIEW_CAPSULE_H;
  const capR = Math.min(capW, capH) / 2;
  const clipLeft = ready ? x - capW / 2 : 0;
  const clipRight = ready ? trackW - (x + capW / 2) : 0;
  const highlightIndex = following && ready ? nearest(centers, x) : activeIndex;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">预览条（可直接拖动）</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          停在第 {highlightIndex + 1} 项 · 只做预览，不影响真实底栏
        </span>
      </div>

      {/*
        对比背景：从左到右「亮 → 暗」。
        没有它，预览条与设置页一样是深色，透明度差别根本看不出来。
        上面再压一层深色薄纱（scrim）：
          · 保对比 —— 左端仍明显比右端亮，玻璃的透明度差别一眼能看出；
          · 压亮度 —— 否则背后亮色会触发「玻璃色调自适应」，
            让预览条上的文字/胶囊整套转成深墨色（在浅色玻璃上几乎看不见），
            看着就不像真实的深底栏了。压过之后色调判定稳定落在「深色背景」这一档，
            预览条与真实底栏的配色完全一致。
      */}
      <div className="relative rounded-xl p-2" style={{ background: COMPARE_GRADIENT }}>
        <div aria-hidden className="pointer-events-none absolute inset-0 rounded-xl" style={{ background: SCRIM }} />
        <div
          ref={surfaceRef}
          role="group"
          aria-label="液态玻璃预览条"
          data-preview="dock"
          className="liquid-glass liquid-glass--tone liquid-glass-sheen glass-preview-surface relative overflow-hidden"
          style={{ height: PREVIEW_H, borderRadius: 9999 }}
        >
          {/* 1) 底层选项：与真实底栏同构（同样的内缩，胶囊两端才同心） */}
          <div className="absolute inset-0 flex items-stretch" style={{ paddingLeft: PREVIEW_INSET, paddingRight: PREVIEW_INSET }}>
            {ITEMS.map(({ key, label, icon }, i) => (
              <div
                key={key}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                className="flex flex-1 flex-col items-center justify-center gap-[1px] whitespace-nowrap text-[6px] text-muted-foreground"
              >
                <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d={icon} />
                </svg>
                {label}
              </div>
            ))}
          </div>

          {ready && (
            <>
              {/* 2) 高亮胶囊：按住它左右拖 = 拖动预览（松手才吸附） */}
              <div
                role="slider"
                aria-label="预览条拖动把手"
                aria-valuemin={1}
                aria-valuemax={ITEMS.length}
                aria-valuenow={highlightIndex + 1}
                aria-valuetext={ITEMS[highlightIndex]?.label}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className={cn("absolute left-0 z-[3] touch-none select-none", dragging ? "cursor-grabbing" : "cursor-grab")}
                style={{
                  top: PREVIEW_INSET,
                  width: capW,
                  height: capH,
                  transform: `translate3d(${x - capW / 2}px, 0, 0)`,
                  transition: posTransition,
                  willChange: "transform",
                }}
              >
                <div
                  aria-hidden
                  className="h-full w-full"
                  style={{
                    borderRadius: 9999,
                    // 极淡的玻璃填充：与真实底栏那枚「变色透镜」同一做法
                    background: dragging ? "hsl(var(--primary) / 0.2)" : "hsl(var(--primary) / 0.12)",
                    boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.05)",
                    // 按住时按「按压形变」等比放大（基准 50 → 1.05，0 → 完全不放大）
                    transform: dragging ? `scale(${lensScale.toFixed(4)})` : "none",
                    // 过渡用单调的 ease-out：用弹性曲线的话，0/100 两端会被过冲
                    // 顶到偏差值（实测 0 时读到 1.0348 而不是 1），看着像设置没生效
                    transition: "transform 200ms ease-out",
                  }}
                />
              </div>

              {/* 3) 高亮层：同一排选项、全用主色，用 clip-path 裁成大胶囊（与真实底栏同一手法） */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[2]"
                style={{
                  clipPath: `inset(${PREVIEW_INSET}px ${clipRight}px ${PREVIEW_INSET}px ${clipLeft}px round ${capR}px)`,
                  transition: dragging ? "none" : flinging ? `clip-path ${flingDur}ms ${FLING_EASE}` : `clip-path ${snapEase}`,
                }}
              >
                {ITEMS.map(({ key, label, icon }, i) => (
                  <div
                    key={key}
                    className="absolute top-0 flex flex-col items-center justify-center gap-[1px] whitespace-nowrap text-[6px] text-primary"
                    style={{ width: capW, height: "100%", left: centers[i] - capW / 2 }}
                  >
                    <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d={icon} />
                    </svg>
                    {label}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 手指下方那圈极淡的光晕（与真实底栏同一观感） */}
          {glow && (
            <span
              aria-hidden
              className="pointer-events-none absolute z-[4] rounded-full"
              style={{
                left: glow.x,
                top: glow.y,
                width: 72,
                height: 72,
                marginLeft: -36,
                marginTop: -36,
                background:
                  "radial-gradient(circle, rgb(255 255 255 / 0.13) 0%, rgb(255 255 255 / 0.05) 45%, rgb(255 255 255 / 0) 72%)",
                transition: "opacity 220ms ease",
              }}
            />
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        背景是刻意垫的「左亮右暗」渐变：没有它，深色页面上的玻璃无论怎么调都看不出通透差别。
        按住时的形变、松手回弹的时长与过冲量都由上面的滑块实时决定，但它<b>只做预览</b> ——
        不换页、不改真实底栏的状态。
      </p>
    </div>
  );
}
