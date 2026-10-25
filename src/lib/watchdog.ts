import {
  countPlayingHowls,
  enforceSinglePlayback,
  getHowl,
  usePlayerStore,
} from "@/stores/playerStore";

/**
 * 看门狗：每 3 秒体检一次播放系统。
 *
 * 检测项：
 *  1. 多个声音实例同时播放（最严重，会听到两首歌叠在一起）
 *  2. 播放卡死（状态为播放，但进度长时间不动）
 *  3. 脚本崩溃 / React 根被卸载
 *  4. 主线程长时间冻结（超长帧间隔）
 *
 * 处理策略：能就地修复的就地修复（停掉多余的声音实例），其余只打控制台告警。
 *
 * 注意：这里**不再自动刷新页面**。刷新会打断正在播放的音频、丢失进度，
 * 而且用户正在操作时被强制刷新体验极差；异常留在控制台里可查即可。
 */

const CHECK_MS = 3000;
/** 进度连续多少轮没变化视为卡死（4 × 3s = 12s） */
const STUCK_ROUNDS = 4;
/** 单帧超过该毫秒数视为主线程冻结 */
const FREEZE_MS = 3000;
/** 启动多久之后才开始检查 React 根是否为空（避免误判首屏加载中） */
const ROOT_CHECK_DELAY_MS = 10_000;

let timer: number | null = null;
let rafId = 0;
let bootAt = 0;
let lastFrameAt = 0;
let crashed = false;
let frozen = false;
let lastSeek: number | null = null;
let stuckRounds = 0;

export function startWatchdog(): void {
  if (timer !== null) return;
  bootAt = Date.now();
  lastFrameAt = performance.now();

  // 脚本崩溃（未捕获异常）
  window.addEventListener("error", () => {
    crashed = true;
  });

  // 主线程冻结检测
  const loop = () => {
    const now = performance.now();
    const dt = now - lastFrameAt;
    lastFrameAt = now;
    if (dt > FREEZE_MS && !document.hidden) frozen = true;
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);

  timer = window.setInterval(check, CHECK_MS);
}

export function stopWatchdog(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function check(): void {
  const issues: string[] = [];

  // 1) 同时播放多首：立即就地修复（保留当前实例，停掉其余）
  if (countPlayingHowls() > 1 && !enforceSinglePlayback()) {
    issues.push("multiple-playback");
  }

  // 2) 播放卡死：状态为播放但进度不动
  const { playing } = usePlayerStore.getState();
  const h = getHowl();
  if (playing && h) {
    let pos: number | null = null;
    try {
      const s = h.seek();
      if (typeof s === "number") pos = s;
    } catch {
      /* 实例可能已销毁 */
    }
    if (pos !== null && lastSeek !== null && Math.abs(pos - lastSeek) < 0.05) {
      stuckRounds += 1;
      if (stuckRounds >= STUCK_ROUNDS) issues.push("stuck");
    } else {
      stuckRounds = 0;
    }
    lastSeek = pos;
  } else {
    stuckRounds = 0;
    lastSeek = null;
  }

  // 3) 崩溃：脚本异常，或 React 根被卸载成空
  if (crashed) issues.push("crash");
  if (Date.now() - bootAt > ROOT_CHECK_DELAY_MS) {
    const root = document.getElementById("root");
    if (root && root.childElementCount === 0) issues.push("empty-root");
  }

  // 4) 主线程长时间冻结
  if (frozen) {
    frozen = false;
    issues.push("freeze");
  }

  if (issues.length === 0) return;
  // 只记录，不刷新页面
  console.warn("[watchdog] 播放系统异常：", issues.join(" / "));
}
