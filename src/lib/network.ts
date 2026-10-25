import { useEffect, useState } from "react";
import { API_BASE } from "./env";

/** 网络质量：good = 正常，poor = 不佳（触发「提示框」） */
export type NetworkQuality = "good" | "poor";

/**
 * 不佳的**类型**，决定提示文案：
 *  - offline：脱机（浏览器报告离线，或连接类型为 none）
 *  - slow   ：慢速网络（3G 及以下，或 4G 但速率/RTT 很差），也涵盖「在线但探测失败」的情况
 */
export type NetworkIssue = "offline" | "slow";

/** 两类故障对应的提示文案（提示框直接内嵌使用） */
export const NETWORK_MESSAGES: Record<NetworkIssue, string> = {
  offline: "网络状态不佳，请检查网络连接",
  slow: "网络状态不佳，建议更换或重新连接网络",
};

/** 浏览器网络质量 API（非标准，部分环境没有） */
type NetworkInformation = {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
};

function networkInformation(): NetworkInformation | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { connection?: NetworkInformation };
  return nav.connection ?? null;
}

/**
 * 是否处于「慢速」网络：3G 及以下，或 4G 但下行速率低 / 往返延迟大（即慢速 4G）。
 * 该 API 不是所有环境都支持，取不到时返回 false，交给下面的探测结果判断。
 */
function isSlowConnection(): boolean {
  const c = networkInformation();
  if (!c) return false;
  const et = c.effectiveType;
  if (et === "slow-2g" || et === "2g" || et === "3g") return true;
  if (et === "4g") {
    const dl = typeof c.downlink === "number" ? c.downlink : Number.POSITIVE_INFINITY;
    const rtt = typeof c.rtt === "number" ? c.rtt : 0;
    if (dl < 1 || rtt > 500) return true;
  }
  return false;
}

/** 每 10 秒体检一次 */
const CHECK_INTERVAL = 10_000;
/** 单次体检超时 */
const PROBE_TIMEOUT = 5_000;
/** 响应慢于这个值也算不佳 */
const SLOW_MS = 3_000;
/** 连续几次异常才判定为「不佳」，避免偶发抖动误报 */
const BAD_TO_DECLARE = 2;
/** 连续几次正常才恢复，避免反复横跳 */
const GOOD_TO_RECOVER = 2;

let current: NetworkQuality = "good";
/** 当前不佳的原因（仅在 current === "poor" 时有意义） */
let currentIssue: NetworkIssue = "slow";
let timer: number | null = null;
let running = false;
let badStreak = 0;
let goodStreak = 0;
const listeners = new Set<(q: NetworkQuality) => void>();

export function getNetworkQuality(): NetworkQuality {
  return current;
}

/** 读取当前不佳的类型；网络正常时返回 null */
export function getNetworkIssue(): NetworkIssue | null {
  return current === "poor" ? currentIssue : null;
}

export function subscribeNetworkQuality(fn: (q: NetworkQuality) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(next: NetworkQuality) {
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l(next));
}

/**
 * 一次体检：打一次很轻的接口。
 * 代理始终返回 200，真正的成败在 body.code 里，所以要看 code。
 */
async function probe(): Promise<{ ok: boolean; ms: number }> {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    const res = await fetch(`${API_BASE}/search?keywords=aurora&limit=1&type=1`, {
      signal: controller.signal,
      cache: "no-store",
    });
    const ms = performance.now() - started;
    if (!res.ok) return { ok: false, ms };
    const json = (await res.json()) as { code?: number } | null;
    return { ok: json?.code === 200, ms };
  } catch {
    return { ok: false, ms: performance.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

async function tick() {
  if (!running) return;

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    // 系统直接报告离线，立刻判定
    badStreak += 1;
    goodStreak = 0;
    currentIssue = "offline";
    emit("poor");
  } else {
    const { ok, ms } = await probe();
    if (!running) return;
    /*
     * 慢速网络（3G 及以下 / 慢速 4G）即便探测能通，也直接算「不佳」——
     * 这正是需求里「检测到网络质量为慢速4G或3G就提示」的那条路径。
     */
    const slow = isSlowConnection();
    if (ok && ms <= SLOW_MS && !slow) {
      goodStreak += 1;
      badStreak = 0;
    } else {
      badStreak += 1;
      goodStreak = 0;
      // 在线但慢/探测失败：归类为 slow（文案是「建议更换或重新连接网络」）
      currentIssue = "slow";
    }
    if (badStreak >= BAD_TO_DECLARE) emit("poor");
    else if (goodStreak >= GOOD_TO_RECOVER) emit("good");
  }

  if (running) timer = window.setTimeout(tick, CHECK_INTERVAL);
}

/** 启动监测（幂等，重复调用无副作用） */
export function startNetworkMonitor() {
  if (running || typeof window === "undefined") return;
  running = true;
  badStreak = 0;
  goodStreak = 0;

  const kick = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void tick();
  };

  window.addEventListener("online", kick);
  window.addEventListener("offline", kick);
  window.addEventListener("focus", kick);

  // 首检稍微延后，别和启动时的资源加载抢带宽
  timer = window.setTimeout(tick, 3_000);
}

export function stopNetworkMonitor() {
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 订阅网络质量 */
export function useNetworkQuality(): NetworkQuality {
  const [quality, setQuality] = useState<NetworkQuality>(getNetworkQuality);
  useEffect(() => subscribeNetworkQuality(setQuality), []);
  return quality;
}
