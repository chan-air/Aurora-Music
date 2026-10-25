import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import BottomNav from "./BottomNav";
import TouchDockNav from "./TouchDockNav";
import TouchMiniBar from "./TouchMiniBar";
import TouchSongBar from "./TouchSongBar";
import PlayerBar from "@/components/player/PlayerBar";
import LyricsSheet from "@/components/player/LyricsSheet";
import { Toast } from "@/components/common/Toast";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useNetworkQuality, getNetworkIssue, NETWORK_MESSAGES } from "@/lib/network";
import { AUTO_COLLAPSE_DELAY_MS, clampDockCollapseDistance } from "@/lib/settings";
import { captureMorph, playMorph, type MorphPlan } from "@/lib/touchMorph";
import { installGlassTone } from "@/lib/glassTone";
import { noteExploreRouteChange } from "@/lib/exploreSession";
import { cn } from "@/lib/utils";

/*
 * 「收起触发距离」不再是写死的常量，而是设置项 dockCollapseDistance
 * （见 lib/settings.ts，范围 20..400，默认 DOCK_COLLAPSE_DISTANCE_DEFAULT = 28）。
 * 28 就是原来这里的 SCROLL_DEAD_ZONE：不动滑块 = 与改动前完全一致。
 *
 * 它仍然是**累计**判据：`dy` 是「相对上次成功切换时的位置」的位移，
 * 未达阈值的滚动不更新基线，所以小幅慢滑会一路累加（不分方向，往上往下都算）。
 * 把这个数放大 = 「手指确实移动过一段距离才收起来」（用户要求不要那么敏感）。
 */
/** 「接近顶端 / 接近底端」的判定余量（px）：惯性滑动常常差几像素没到边 */
const EDGE_DEAD_ZONE = 12;
/**
 * 换页后的静默窗口（ms）：这期间只重同步滚动基线，不做形态判定。
 * 路由切换时浏览器会把 scrollTop 夹紧（新页面更短时甚至夹到 0），
 * 那不是用户滚的，不能被当成「滚到顶了 → 收成合一」。
 */
const ROUTE_SETTLE_MS = 500;

/*
 * 形态切换时两层各自的不透明度过渡时长（ms）。**两层都是 0**：切换瞬间旧形态立即隐藏、
 * 新形态立即显示，中间不交叉、不留残影。
 *
 * 之前给旧形态留了 260ms 淡出，于是这 260ms 里两层同时在画 —— 看起来就是残影
 * （大药丸与合一态的圆圈重影、图标叠字）。
 *
 * 不需要淡出的原因：位移与尺寸由 @/lib/touchMorph 的形变承担，而形变是让
 * **新形态从旧形态的矩形长出来**的，视觉本来就连续；旧形态留在原地淡出只会多一层鬼影。
 */
const FADE_IN_MS = 0;
const FADE_OUT_MS = 0;

/** 触屏竖屏下，算作「用户还在操作」的事件 —— 任何一个都能把自动折叠的计时清零 */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "touchstart",
  "touchmove",
  "wheel",
  "keydown",
  "click",
] as const;

export default function AppLayout({ children }: { children: ReactNode }) {
  // 导航位置只由「横屏 / 竖屏」决定：横屏在左侧，竖屏在下方（与触屏与否无关）
  const landscape = useSettingsStore((s) => s.orientation === "landscape");
  const touch = useSettingsStore((s) => s.touch);
  /** 展开态静置自动折叠的灵敏度（三档，见 lib/settings.ts） */
  const idleSensitivity = useSettingsStore((s) => s.autoCollapseSensitivity);
  /**
   * 收起触发距离（px，设置项见 lib/settings.ts）：内容区滚动**累计位移**（不分方向）
   * 达到它就收成合一态。越界 / 缺失的值在这里钳回 20..400 并回落到默认 28。
   * 取值稳定（只有改设置才会变），所以可以安全地作为滚动监听的依赖。
   */
  const collapseDistance = clampDockCollapseDistance(
    useSettingsStore((s) => s.dockCollapseDistance),
  );

  /*
   * 只有「触屏 + 竖屏」才换用液态玻璃药丸停靠栏（TouchDockNav）。
   * 鼠标端仍渲染原来的 BottomNav、横屏仍渲染 Sidebar —— 这两条既有路径
   * 一行结构都没动，见下面的条件分支。
   */
  const liquidDock = touch && !landscape;

  /*
   * 底部覆盖层（歌曲栏 + 停靠栏）是**绝对定位**的，脱离文档流，
   * 于是内容区可以从它们后面滚过去 —— 玻璃后面的 backdrop-filter 才有东西可模糊
   * （否则背后永远是一片纯色，玻璃等于没有）。
   * 代价是内容会被盖住，所以给 main 补一个等于覆盖层实测高度的 paddingBottom：
   * 用 ref + ResizeObserver 量，不写死 —— 歌曲栏没歌时高度是 0、有歌时是另一套高度，
   * 横竖屏、安全区也会变。
   *
   * 折叠态是「另一个高度」，所以两态各量一次：展开态量整叠（歌曲栏 + 药丸），
   * 折叠态量那一行。paddingBottom 取当前形态的那个值，内容才不会被多留或少留空白。
   */
  const mainRef = useRef<HTMLElement | null>(null);
  const expandedRef = useRef<HTMLDivElement | null>(null);
  const miniRef = useRef<HTMLDivElement | null>(null);
  const [expandedH, setExpandedH] = useState(0);
  const [miniH, setMiniH] = useState(0);

  /** 折叠态：内容区滚动累计位移（不分方向）达到设置阈值 / 展开态静置过久时收起成一行 */
  const [collapsed, setCollapsed] = useState(false);
  /** 折叠态的最新值（滚动回调里同步判断，避免依赖 state 的闭包快照） */
  const collapsedRef = useRef(false);
  /** 待播放的形变计划：切换前量好源矩形，切换后由 layout effect 播放 */
  const pendingMorphRef = useRef<MorphPlan | null>(null);
  /**
   * 滚动基线：上一次判定时的 scrollTop。
   * 放 ref 而不是 effect 里的局部变量 —— 换页时要能把它重同步到新页面的位置，
   * 否则新页面第一次 scroll 会用上一页的基线算出一个错误的巨大 dy。
   */
  const scrollBaseRef = useRef(0);
  /** 换页静默窗口的截止时刻（见 ROUTE_SETTLE_MS） */
  const routeSettleRef = useRef(0);
  /** 覆盖层根节点：玻璃色调自适应在它内部找所有 .liquid-glass 采样 */
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const { pathname } = useLocation();

  /*
   * 歌曲探索的「上次退出页面」一次性状态：只做全局路由记账，
   * 不参与导航/滚动/高亮；详见 lib/exploreSession.ts。
   */
  const prevPathRef = useRef<string | null>(null);
  useEffect(() => {
    noteExploreRouteChange(prevPathRef.current, pathname);
    prevPathRef.current = pathname;
  }, [pathname]);

  /**
   * 当前路由是否**不参与自动换形态**（目前只有设置页）。
   *
   * 用 ref 而不是把 pathname 加进滚动监听的依赖：那样每次换页都要重新挂监听、
   * 还会顺带重同步基线，行为更难推理。这里只让监听器读一个最新的布尔值。
   */
  const autoSwitchOffRef = useRef(false);
  useEffect(() => {
    autoSwitchOffRef.current = pathname === "/settings";
  }, [pathname]);

  /**
   * 切换形态（唯一入口：内容区滚动、合一态点击、静置超时都走它）。
   *
   * 关键顺序：**先量源矩形，再改状态**。切换之后源元素就开始淡出了，
   * 那一刻量到的矩形才对应它「刚被看到的样子」。
   *
   * 这里**没有任何锁**：方向是滚动位置 + 方向共同决定的，锁只会让人「怎么划都切不回去」。
   * 切换本身幂等（值没变就直接返回），所以边界的重复事件不会引起抖动。
   */
  const changeForm = useCallback((next: boolean) => {
    if (collapsedRef.current === next) return;
    pendingMorphRef.current = captureMorph(next ? "collapse" : "expand");
    collapsedRef.current = next;
    setCollapsed(next);
  }, []);

  /** 切换后（DOM 已更新到新形态）播放形变：让目标元素从源矩形长到自己该在的位置 */
  useLayoutEffect(() => {
    const plan = pendingMorphRef.current;
    pendingMorphRef.current = null;
    if (plan) playMorph(plan);
  }, [collapsed]);

  useLayoutEffect(() => {
    if (!liquidDock) {
      setExpandedH(0);
      setMiniH(0);
      return;
    }
    const update = () => {
      // 折叠态那一行是绝对定位的，但 getBoundingClientRect 照样量得到高度
      if (expandedRef.current) setExpandedH(expandedRef.current.getBoundingClientRect().height);
      if (miniRef.current) setMiniH(miniRef.current.getBoundingClientRect().height);
    };
    update();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(update);
      if (expandedRef.current) ro.observe(expandedRef.current);
      if (miniRef.current) ro.observe(miniRef.current);
    }
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [liquidDock]);

  /*
   * 形态切换规则（只看内容区 main 的滚动）：
   *
   *   ① 收起：滚动**累计位移**（|dy|，**不分方向**）≥ 设置项「收起触发距离」
   *           → 收成合一态（默认 28px，设置页可调 20..400）。
   *   ② 展开：内容区到**顶**（scrollTop ≤ 余量）或到**底**（max - scrollTop ≤ 余量）
   *           → 展开成两栏；在端点继续滑（位置不再变化）会反复命中这条分支，
   *             所以「到顶 / 到底后保持展开」天然成立，不需要额外的锁。
   *   ③ 点击：合一态点左圆 / 歌曲胶囊 → 展开（TouchMiniBar 的 onExpand，规则未动）。
   *   ④ 静置：展开态静置过久 → 自动收起（见下面的 AUTO_COLLAPSE_DELAY_MS）。
   *
   * 方向的含义只剩一条：**端点展开只认「正在往这个端点去 / 已经在端点」**：
   * 顶部要求 dy ≤ 0、底部要求 dy ≥ 0。从端点**离开**（在顶部往下滑）不算展开触发 ——
   * 那是「开始浏览内容」，应当按 ① 从端点起累计、滑够距离后收起。
   * 少了这条限制，从顶部往下滑的头 12px（还在 EDGE_DEAD_ZONE 里）会把刚收起的底栏弹开。
   *
   * 基线（scrollBaseRef）在端点分支里被**钉在端点本身**（0 / max），而不是当时的 scrollTop：
   *  · 端点处来回微动（位置不动、或 iOS 橡皮筋回弹）都得到 dy = 0，不会误判；
   *  · 从端点滑向内容时，累计正好从端点起算 —— 「离顶部 28px 就收起」与直觉一致。
   *
   * 跳变保护：|dy| 大到不可能是手指滚出来的（超过一屏），说明位置是被**程序化**
   * 重置 / 夹紧的（换页回到顶部、新页面内容更短把 scrollTop 夹小……）——
   * 这时只重同步基线，不切换形态。没有它，换页后第一次 scroll 会拿上一页的基线
   * 算出一个巨大的 dy，凭空切一次形态。
   *
   * 判定**同步**做，不推迟到下一帧：只有几次算术运算，没有性能问题，
   * 而 rAF 在 iOS 快速滚动 / 后台 / 低电量下会被节流甚至跳过，判定就丢了。
   * 这里**不设切换锁**：锁只会让人「怎么划都切不回去」，而切换本身是幂等的。
   */
  useEffect(() => {
    if (!liquidDock) {
      collapsedRef.current = false;
      setCollapsed(false);
      return;
    }
    const el = mainRef.current;
    if (!el) return;

    scrollBaseRef.current = el.scrollTop;

    const onScroll = () => {
      const top = el.scrollTop;
      const max = el.scrollHeight - el.clientHeight;
      const dy = top - scrollBaseRef.current;

      /*
       * 换页后的静默窗口：路由刚变时，浏览器会因为新页面内容变短而把 scrollTop
       * **夹紧**（甚至夹到 0），这一下不是用户滚的。这段窗口里只重同步基线、
       * 不做任何形态判定 —— 否则「从很靠下的位置点进一个短页面」会突然收成合一。
       */
      if (performance.now() < routeSettleRef.current) {
        scrollBaseRef.current = top;
        return;
      }

      // 跳变保护（阈值取「一屏」与 240px 中的较大者：正常滚动一帧远达不到）
      if (Math.abs(dy) > Math.max(240, el.clientHeight)) {
        scrollBaseRef.current = top;
        return;
      }

      /*
       * 设置页不参与"自动换形态"：那里是一长列开关与滑块，用户边看边调，
       * 底栏因为一点滚动就展开、静置后又自己收起，会让界面像在乱跳
       * （用户反馈："设置页面不会自动一变二"）。
       * 所以在这个路由下只重同步基线、绝不切换形态；形态完全由用户手动决定
       * （合一态点左圆 / 歌曲胶囊仍可展开）。
       */
      if (autoSwitchOffRef.current) {
        scrollBaseRef.current = top;
        return;
      }

      // ② 到顶（且没在离开顶部）→ 展开成两栏；基线钉在端点 0
      if (top <= EDGE_DEAD_ZONE && dy <= 0) {
        scrollBaseRef.current = 0;
        changeForm(false);
        return;
      }
      // ② 到底（且没在离开底部）→ 展开成两栏；基线钉在端点 max
      if (max > 0 && max - top <= EDGE_DEAD_ZONE && dy >= 0) {
        scrollBaseRef.current = max;
        changeForm(false);
        return;
      }

      /*
       * ① 收起：累计位移**不分方向**（往上滑、往下滑都算），达到「收起触发距离」就合一。
       * 未达阈值时**不更新基线** —— 这正是「累计」的来源（小幅慢滑会一路累加）。
       */
      if (Math.abs(dy) < collapseDistance) return;
      scrollBaseRef.current = top;
      changeForm(true);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, [liquidDock, changeForm, collapseDistance]);

  /*
   * 换页**不改变形态**，只把滚动基线重同步到新页面的当前位置。
   *
   * 之前这里按「新页面停在 scrollTop = 0」直接判成「到顶 → 合一」，
   * 于是**点一下底栏（= 换页）就把两栏收掉了**；而且基线还停在上一页的位置，
   * 下一次 scroll 又会算出一个巨大 dy，再错误地切一次。
   * 现在：形态保持不动，只把基线对齐；新页面内容更短、位置被浏览器夹回顶部的
   * 极端情况由上面的「跳变保护」兜住，同样不会切形态。
   */
  useEffect(() => {
    if (!liquidDock) return;
    const el = mainRef.current;
    if (!el) return;
    scrollBaseRef.current = el.scrollTop;
    routeSettleRef.current = performance.now() + ROUTE_SETTLE_MS;
  }, [pathname, liquidDock]);

  /*
   * 首次挂载（以及横竖屏/设备档切换）时，按**当前位置**定一次形态：
   * 内容在顶部 → 合一态。
   *
   * 与「到顶 = 展开」不冲突：那一条要求**用户真的滑到端点**（滚动事件），
   * 而这里只是「刚打开页面、还没人滚过」的初始形态 —— 停在顶上不动不会自己展开，
   * 想展开可以点一下合一态的左圆 / 歌曲胶囊，或者往上滑一下再触发端点分支。
   *
   * 只在这一处做位置判定，**换页不做** —— 换页沿用上面的「只重同步基线」，
   * 否则点一下底栏（新页面停在 scrollTop = 0）就会把两栏收掉。
   */
  useEffect(() => {
    if (!liquidDock) return;
    const el = mainRef.current;
    if (!el) return;
    scrollBaseRef.current = el.scrollTop;
    if (el.scrollTop <= EDGE_DEAD_ZONE && !autoSwitchOffRef.current) changeForm(true);
  }, [liquidDock, changeForm]);

  /*
   * 展开态静置过久 → 自动折成一行。
   *
   *   · 计时只在「展开态」里跑（合一态不需要计时）；
   *   · 触摸 / 点击 / 滚动 / 按键等任何交互都把计时清零重来 ——
   *     滚动事件不冒泡，所以监听要挂在捕获阶段才能听到内容区的滚动；
   *   · 用户手动展开（点合一态的左圆 / 歌曲胶囊）后状态变回展开，
   *     本副作用重新运行，计时自然从头开始。
   */
  useEffect(() => {
    if (!liquidDock || collapsed || pathname === "/settings") return;
    const wait = AUTO_COLLAPSE_DELAY_MS[idleSensitivity] ?? AUTO_COLLAPSE_DELAY_MS.medium;
    let timer = 0;
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => changeForm(true), wait);
    };
    ACTIVITY_EVENTS.forEach((t) => window.addEventListener(t, bump, { passive: true, capture: true }));
    window.addEventListener("scroll", bump, { passive: true, capture: true });
    bump();
    return () => {
      window.clearTimeout(timer);
      ACTIVITY_EVENTS.forEach((t) =>
        window.removeEventListener(t, bump, { passive: true, capture: true } as EventListenerOptions),
      );
      window.removeEventListener("scroll", bump, { passive: true, capture: true } as EventListenerOptions);
    };
  }, [liquidDock, collapsed, idleSensitivity, changeForm, pathname]);

  /*
   * 玻璃色调自适应：玻璃背后如果是大面积浅色，就把玻璃上的文字 / 图标转成深色。
   * 采样、亮度计算、滞回都在 @/lib/glassTone 里，这里只负责把覆盖层交给它。
   */
  useEffect(() => {
    if (!liquidDock) return;
    const el = overlayRef.current;
    if (!el) return;
    return installGlassTone(el);
  }, [liquidDock]);

  /*
   * 两态中「非当前」的那一层要整块退出交互：
   * pointer-events: none 已经挡住触摸，但键盘 Tab 仍能聚焦到里面的按钮 ——
   * 补一个 inert，把这一整块从可聚焦树里摘出去。
   *
   * 注意展开态**不能**从布局里拿掉 —— 它一旦卸载，药丸的实测几何、
   * 拖拽 / 惯性 / 变色透镜的状态就全丢了；这里只做视觉上的淡出。
   */
  useEffect(() => {
    const full = expandedRef.current;
    const mini = miniRef.current;
    if (full) {
      if (collapsed) full.setAttribute("inert", "");
      else full.removeAttribute("inert");
    }
    if (mini) {
      if (collapsed) mini.removeAttribute("inert");
      else mini.setAttribute("inert", "");
    }
  }, [collapsed, liquidDock]);

  /*
   * 网络不佳 → 顶部飞下提示框，文案按故障类型区分：
   *   脱机            → 「网络状态不佳，请检查网络连接」
   *   慢速 4G / 3G 等 → 「网络状态不佳，建议更换或重新连接网络」
   *
   * 提示频率规则：
   *  - 网络一直没恢复 → 只提示一次；
   *  - 恢复后**持续正常 5 秒以上**才允许再次提示（短暂抖动不会重复打扰）。
   */
  const quality = useNetworkQuality();
  const showToast = useAppStore((s) => s.showToast);
  const noticeShownRef = useRef(false);
  /** 恢复后需要连续正常多久才重新允许提示 */
  const RECOVER_HOLD_MS = 5_000;

  useEffect(() => {
    if (quality === "good") {
      // 只是「曾经恢复过」不够，要持续正常超过 5 秒才算真正恢复
      const t = window.setTimeout(() => {
        noticeShownRef.current = false;
      }, RECOVER_HOLD_MS);
      return () => window.clearTimeout(t);
    }
    if (noticeShownRef.current) return;
    noticeShownRef.current = true;
    const issue = getNetworkIssue() ?? "slow";
    showToast(NETWORK_MESSAGES[issue]);
  }, [quality, showToast]);

  /** 当前形态下覆盖层的真实高度：折叠态用那一行的高度 */
  const bottomH = collapsed ? miniH : expandedH;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {landscape && <Sidebar />}
      {/*
        data-app-behind：只有**内容区**参与「沉浸歌词页滑出时的缩放 + 去模糊」。
        歌曲栏与底栏必须留在这一层之外 ——
        否则拖动沉浸页时它们会跟着缩放、位移、模糊（用户反馈：不管怎么拖，这两栏都不该动）。
      */}
      <div className={cn("flex flex-1 flex-col overflow-hidden", liquidDock && "relative")}>
        <main
          ref={mainRef}
          data-app-behind
          className="flex-1 overflow-y-auto"
          // 只在液态玻璃分支补底部内边距（覆盖层实测高度），其余分支保持原样
          style={liquidDock ? { paddingBottom: bottomH } : undefined}
        >
          {children}
        </main>
        {liquidDock ? (
          /*
            触屏竖屏：歌曲栏与玻璃停靠栏一起放进底部覆盖层。
            绝对定位 → 脱离文档流 → 内容从它们**后面**滚过去（玻璃才有东西可模糊）。

            覆盖层里叠着两态：
              · 展开态（在文档流里，决定覆盖层高度）：玻璃歌曲栏 + 大药丸，两行；
              · 合一态（绝对定位贴底）：左圆 + 歌曲胶囊 + 右圆，一行。
            切换时两层各自只做**不透明度**的交叉（进来的快、出去的稍慢），
            位移与尺寸全部交给 @/lib/touchMorph 的 FLIP 形变 ——
            所以这两层自己**绝不能带 transform**：祖先的 transform 会被算进
            getBoundingClientRect，形变的「终点矩形」就量歪了。
          */
          <div
            ref={overlayRef}
            className="absolute inset-x-0 bottom-0 z-30 flex flex-col"
            /* 自检用：当前是哪一态（"full" = 两栏展开 / "mini" = 一行合一） */
            data-touch-form={collapsed ? "mini" : "full"}
          >
            <div
              ref={expandedRef}
              aria-hidden={collapsed}
              className={cn("flex flex-col", collapsed && "pointer-events-none")}
              style={{
                opacity: collapsed ? 0 : 1,
                transition: `opacity ${collapsed ? FADE_OUT_MS : FADE_IN_MS}ms ease`,
              }}
            >
              {/* 触屏竖屏专用的玻璃歌曲栏；鼠标端与横屏下面那条分支仍用原来的 PlayerBar */}
              <TouchSongBar />
              <TouchDockNav />
            </div>

            <div
              ref={miniRef}
              aria-hidden={!collapsed}
              className={cn("absolute inset-x-0 bottom-0", !collapsed && "pointer-events-none")}
              style={{
                opacity: collapsed ? 1 : 0,
                transition: `opacity ${collapsed ? FADE_IN_MS : FADE_OUT_MS}ms ease`,
              }}
            >
              <TouchMiniBar onExpand={() => changeForm(false)} />
            </div>
          </div>
        ) : (
          /* 鼠标端 / 横屏：原来那套结构，一行未动 */
          <>
            <PlayerBar />
            {!landscape && <BottomNav />}
          </>
        )}
      </div>
      <LyricsSheet />
      <Toast />
    </div>
  );
}
