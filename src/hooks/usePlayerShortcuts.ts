import { useEffect, useRef } from "react";
import { useAppStore } from "@/stores/appStore";
import { usePlayerStore } from "@/stores/playerStore";

/**
 * 键盘快捷键（全局，只注册一次 —— 由 App.tsx 调用）：
 *
 *  **沉浸歌词页打开时**（`appStore.lyricsOpen`）
 *    · `Space`       → 暂停 / 播放
 *    · `←` / `→`     → 上一首 / 下一首
 *
 *  **其它任何时候**
 *    · `Tab + Space`         → 暂停 / 播放
 *    · `Tab + ←` / `Tab + →` → 上一首 / 下一首
 *
 * 为什么要分两套：不开歌词页时，`Space` / `←` `→` 是页面的原生行为
 * （空格滚一屏、方向键滚动、拖动进度条时调值、在输入框里移光标），
 * 抢过来会把整站弄坏。沉浸歌词页是**全屏播放态、没有可滚动的正文**，
 * 才敢直接占用裸键；其它页面统一挂 `Tab` 前缀，保证不与既有交互打架。
 *
 * ## Tab 前缀的取舍（必读）
 *
 * `Tab` 是键盘导航键，当修饰键用就必然和「按 Tab 跳焦点」冲突。这里的取舍是：
 *  · 在**普通页面**上按 Tab 会被 `preventDefault()`，焦点不动 —— 否则按住 Tab
 *    的瞬间焦点已经跳走、还会连发滚动，`Tab + Space` 根本来不及按；
 *  · `Shift + Tab` **不拦**，仍然是可以正常后退跳焦点的逃生口；
 *  · 焦点在**输入框 / 菜单 / 滑块**里、或**有模态框弹出**时，Tab 完全原生 ——
 *    表单和对话框里的键盘操作一律不受影响；
 *  · 沉浸歌词页里 Tab 也保持原生（那边本来就用裸键，不需要前缀）。
 * 换句话说：牺牲的是「普通页面上用 Tab 向前跳焦点」，换来一个稳定的快捷键。
 *
 * ## 一律不抢的场合
 *  1) 焦点在输入类元素里（input / textarea / select / contenteditable）；
 *  2) 焦点在 Radix 的菜单、列表框、滑块里（方向键要留给它们自己导航）；
 *  3) 有打开的模态框 / 下拉层（歌词设置面板、选择器、右键菜单等）；
 *  4) 事件已被别人处理（`defaultPrevented`），或中文输入法正在组词（`isComposing`）。
 *
 * 另外：
 *  · `event.repeat` 一律拦掉 —— 长按空格会疯狂 toggle，长按方向键会让切歌请求排队；
 *  · 沉浸歌词页里 `Ctrl / Alt / Meta + 键` 全部放行给浏览器 / 系统；
 *  · 队列为空且没有当前曲时直接不管：`toggle()` 会在没有任何音源时把 playing 翻成 true。
 */

/** 焦点是否落在「要打字 / 由方向键自己管」的元素里 */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  /*
   * 用 closest 而不是只看 target 本身：Radix / shadcn 的控件常常在外面套一层
   * div（role="slider"、"menu" 之类），真正可交互的节点才是祖先链上的那个。
   */
  return Boolean(
    el.closest(
      [
        'input',
        'textarea',
        'select',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '[role="searchbox"]',
        '[role="slider"]',
        '[role="menu"]',
        '[role="menubar"]',
        '[role="menuitem"]',
        '[role="listbox"]',
        '[role="option"]',
        '[role="combobox"]',
      ].join(","),
    ),
  );
}

/** 是否有打开的模态框 / 下拉层：有的话把键盘完全让给它 */
function hasOpenOverlay(): boolean {
  return Boolean(
    document.querySelector(
      [
        '[role="dialog"][data-state="open"]',
        '[role="alertdialog"][data-state="open"]',
        '[role="menu"][data-state="open"]',
        '[role="listbox"][data-state="open"]',
      ].join(","),
    ),
  );
}

export function usePlayerShortcuts() {
  /** Tab 当前是否被按住（按下时置 true，抬起 / 失焦时清掉） */
  const tabHeldRef = useRef(false);

  useEffect(() => {
    const resetTab = () => {
      tabHeldRef.current = false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;

      const target = event.target instanceof Element ? event.target : null;

      /* ---- Tab：前缀键本体，永远不触发播放动作 ---- */
      if (event.key === "Tab") {
        // Ctrl+Tab / Alt+Tab / Meta+Tab 是浏览器与系统的，别碰
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        // Shift+Tab 保留原生的「后退跳焦点」，给键盘用户留一条路
        if (event.shiftKey) return;
        /*
         * 输入框、菜单、弹窗里 Tab 必须原生：表单的焦点流转、
         * Radix 的焦点陷阱都靠它，抢了就成"键盘用不了"。
         */
        if (isTypingTarget(target) || hasOpenOverlay()) return;
        // 沉浸歌词页用裸键，不需要也不应该让 Tab 变成前缀
        if (useAppStore.getState().lyricsOpen) return;

        event.preventDefault();
        tabHeldRef.current = true;
        return;
      }

      const isSpace = event.code === "Space" || event.key === " ";
      const isPrev = event.key === "ArrowLeft";
      const isNext = event.key === "ArrowRight";
      if (!isSpace && !isPrev && !isNext) return;

      // 有弹窗 / 下拉层时，键盘归它们（Tab+空格 也不例外）
      if (hasOpenOverlay()) return;

      const player = usePlayerStore.getState();
      // 没歌可放时不占用按键（否则空格只会把 playing 翻成 true，什么都不会响）
      if (!player.current && player.queue.length === 0) return;

      const lyricsOpen = useAppStore.getState().lyricsOpen;
      if (lyricsOpen) {
        // 沉浸歌词页：裸键；带修饰键的一律让给浏览器 / 系统
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        if (isTypingTarget(target)) return;
      } else {
        // 其它页面：必须按住 Tab（Tab 自己已在上面 preventDefault，焦点不会跑）
        if (!tabHeldRef.current) return;
        if (event.ctrlKey || event.altKey || event.metaKey) return;
      }

      /*
       * 长按不连发：但仍要 preventDefault，否则重复的空格会继续滚页面，
       * 重复的 ← / → 会继续滚动。
       */
      if (event.repeat) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      if (isSpace) player.toggle();
      else if (isPrev) player.prev();
      else player.next();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Tab") resetTab();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    // 按住 Tab 时切走窗口（Alt+Tab 等）收不到 keyup，靠失焦兜底
    window.addEventListener("blur", resetTab);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", resetTab);
    };
  }, []);
}
