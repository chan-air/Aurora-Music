import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settingsStore";
import { glassLensScale, glassSpring, glassSnapMs, glassPress } from "@/lib/settings";
import { registerMorphSlot, useMorphing, usePressFeedbackEnabled } from "@/lib/touchMorph";
import { NAV_ITEMS } from "./nav";
import { useNavHighlight } from "./useNavHighlight";

/* ---------------- 几何常量 ----------------
 * 停靠栏高度 56px：药丸用 rounded-full，所以圆角半径恒等于**半高** = 28px。
 * 屏幕四角半径 R 与药丸圆角半径 r 满足  R - r = --dock-inset（CSS 变量，默认 10px）
 * 时，屏幕圆角与药丸圆角同心 —— 这就是内缩必须由变量表达、而不是散落魔法数字的
 * 原因：同一个值既决定「离屏幕边缘多远」，也决定「屏幕圆角该比药丸圆角大多少」。
 */
const DOCK_H = 56;

/** 导出给展开态歌曲栏用：两枚药丸必须同高，常量只有这一处 */
export { DOCK_H };

/*
 * 高亮胶囊（也就是那枚「小药丸」）：它在停靠栏**内部**，压住当前项的图标与文字，
 * 既是选中指示，也是变色透镜的窗口 —— 只有落在它范围内的那部分才会变色。
 *
 * 【与停靠栏同心】停靠栏是 rounded-full，圆角半径 = DOCK_H/2 = 28；
 * 胶囊圆角半径 capR = min(宽,高)/2。两个圆角要**同心**（圆心重合），
 * 胶囊到停靠栏边缘的距离就必须是  (28 - capR)。
 * 所以内缩量不能写死，必须由半径反推；而且**选项那一排要用同样的内缩**，
 * 否则「首个选项中心」会与同心位置差半个身位 —— 最边上的元素被选中时就会偏心。
 *
 * 宽度这里**取满一个选项槽**（不再设上限）：既让胶囊不再偏窄，
 * 又保证「最边上那项的槽边缘 = 胶囊边缘」，两端的圆心因此严格重合。
 */
const CAPSULE_H = 48;
/** 垂直内缩 = (56-48)/2 = 4；胶囊半径 24，于是 28-24 = 4，两者恰好一致 → 同心 */
const CAPSULE_INSET = (DOCK_H - CAPSULE_H) / 2;

/** 导出给设置页的预览条用：几何与真实底栏同源，缩小后仍能一眼认出是同一件东西 */
export { CAPSULE_H };

/** 有回弹的弹性曲线：先冲过目标一点、再弹回来（液态手感的关键）。
 *  实际用的是下面 spring（过冲量随设置项「回弹幅度」变）；这个常量只留给
 *  「拖拽时的胶囊形变」等固定过渡，默认 50 时两者数值完全一致。 */
const SPRING_DEFAULT = "cubic-bezier(.34,1.56,.64,1)";
/** 拖拽时「被捏住」的形变过渡，松手弹回 */
const CAPSULE_DEFORM = `transform 200ms ${SPRING_DEFAULT}`;
/** 惯性滑行的减速曲线：起步快、越滑越慢（像真实世界被抛出去） */
const FLING_EASE = "cubic-bezier(.12,.62,.2,1)";
/** 触发惯性的最小速度（px/ms）。低于它视为「轻轻放下」，直接吸附 */
const FLING_MIN_V = 0.35;
/*
 * 阻力设置（0=最滑 / 100=最涩）映射到「投影时长」与「最多再飞几个身位」：
 *   投影落点 = 松手位置 + 速度 × 投影时长
 * 所以时长越大甩得越远。两端取值都在这里，方便一处调手感。
 */
const PROJECT_MS_SLIPPERY = 340;
const PROJECT_MS_STICKY = 40;
const MAX_STEPS_SLIPPERY = 8;
const MAX_STEPS_STICKY = 2;

/**
 * 停靠栏里的**一排选项**。
 *
 * 底层（highlight=false）是真正可点的 NavLink 层，用 flex-1 均分宽度。
 *
 * 高亮层（highlight=true）**不用 flex**，而是拿底层量出来的中心与宽度**绝对定位**。
 * 原因是：两套独立的 flex 容器即使样式完全相同，子项宽度也可能因为取整而差零点几像素，
 * 几项累积起来就有 1px 左右 —— 表现为两层文字/图标对不齐、看着像重影。
 * 用底层实测的几何去摆放，重合就是几何保证的，而不是"算出来恰好一样"。
 */
function DockRow({
  highlight,
  itemRefs,
  metrics,
}: {
  highlight: boolean;
  itemRefs?: MutableRefObject<(HTMLAnchorElement | null)[]>;
  /** 高亮层用：底层量出的各项中心与单项宽度（相对停靠栏内边距盒） */
  metrics?: { centers: number[]; itemW: number } | null;
}) {
  return (
    <>
      {NAV_ITEMS.map(({ to, label, icon: Icon, end }, i) => {
        const cls = cn(
          "dock-item flex flex-col items-center justify-center gap-0.5 whitespace-nowrap text-[10px]",
          // 底层：全部未选中的低饱和配色；高亮层：全部用主色。
          // 「谁被选中」完全交给上面那层裁切窗口来揭示。
          highlight ? "text-primary" : "text-muted-foreground",
        );
        if (highlight) {
          const c = metrics?.centers[i];
          const w = metrics?.itemW ?? 0;
          return (
            <div
              key={to}
              className={cn(cls, "absolute top-0")}
              style={{
                left: c === undefined ? 0 : c - w / 2,
                width: w,
                height: "100%",
              }}
            >
              <Icon className="h-5 w-5" />
              {label}
            </div>
          );
        }
        return (
          <NavLink
            key={to}
            to={to}
            end={end}
            ref={(el) => {
              if (itemRefs) itemRefs.current[i] = el;
            }}
            className={cn(cls, "flex-1")}
          >
            <Icon className="h-5 w-5" />
            {label}
          </NavLink>
        );
      })}
    </>
  );
}

/**
 * 触屏 + 竖屏专用的底部停靠栏（液态玻璃药丸）。
 * 鼠标端与横屏不会渲染它 —— 那两条路径仍是原来的 BottomNav / Sidebar。
 *
 * 结构（从下往上）：
 *   1) 底层选项：全部低饱和配色，承载 NavLink 点击；
 *   2) 高亮胶囊填充：极淡的玻璃底色，位置与上沿小药丸**共用同一个 x**；
 *   3) 高亮层：同样的一排选项、但全是主色，用
 *      clip-path: inset(0 右 0 左 round 半高) 裁成大胶囊 —— 于是
 *      「只有落在胶囊里的那部分才会变色」，一半在里一半在外时只有里面那半变色；
 *   4) 上沿的小药丸滑条（可点可拖，热区 44px）。
 *
 * 位置分两种：
 *   1) 非拖拽 —— 由**当前路由**推导（useLocation），返回键 / 程序化跳转也能正确归位；
 *   2) 拖拽中 —— 由手指位置直接决定（transition: none），实时跟手。
 * 路由只在**松手时**变一次：拖动过程只让药丸与高亮胶囊跟着手指走。
 */
export default function TouchDockNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  /*
   * 形变与按压反馈互斥（详见 @/lib/touchMorph 顶部说明）：
   *   morphing   = 正处在两态形变动画中；
   *   pressReady = 现在允许「按下的放大 / 跟手拉伸 / 拖拽」生效 ——
   *                形变期间为 false，形变结束后若手指还没抬起来也仍是 false，
   *                必须重新按一次才会恢复。
   */
  const morphing = useMorphing();
  const pressReady = usePressFeedbackEnabled();

  /*
   * 滑动阻力（设置项，0=最滑 / 100=最涩）：
   * 阻力越小 → 投影时长越长、限幅越宽 → 同样的手速甩得越远。
   */
  const flingResistance = useSettingsStore((s) => s.flingResistance);
  const resistance = Math.min(100, Math.max(0, flingResistance ?? 50));
  const projectMs =
    PROJECT_MS_SLIPPERY - (resistance / 100) * (PROJECT_MS_SLIPPERY - PROJECT_MS_STICKY);
  const maxSteps =
    MAX_STEPS_SLIPPERY - (resistance / 100) * (MAX_STEPS_SLIPPERY - MAX_STEPS_STICKY);

  /*
   * 「液态玻璃手感」三旋钮（默认 50 = 改动前写死的常量，见 lib/settings.ts 的映射）：
   *   glassReturnSpeed → 吸附时长（460ms → 720..200ms）
   *   glassBounce      → 弹性曲线的过冲量（.34,1.56,.64,1 → y1 1.0..2.12）
   *   glassPressDeform → 按下的放大与拖动拉伸上限（1.015/1.003/0.035 的两端）
   * 只影响「吸附 / 回位」与「按压形变」两条线：形变引擎（680ms）、FLING_EASE、
   * FLING_MIN_V、投影时长一概不动。
   */
  const returnSpeed = useSettingsStore((s) => s.glassReturnSpeed);
  const bounce = useSettingsStore((s) => s.glassBounce);
  const pressDeform = useSettingsStore((s) => s.glassPressDeform);

  /** 弹性曲线：只有过冲量随「回弹幅度」变，x 控制点固定 */
  const spring = glassSpring(bounce ?? 50);
  /** 吸附 / 回位时长（毫秒）：回位速度越大越短 */
  const snapMs = glassSnapMs(returnSpeed ?? 50);
  /** 吸附 / 点击切换用的过渡 */
  const snapEase = `${snapMs}ms ${spring}`;
  /** 药丸 / 高亮胶囊的位置过渡 */
  const posSnap = `transform ${snapEase}`;
  /** 高亮层的裁切窗口过渡（clip-path 的 inset 是可插值的） */
  const clipSnap = `clip-path ${snapEase}`;
  /** 按下的放大与拖动拉伸上限（手感的另一端：0 完全无形变） */
  const press = glassPress(pressDeform ?? 50);

  const dockRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  /** 量出来的几何：各项中心（相对内边距盒）、单项宽、内边距盒的宽高 */
  const [metrics, setMetrics] = useState<{
    centers: number[];
    itemW: number;
    dockW: number;
    dockH: number;
    /**
     * 实际可用的内缩量 = CAPSULE_INSET - 描边宽度。
     *
     * 玻璃本体有 1px 实体 border，而绝对定位子元素的 left/top 是相对**内边距盒**
     * （padding box）的 —— 不扣掉这 1px，胶囊就会上边多 1px、下边少 1px，
     * 与停靠栏不同心（实测上下间隙 9 / 7）。扣掉后上下左右都是 8，完全同心。
     */
    inset: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 拖拽中的位置（跟手用）；非拖拽时为 null，位置改由路由推导 */
  const [dragX, setDragX] = useState<number | null>(null);
  /**
   * 惯性滑行的落点。松手时若速度够大，胶囊先按减速曲线滑到这里，
   * 再弹性吸附到最近项 —— 也就是「抛出去远一点再吸附」。
   */
  const [flingX, setFlingX] = useState<number | null>(null);
  /** 惯性滑行的时长（按速度算） */
  const [flingDur, setFlingDur] = useState(300);
  /** 滑行结束、准备弹性吸附：这一帧只切过渡曲线，不动位置 */
  const [settling, setSettling] = useState(false);
  /** 松手瞬间的落点下标：等路由追上来之前先用它定位，避免闪一帧旧位置 */
  const [snapIndex, setSnapIndex] = useState<number | null>(null);
  /** 当前路由匹配不到任何导航项（如 /playlist/:id）时的兜底下标 */
  const [fallbackIndex, setFallbackIndex] = useState(0);

  const dragRef = useRef<{ id: number; startX: number; startCenter: number } | null>(null);
  /** 拖拽中最近一次的 x（松手时读它，避免读到上一帧的 state） */
  const dragXRef = useRef(0);
  /** 最近 ~120ms 的指针采样，用来算松手速度（px/ms） */
  const velRef = useRef<{ x: number; t: number }[]>([]);
  /** 惯性滑行的收尾定时器：再次按下时要取消 */
  const flingTimerRef = useRef<number | null>(null);
  /**
   * 按压形变参数（放大 + 拖动拉伸上限）的**最新值**。
   * 指针处理器只在按下 / 移动的那一刻读它：从 ref 取而不是直接闭包捕获，
   * 是为了「手指一直按着时把滑块拖到另一端」也能立刻生效，读不到半旧的值。
   */
  const pressRef = useRef(press);
  pressRef.current = press;

  /**
   * 拖动时那枚「变色透镜」按下放大的系数（与「按压形变」同一条轴）。
   *
   * 改之前这里写死 `scale(1.05)`，于是这个滑块**对胶囊完全无效**
   * （实测：滑块 0 与 100 时内层矩阵都是 1.0307，差别在噪声里）。
   * 现在用 lib/settings.ts 的 glassLensScale（唯一出处），标定成：
   *   按压形变 0 → 1.000（完全不放大）、50 → 1.050（**精确等于原来的 1.05**）、100 → 1.100
   */
  const lensScale = glassLensScale(pressDeform ?? 50);
  const lensRef = useRef(lensScale);
  lensRef.current = lensScale;

  /* ---------------- 当前项：由路由推导 ----------------
   * 用统一的高亮解析：当前页有归属就用它，没归属（/playlist/:id、/album/:id 等）
   * 沿用来源那一项 —— 也就是「从哪来回哪去」，与鼠标端 BottomNav / Sidebar 同一套规则。
   */
  const routeIndex = useNavHighlight();
  useEffect(() => {
    if (routeIndex >= 0) setFallbackIndex(routeIndex);
  }, [routeIndex]);
  // 落点优先：松手后立刻用落点定位，等路由切换落定（routeIndex === snapIndex）再交还给路由
  const activeIndex = snapIndex ?? (routeIndex >= 0 ? routeIndex : fallbackIndex);
  useEffect(() => {
    if (snapIndex !== null && routeIndex === snapIndex) setSnapIndex(null);
  }, [snapIndex, routeIndex]);

  /* ---------------- 测量几何 ---------------- */
  const measure = useCallback(() => {
    const dock = dockRef.current;
    if (!dock) return;
    /*
     * 绝对定位子元素的 left: 0 是相对**内边距盒**（padding box）的，
     * 而 getBoundingClientRect 给的是边框盒 —— 玻璃描边是 1px 实体 border，
     * 所以必须把它补回来，否则滑条与胶囊整体偏 1px。
     */
    const rect = dock.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(dock).borderLeftWidth) || 0;
    const base = rect.left + border;
    const next = NAV_ITEMS.map((_, i) => {
      const el = itemRefs.current[i];
      if (!el) return Number.NaN;
      const r = el.getBoundingClientRect();
      return r.left - base + r.width / 2;
    });
    const first = itemRefs.current[0];
    if (next.some((v) => !Number.isFinite(v)) || !first) return;
    const nextItemW = first.getBoundingClientRect().width;
    const nextDockW = rect.width - border * 2;
    const nextDockH = rect.height - border * 2;
    const nextInset = Math.max(CAPSULE_INSET - border, 0);
    setMetrics((prev) =>
      prev &&
      prev.centers.length === next.length &&
      prev.centers.every((v, i) => Math.abs(v - next[i]) < 0.25) &&
      Math.abs(prev.itemW - nextItemW) < 0.25 &&
      Math.abs(prev.dockW - nextDockW) < 0.25 &&
      Math.abs(prev.dockH - nextDockH) < 0.25 &&
      Math.abs(prev.inset - nextInset) < 0.25
        ? prev
        : {
            centers: next,
            itemW: nextItemW,
            dockW: nextDockW,
            dockH: nextDockH,
            inset: nextInset,
          },
    );
  }, []);

  // mount / 尺寸变化 / 旋转时重新测量
  useLayoutEffect(() => {
    measure();
    const dock = dockRef.current;
    let ro: ResizeObserver | null = null;
    if (dock && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => measure());
      ro.observe(dock);
    }
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    // 字体 / 安全区刚生效时宽度可能还没稳定，补量一次
    const t = window.setTimeout(onResize, 300);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      window.clearTimeout(t);
    };
  }, [measure]);

  /*
   * inset 一变（8 → 7），选项行会重新排版 1px；但停靠栏自身尺寸没变，
   * ResizeObserver 不会触发 —— 于是各项中心会停留在旧位置上，最边上的元素
   * 被选中时胶囊就差这 1px。这里在 inset 变化后补量一次。
   * 追平后 inset 不再变，本副作用不会重复触发，不会形成循环。
   */
  useEffect(() => {
    const t = window.setTimeout(() => measure(), 0);
    return () => window.clearTimeout(t);
  }, [metrics?.inset, measure]);

  /* ---------------- 位置推导 ---------------- */
  const centers = metrics?.centers ?? null;
  const measured = !!metrics && metrics.centers.length === NAV_ITEMS.length;
  const snapX = metrics ? metrics.centers[Math.min(activeIndex, metrics.centers.length - 1)] : 0;
  /*
   * 位置来源：跟手 → 惯性滑行 → 吸附到当前项。
   * 注意这里**不看 dragging** —— 松手时 dragging 会先变 false 以让过渡生效，
   * 位置要再过一帧才交出去，否则吸附又会被"过渡未启动"吞掉。
   */
  const following = dragX !== null || flingX !== null;
  const x = dragX ?? flingX ?? snapX;
  /** 跟手与滑行期间，高亮跟着胶囊扫过去（实时），之后交还给路由 */
  const highlightIndex = following && centers ? nearest(centers, x) : activeIndex;
  /** 位置过渡：拖拽不插值 → 滑行用减速曲线 → 吸附用弹性曲线 */
  const flinging = flingX !== null && !settling;
  const posTransition = dragging ? "none" : flinging ? `transform ${flingDur}ms ${FLING_EASE}` : posSnap;
  /** 变色窗口共用同一套节奏，避免出现"胶囊到了、变色还没到"的割裂 */
  const clipTransition = dragging
    ? "none"
    : flinging
      ? `clip-path ${flingDur}ms ${FLING_EASE}`
      : clipSnap;

  const nearestIndex = useCallback(
    (v: number) => (centers ? nearest(centers, v) : 0),
    [centers],
  );

  /* ---------------- 拖拽：跟手；路由只在松手时变一次 ---------------- */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 形变中 / 上一根手指还没抬起：不开始新的拖拽，避免手势与形变打架
    if (!pressReady) return;
    if (!measured) return;
    if (e.pointerType === "mouse" && e.button !== 0) return; // 只响应主键
    const startCenter = snapX;
    // 上一次的惯性滑行还没结束就再次按下：立刻取消，交给手指
    if (flingTimerRef.current !== null) {
      window.clearTimeout(flingTimerRef.current);
      flingTimerRef.current = null;
    }
    setSettling(false);
    setFlingX(null);
    velRef.current = [];
    dragRef.current = { id: e.pointerId, startX: e.clientX, startCenter };
    dragXRef.current = startCenter;
    setDragging(true);
    setDragX(startCenter);
    try {
      // 捕获指针：拖到药丸外面也不会丢事件
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件 / 无效 pointerId 时忽略 */
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId || !metrics) return;
    const { centers: cs } = metrics;
    // clamp 在首项中心与末项中心之间，滑条与高亮胶囊不会跑出停靠栏范围
    const next = Math.min(
      Math.max(d.startCenter + (e.clientX - d.startX), cs[0]),
      cs[cs.length - 1],
    );
    dragXRef.current = next;
    /*
     * 只保留最近 ~120ms 的采样：松手速度要用「最近这一段」算，
     * 若把整段拖拽都算进去，先慢后快的手指会被平均成慢，甩不出去。
     */
    const now = performance.now();
    const samples = velRef.current;
    samples.push({ x: e.clientX, t: now });
    while (samples.length > 2 && now - samples[0].t > 120) samples.shift();
    /*
     * 这里**只动位置**：药丸与高亮胶囊跟着手指走，路由不动。
     * 拖动过程中反复 navigate 会让页面来回切、历史记录堆一堆，体感很糟。
     */
    setDragX(next);
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
    // 松手速度（px/ms）：用最近这段采样算，快甩才甩得出去
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

    /*
     * ① 本帧只把 dragging 关掉 —— transition 由 none 变成曲线；
     *    位置与过渡在同一帧改会被"变化前的样式"吞掉，动画不启动。
     */
    setDragging(false);

    const finish = (idx: number) => {
      /*
       * ② 先切回弹性曲线（位置不动），下一帧再交给目标项中心 ——
       *    这样惯性滑行的末段与随后的吸附都是动画，而不是瞬移。
       * settling 保持 true 到下次按下再清（见 onPointerDown）：只要它在，
       * 过渡就一直是弹性曲线，不会和位置改动撞在同一帧。
       */
      setSettling(true);
      requestAnimationFrame(() => {
        setDragX(null);
        setFlingX(null);
        setSnapIndex(idx);
        if (NAV_ITEMS[idx].to !== pathname) navigate(NAV_ITEMS[idx].to);
      });
    };

    if (Math.abs(velocity) >= FLING_MIN_V && metrics) {
      /*
       * 快速甩动 → 遵循惯性：先按速度投影一个落点滑过去（减速曲线），
       * 到了再弹性吸附到最近项。投影距离同时受「滑动阻力」设置影响：
       * 阻力越小 → 投影时长越长 → 甩得越远（限幅也一并放宽）。
       */
      const step = metrics.itemW || 50;
      const reachLimit = step * maxSteps;
      const reach = Math.max(-reachLimit, Math.min(reachLimit, velocity * projectMs));
      const lo = metrics.centers[0];
      const hi = metrics.centers[metrics.centers.length - 1];
      const projected = Math.min(Math.max(releaseX + reach, lo), hi);
      const idx = nearestIndex(projected);
      // 滑行时长随距离增长：甩得越远、滑得越久，才像被抛出去
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
      // 慢慢放下 → 直接吸附到最近项
      finish(nearestIndex(releaseX));
    }
  };

  /* ---------------- 高亮胶囊的几何（同时也是变色裁切窗口）---------------- */
  /** 扣掉描边后的真实内缩：同时用于选项行内缩、胶囊纵向位置与裁切窗口 */
  const inset = metrics?.inset ?? CAPSULE_INSET;
  /* 宽度取满一个选项槽：两端圆心才与停靠栏严格重合，同时解决"太窄" */
  const capsuleW = metrics ? metrics.itemW : 0;
  const capsuleH = CAPSULE_H;
  /**
   * 圆角半径 = 较短边的一半（与 CSS 的 border-radius:9999px 表现一致）。
   * 它的另一半身份是「同心内缩量」：胶囊到停靠栏边缘应留 32 - capsuleR。
   * 因为选项那一排用的内缩也是 CAPSULE_INSET(=8)，而 capsuleR 恒 ≤ 24，
   * 所以胶囊**永远不会超出同心位置**，最边上的元素被选中时也是同心（误差 <1px）。
   */
  const capsuleR = Math.min(capsuleW, capsuleH) / 2;
  const clipLeft = metrics ? x - capsuleW / 2 : 0;
  const clipRight = metrics ? metrics.dockW - (x + capsuleW / 2) : 0;

  /*
   * ---------------- 按住大药丸的触摸反馈 ----------------
   * 手指按在停靠栏上（包括按在胶囊上拖动）时：
   *   · 整颗大药丸轻微跟着手指位移；
   *   · 轻微拉伸（横向被"拽"长一点、纵向略收）；
   *   · 手指下方浮现一圈很淡的光晕。
   * 松手后一起用弹性曲线回弹。
   */
  const [dockShift, setDockShift] = useState({ x: 0, y: 0, sx: 1, sy: 1 });
  const [glow, setGlow] = useState<{ x: number; y: number } | null>(null);
  /**
   * 形变原点：**手指按下点** 与 **停靠栏原中心** 的中点。
   * 默认 transform-origin: center 会让拉伸"以中心对称摊开"；改成这个中点后，
   * 形变像是从手指与被拽物体之间长出来，更像真的把玻璃捏住往一边拉。
   * 取**按下那一刻**的位置（不跟随手指移动），否则形变中心会一直漂、看起来在抖。
   */
  const [pressOrigin, setPressOrigin] = useState("50% 50%");
  /** 当前按住停靠栏的那根手指（形变位移的基准点） */
  const holdRef = useRef<{ id: number; x0: number; y0: number } | null>(null);

  const onDockDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pressReady) return;
    const r = e.currentTarget.getBoundingClientRect();
    const lx = e.clientX - r.left;
    const ly = e.clientY - r.top;
    holdRef.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
    setGlow({ x: lx, y: ly });
    setPressOrigin(
      `${((lx + r.width / 2) / 2).toFixed(1)}px ${((ly + r.height / 2) / 2).toFixed(1)}px`,
    );
    /*
     * 按下的即时反馈（哪怕手指完全不动）。
     * 之前只有 onDockMove 会改形变，于是"单纯点一下"毫无动静 ——
     * 这里给一点极轻微的**放大** + 朝按下点的位移，松手后由 onDockUp 弹回。
     * 用放大而不是缩小：按下像"被手指托起来"，缩下去则像被压瘪，观感差很多。
     * 放大倍率来自「按压形变」设置：50 就是原本的 1.015 / 1.003，0 则完全不动。
     */
    const dirX = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
    const dirY = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
    const { sx, sy } = pressRef.current;
    setDockShift({ x: dirX * 2.5, y: dirY * 1.6, sx, sy });
  };

  const onDockMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pressReady) return;
    const p = holdRef.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    // 幅度刻意很小：是"液态被按住的余韵"，不是拖拽整个停靠栏
    const nx = Math.max(-5, Math.min(5, dx * 0.07));
    const ny = Math.max(-3, Math.min(3, dy * 0.05));
    // 跟手拉伸的幅度同样随「按压形变」走：50 → 上限 0.035（原常量），0 → 完全不拉伸
    const { sx, sy, stretch: stretchMax } = pressRef.current;
    const stretch = Math.min(Math.abs(dx) / 520, stretchMax);
    // 基准与「按下时的放大」一致，这样按下→拖动是连续的，不会跳一下
    setDockShift({ x: nx, y: ny, sx: sx + stretch, sy: sy - stretch * 0.6 });
    const r = e.currentTarget.getBoundingClientRect();
    setGlow({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const onDockUp = (e: ReactPointerEvent<HTMLElement>) => {
    const p = holdRef.current;
    if (!p || p.id !== e.pointerId) return;
    holdRef.current = null;
    // 同样先让 transition 由 none 切回弹性曲线，下一拍再回弹，否则是瞬移。
    // 用 setTimeout 而不是 requestAnimationFrame：后者在后台标签页 / 无头环境会被饿死，
    // 一旦被饿死就会卡在"按住"的形变里回不来。
    setGlow(null);
    window.setTimeout(() => setDockShift({ x: 0, y: 0, sx: 1, sy: 1 }), 16);
  };

  /*
   * 形变一开始，把「按压 / 跟手 / 拖拽」那套状态**全部收掉**，并且解除手指的作用权
   * （holdRef / dragRef 置空）——
   *  · 不收掉的话，那套 scale 会叠在形变的 scale 上，元素被二次缩放（就是被压扁）；
   *  · 只靠「形变期间不响应」还不够：动画一结束，仍按着的那根手指会让状态瞬间生效，
   *    表现成「弹一下」。所以必须要求重新按下（见 usePressFeedbackEnabled）。
   */
  useEffect(() => {
    if (!morphing) return;
    holdRef.current = null;
    dragRef.current = null;
    velRef.current = [];
    if (flingTimerRef.current !== null) {
      window.clearTimeout(flingTimerRef.current);
      flingTimerRef.current = null;
    }
    setGlow(null);
    setDockShift({ x: 0, y: 0, sx: 1, sy: 1 });
    setDragging(false);
    setDragX(null);
    setFlingX(null);
    setSettling(false);
  }, [morphing]);

  return (
    <nav
      ref={(el) => {
        dockRef.current = el;
        // 合一态右圆（搜索）的形变来源：整颗大药丸
        registerMorphSlot("full:dock", el);
      }}
      data-morph="full-dock"
      aria-label="主导航"
      /*
       * overflow-hidden：让手指光晕被药丸外形裁掉，不会溢出到药丸外面。
       * 它只裁剪内容，不影响自身的外阴影。
       */
      className="liquid-glass liquid-glass--tone liquid-glass-sheen relative overflow-hidden"
      onPointerDown={onDockDown}
      onPointerMove={onDockMove}
      onPointerUp={onDockUp}
      onPointerCancel={onDockUp}
      style={{
        height: DOCK_H,
        borderRadius: 9999,
        // 左右内缩：与屏幕圆角同心（见 --dock-inset 的几何说明）
        marginLeft: "var(--dock-inset)",
        marginRight: "var(--dock-inset)",
        // 底部内缩 + iOS 安全区（刘海屏底部的 Home 指示条）
        marginBottom: "calc(var(--dock-inset) + env(safe-area-inset-bottom, 0px))",
        // 按住时轻微跟手位移 + 拉伸；松手弹性回弹。
        // 形变原点是「按下点与原中心的中点」（见 onDockDown）
        transform: `translate3d(${dockShift.x}px, ${dockShift.y}px, 0) scale(${dockShift.sx}, ${dockShift.sy})`,
        transformOrigin: pressOrigin,
        // 形变期间连「松手回弹的那段过渡」也掐掉：否则按压缩放会带着过渡慢慢退回去，
        // 形变前半段看上去仍像被按着（要求是动画期间一律不生效）。
        // 松手回弹与吸附共用同一套节奏（回位速度 → 时长、回弹幅度 → 过冲量）：
        // 默认 50/50 时是 460ms + cubic-bezier(.34,1.56,.64,1)。
        transition: glow || morphing ? "none" : `transform ${snapEase}`,
        willChange: "transform",
      }}
    >
      {/* 手指下方的淡光晕（很淡：只是让按下的位置有"水感"，不喧宾夺主） */}
      {glow && (
        <span
          aria-hidden
          className="pointer-events-none absolute z-[4] rounded-full"
          style={{
            left: glow.x,
            top: glow.y,
            width: 104,
            height: 104,
            marginLeft: -52,
            marginTop: -52,
            background:
              "radial-gradient(circle, rgb(255 255 255 / 0.11) 0%, rgb(255 255 255 / 0.05) 45%, rgb(255 255 255 / 0) 72%)",
            transition: "opacity 220ms ease",
          }}
        />
      )}
      {/*
        1) 底层：全部未选中的低饱和配色，也是真正可点的 NavLink 层。
        左右内缩 = CAPSULE_INSET：这样首个选项的中心正好落在「与停靠栏同心」的
        位置上（否则最边上的元素被选中时，胶囊会明显偏心）。
        各项仍是 flex-1，间距保持相等。
      */}
      <div
        className="absolute inset-0 flex items-stretch"
        style={{ paddingLeft: CAPSULE_INSET, paddingRight: CAPSULE_INSET }}
      >
        <DockRow highlight={false} itemRefs={itemRefs} />
      </div>

      {measured && metrics && (
        <>
          {/*
            2) 高亮胶囊 —— 就是那枚「小药丸」：在停靠栏**内部**、压住当前项的图标与文字。
               它同时是拖拽把手：按住它左右拖即换页，松手才真正跳转。
               外面这层只负责「跟手定位」，里面那层只负责「形变」——
               拆成两层是因为 position 与 scale 同属 transform：
               合在一起就没法「拖动时位置不插值、形变仍然有动画」。
          */}
          <div
            role="slider"
            ref={(el) => {
              /*
               * 合一态左圆的形变对位元素 —— 就是这枚**高亮胶囊本体**（变色透镜的那扇窗）。
               * 折叠时它是来源（只被量矩形，不会被形变碰到）；
               * 展开时它是目标，形变会与它自己的定位 transform **复合**而不是覆盖
               * （见 @/lib/touchMorph 的 base 处理），所以跟手定位不受影响。
               */
              registerMorphSlot("full:left", el);
            }}
            data-morph="full-left"
            aria-label="页面切换滑条"
            aria-orientation="horizontal"
            aria-valuemin={1}
            aria-valuemax={NAV_ITEMS.length}
            aria-valuenow={highlightIndex + 1}
            aria-valuetext={NAV_ITEMS[highlightIndex]?.label}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={cn(
              "absolute left-0 z-[3] touch-none select-none",
              dragging ? "cursor-grabbing" : "cursor-grab",
            )}
            style={{
              top: inset,
              width: capsuleW,
              height: capsuleH,
              transform: `translate3d(${x - capsuleW / 2}px, 0, 0)`,
              // 跟手不插值；滑行减速；吸附弹性（见上面的 posTransition）
              transition: posTransition,
              willChange: "transform",
            }}
          >
            <div
              aria-hidden
              className="h-full w-full"
              style={{
                borderRadius: 9999,
                // 极淡的玻璃填充：没有图标的位置也能读出选中范围。
                // 形变期间不跟随「按压 / 拖拽」变形（否则与形变的 scale 叠加）
                background:
                  dragging && pressReady
                    ? "hsl(var(--primary) / 0.2)"
                    : "hsl(var(--primary) / 0.12)",
                boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.05)",
                transform:
                  dragging && pressReady ? `scale(${lensRef.current.toFixed(4)})` : "none",
                transition: CAPSULE_DEFORM,
              }}
            />
          </div>

          {/*
            3) 高亮层：内容与底层**完全同构** —— 同样 absolute inset-0 + flex + 同一个内缩。
               之前这里多包了一层 flex 子元素，可用宽度与底层差了约 2px，
               于是两层的文字/图标对不齐（看起来像"重影"）。
               这层不放任何别的东西（clip-path 会把里面所有内容一起裁掉）。
          */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-[2]"
            style={{
              clipPath: `inset(${inset}px ${clipRight}px ${inset}px ${clipLeft}px round ${capsuleR}px)`,
              // 拖动时禁用过渡（跟手）；滑行减速；松手 / 点击后弹性吸附
              transition: clipTransition,
            }}
          >
            {/* 不用 flex：按底层实测几何绝对定位，像素重合由几何保证 */}
            <DockRow highlight metrics={metrics} />
          </div>
        </>
      )}
    </nav>
  );
}

/** 取离 v 最近的中心点下标 */
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
