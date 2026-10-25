import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import {
  clearLyricsCloseExit,
  isFullscreenNow,
  isLyricsCloseExitPending,
  onFullscreenSignal,
} from "@/lib/fullscreen";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * 「沉浸歌词跟随全屏」（**仅电脑端**）：
 *   网页进入全屏 → 自动打开沉浸歌词页；退出全屏 → 自动关闭沉浸歌词页。
 *
 * 「全屏」有两张面孔，这里都认（见 lib/fullscreen.ts）：
 *  · Fullscreen API 全屏 —— 有 fullscreenchange / webkitfullscreenchange 事件；
 *  · 浏览器自带全屏（F11 / 浏览器全屏按钮）—— **不派发任何事件**，只能靠 resize
 *    信号 + "窗口铺满屏幕"判定（实机反馈：只监听 API 事件时，按 F11 不会进入歌词页）。
 *
 * 五条约束，缺一不可：
 *  1) **默认关闭**：开关关闭、或触屏设备时**根本不注册监听**，
 *     现有「全屏与沉浸歌词页互不影响」的行为一字不变；
 *  2) **双向幂等**：状态已经是目标值就不写 store，重复信号不产生任何动作；
 *  3) **不与自己成环**：这里只改 lyricsOpen，**从不**调用 requestFullscreen() /
 *     exitFullscreen()，不会反向制造新的全屏信号（因果只有一跳）；
 *  4) **不截断滑出动画**：关闭歌词页自己触发的退全屏有保护窗口，窗口内一律放行；
 *  5) **尊重用户主动关闭**：用户在某个全屏会话里关掉了歌词页就落门闩
 *     （appStore.lyricsUserClosed），同状态下的重复信号不得把它弹回来
 *     —— 浏览器自带全屏（F11）网页无权退出，用户只能关歌词页，
 *     若再自动重开，用户看到的就是"关不掉"。
 */
export function useLyricsFollowFullscreen() {
  const lyricsFollowFullscreen = useSettingsStore((s) => s.lyricsFollowFullscreen);
  const touch = useSettingsStore((s) => s.touch);
  const { pathname } = useLocation();
  /*
   * 路由豁免：歌曲探索页自己就是全屏画布，用户在探索页按 F11 / 浏览器全屏
   * 只应该重算画布，不能把沉浸歌词页自动弹出来盖住探索页。
   * 只在 /playlist/:id/explore 期间跳过监听；其它页面的原有行为完全不变。
   */
  const exploreRoute = /^\/playlist\/[^/]+\/explore\/?$/.test(pathname);

  useEffect(() => {
    // 开关关闭 / 触屏端 / 探索页：不注册任何监听（等价于"没有这个功能"）
    if (!lyricsFollowFullscreen || touch || exploreRoute) return;

    /**
     * 上一次评估出的全屏状态；null = 还没评估过。
     * 只用来区分「全屏状态**真的**变了」与「同状态的重复信号（拖动窗口的 resize）」——
     * 前者要抬门闩，后者绝不能抬（否则刚被用户关掉的歌词页会被立刻弹回来）。
     */
    let lastFull: boolean | null = null;

    const syncLyricsWithFullscreen = () => {
      const full = isFullscreenNow();
      const app = useAppStore.getState();
      const changed = lastFull !== null && lastFull !== full;
      lastFull = full;

      /*
       * 全屏状态真的变化（进入 ↔ 退出）→ 抬起"用户不要歌词页"的门闩：
       * 用户这次全屏会话已经结束（或换了一次新的全屏会话），
       * 下次进入全屏就该重新自动打开歌词页。
       */
      if (changed && app.lyricsUserClosed) app.clearLyricsUserClosed();

      if (full) {
        /*
         * 进入 / 回到全屏。
         * 这里**不能**无条件作废"关歌词退全屏"的保护窗口：退出全屏时 resize 可能
         * 先于 fullscreenchange 到达，此刻 API 元素还没变成 null，看起来像"进入全屏"，
         * 实际那次退出还没走完 —— 一旦作废窗口，随后到达的 fullscreenchange 就会把
         * 正在滑出的沉浸歌词页立刻卸载（闪一下）。
         * 只有歌词页**已经关着**时才能确定上一次收尾早已结束，这时才作废窗口。
         */
        if (!app.lyricsOpen) {
          // 用户刚在这个全屏会话里主动关掉了歌词页 → 不自动重开（门闩生效）
          if (app.lyricsUserClosed) return;
          clearLyricsCloseExit();
          app.setLyricsOpen(true);
        }
        return;
      }

      // 非全屏：若正处于「关闭歌词页自己退全屏」的保护窗口内 → 放行，交给滑出动画收尾
      if (isLyricsCloseExitPending()) return;
      // 幂等：已经关着就什么都不做
      if (app.lyricsOpen) app.setLyricsOpen(false);
    };

    const unsubscribe = onFullscreenSignal(syncLyricsWithFullscreen);
    /*
     * 开关打开（或启动时设置里已经是开）的那一刻**立即评估一次**：
     *  · 此刻不在全屏（多数情况）→ 保持关闭，不做任何动作；
     *  · 此刻正好在全屏里（例如先按了 F11，再回来打开这个开关）→ 立即跟随，打开歌词页。
     */
    syncLyricsWithFullscreen();

    return unsubscribe;
  }, [lyricsFollowFullscreen, touch, exploreRoute]);
}
