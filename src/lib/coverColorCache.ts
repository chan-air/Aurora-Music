import { coverColorAsync } from "@/lib/glassTone";
import type { ExploreColor } from "@/lib/exploreLayout";

/**
 * 「歌曲封面颜色」持久化表（localStorage，跨刷新/跨歌单复用）。
 *
 * - 键：aurora:cover:colors:v1
 * - 字段：{ rev, entries: { [songId]: { color:{r,g,b}, at, used } } }
 *   rev 每次写入自增，供探索页整页缓存判断颜色表是否变化。
 * - 容量：最多 3000 首，按 used（最近一次读取/写入）淘汰最久未用的。
 * - 只存成功算出的颜色；网络失败/无封面不写，下次还能重试。
 */
interface CoverColorEntry {
  color: ExploreColor;
  at: number;
  used: number;
}

interface CoverColorStore {
  rev: number;
  entries: Record<string, CoverColorEntry>;
}

const KEY = "aurora:cover:colors:v1";
const MAX_ENTRIES = 3000;
const stats = { hits: 0, misses: 0 };
let store: CoverColorStore | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function validColor(color: ExploreColor | null | undefined): color is ExploreColor {
  return (
    Boolean(color) &&
    Number.isFinite(color!.r) &&
    Number.isFinite(color!.g) &&
    Number.isFinite(color!.b) &&
    !(color!.r === 0 && color!.g === 0 && color!.b === 0)
  );
}

function load(): CoverColorStore {
  if (store) return store;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CoverColorStore;
      if (parsed && parsed.entries && typeof parsed.rev === "number") {
        store = { rev: parsed.rev, entries: parsed.entries };
        return store;
      }
    }
  } catch {
    /* 坏数据按空表处理 */
  }
  store = { rev: 0, entries: {} };
  return store;
}

function persistNow(): void {
  if (!store) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* 容量满/隐私模式：保留内存表，不阻塞取色 */
  }
}

function schedulePersist(): void {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    persistNow();
  }, 600);
}

function evict(): void {
  const s = load();
  const keys = Object.keys(s.entries);
  if (keys.length <= MAX_ENTRIES) return;
  keys.sort((a, b) => s.entries[a].used - s.entries[b].used);
  for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete s.entries[key];
}

/** 只读查表；命中会更新 used（LRU），不触发网络 */
export function getCachedCoverColor(songId: number): ExploreColor | null {
  const s = load();
  const entry = s.entries[String(songId)];
  if (!entry || !validColor(entry.color)) {
    stats.misses++;
    return null;
  }
  entry.used = Date.now();
  stats.hits++;
  schedulePersist();
  return { ...entry.color };
}

/** 写入一条颜色；只接受有效颜色。已有成功记录时永不覆盖（同一首写死一次） */
export function setCachedCoverColor(songId: number, color: ExploreColor | null): void {
  if (!validColor(color)) return;
  const s = load();
  if (s.entries[String(songId)]) return;
  const now = Date.now();
  s.entries[String(songId)] = {
    color: { ...color, r: color.r, g: color.g, b: color.b },
    at: now,
    used: now,
  };
  s.rev++;
  evict();
  persistNow();
}

function coverThumb(url: string, size: number): string {
  if (!url) return "";
  if (/[?&]param=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}param=${size}y${size}`;
}

/**
 * 探索页取色入口：本地表 → 命中直接返回（0 网络）→ 未命中才取图计算并写回。
 */
export async function coverColorForSong(
  songId: number,
  picUrl: string | null | undefined,
): Promise<ExploreColor | null> {
  const cached = getCachedCoverColor(songId);
  if (cached) return cached;
  if (!picUrl) return null;
  const color = await coverColorAsync(coverThumb(picUrl, 64));
  if (!color) return null;
  const rich: ExploreColor = {
    r: color.r,
    g: color.g,
    b: color.b,
    dominant: color.dominant,
    secondary: color.secondary,
    variance: color.variance,
    palette: color.palette,
  };
  setCachedCoverColor(songId, rich);
  return rich;
}

/** 颜色表版本：每次写入自增；探索页整页缓存把它放进 key，颜色变化后自动 miss */
export function getCoverColorCacheRevision(): number {
  return load().rev;
}

export function getCoverColorCacheStats(): {
  hits: number;
  misses: number;
  size: number;
  revision: number;
  capacity: number;
} {
  return {
    hits: stats.hits,
    misses: stats.misses,
    size: Object.keys(load().entries).length,
    revision: load().rev,
    capacity: MAX_ENTRIES,
  };
}

export function clearCoverColorCache(): void {
  store = { rev: 0, entries: {} };
  stats.hits = 0;
  stats.misses = 0;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  // 只读观测：getter 返回当前统计快照，不向业务暴露写入接口
  Object.defineProperty(window, "__AURORA_COVER_CACHE_STATS__", {
    configurable: true,
    get: () => getCoverColorCacheStats(),
  });
}
