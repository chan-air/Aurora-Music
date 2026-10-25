/**
 * 歌曲探索的「上次退出位置」会话状态。
 *
 * 规则（每个歌单独立）：
 *   A. 退出探索页后一直待在退出时所在页面 → 再进同一个歌单：恢复上次焦点/相机位置。
 *   B. 退出后去过别的页面（一次性作废，回到退出页也不再恢复）→ 再进：焦点=播放器
 *      currentTrack（不管是否在播放；不在歌单里则回落到算法默认选中）。
 *
 * 状态显式存在 sessionStorage（每个标签页会话），并带 stillOnExitPath 一次性门闩。
 * 纯数据模块：不依赖 React、不依赖网络/时间/随机。
 */
export interface ExploreSession {
  playlistId: string;
  focusSongId: number | null;
  view: { wx: number; wy: number } | null;
  /** 上一次离开探索页后所在的 pathname */
  exitPath: string | null;
  /** 是否仍待在这个 exitPath、没有被别的路由作废 */
  stillOnExitPath: boolean;
}

const KEY = "aurora:explore:sessions";

function readAll(): Record<string, ExploreSession> {
  if (typeof sessionStorage === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ExploreSession>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, ExploreSession>): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 存储满 / 隐私模式：静默降级，不影响页面 */
  }
}

function isExplorePath(pathname: string): string | null {
  const match = /^\/playlist\/([^/]+)\/explore\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/** 读某个歌单的会话（无则 null） */
export function readExploreSession(playlistId: string): ExploreSession | null {
  const all = readAll();
  const record = all[playlistId];
  return record ? { ...record } : null;
}

/**
 * 只更新焦点/相机位置，**不改** exitPath / stillOnExitPath。
 * 探索页在焦点变化与卸载时调用。
 */
export function writeExploreFocus(
  playlistId: string,
  focusSongId: number | null,
  view: { wx: number; wy: number } | null,
): void {
  if (!playlistId) return;
  const all = readAll();
  const prev = all[playlistId];
  all[playlistId] = {
    playlistId,
    focusSongId,
    view: view ? { wx: view.wx, wy: view.wy } : null,
    exitPath: prev?.exitPath ?? null,
    stillOnExitPath: prev?.stillOnExitPath ?? false,
  };
  writeAll(all);
}

/**
 * 全局路由监听：AppLayout 在 pathname 变化时调用。
 * - prevPath 正在离开探索页 → 给该歌单记录 exitPath=nextPath，stillOnExitPath=true；
 * - 当前不在某歌单的探索页，且不在它的 exitPath → 该记录一次性作废；
 * - 进入探索页时不要作废（先让 ExplorePage 读 A 状态）。
 */
export function noteExploreRouteChange(prevPath: string | null, nextPath: string): void {
  if (typeof sessionStorage === "undefined") return;
  const all = readAll();
  const prevExplore = prevPath ? isExplorePath(prevPath) : null;
  const nextExplore = isExplorePath(nextPath);

  if (prevExplore && prevExplore !== nextExplore) {
    const prev = all[prevExplore];
    if (prev) {
      prev.exitPath = nextPath;
      prev.stillOnExitPath = true;
    } else {
      all[prevExplore] = {
        playlistId: prevExplore,
        focusSongId: null,
        view: null,
        exitPath: nextPath,
        stillOnExitPath: true,
      };
    }
  }

  for (const [pid, record] of Object.entries(all)) {
    // 正在进入该歌单的探索页：保留状态供 ExplorePage 消费
    if (nextExplore === pid) continue;
    // 回到 exitPath / 仍待在那里：保留
    if (record.stillOnExitPath && nextPath === record.exitPath) continue;
    // 其它任何路由：一次性作废
    if (record.stillOnExitPath) record.stillOnExitPath = false;
  }

  writeAll(all);
}

/** 调试 / 验证：读取全部记录 */
export function readAllExploreSessions(): Record<string, ExploreSession> {
  return readAll();
}
