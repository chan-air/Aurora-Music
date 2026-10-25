import type { ExploreColorMap, ExploreLayout } from "@/lib/exploreLayout";

/**
 * 探索页整页缓存：按「歌单 id + 歌曲集合指纹 + 常听/收藏指纹」缓存 layout + colors。
 *
 * - 存储：sessionStorage（同标签页跨路由/刷新有效，关闭标签页即释放）
 * - 容量：最多 3 个歌单；总序列化上限约 2.4MB；超限淘汰最旧条目，写不进去就静默不缓存
 * - 失效：歌曲集合变化（songSetId 变）或常听/收藏候选变化（preference 指纹变）
 *   会 miss；同一歌单旧版本在写入新版本时一并清掉。
 * - 颜色表：成功颜色记录按 songId 永久写死，不因颜色表变化让整页结果失效。
 */
export interface ExploreCacheEntry {
  playlistId: string;
  songSetId: string;
  songCount: number;
  preferenceFingerprint: string;
  /** 仅记录当时颜色表版本，供调试；不参与命中判断 */
  colorRevision: number;
  layout: ExploreLayout;
  colors: ExploreColorMap;
  colorTotal: number;
  algorithmMs: number;
  createdAt: number;
}

const KEY = "aurora:explore:cache:v1";
const MAX_ENTRIES = 3;
const MAX_BYTES = 2_400_000;

function readAll(): ExploreCacheEntry[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ExploreCacheEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries: ExploreCacheEntry[]): void {
  if (typeof sessionStorage === "undefined") return;
  let list = entries.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ENTRIES);
  for (;;) {
    try {
      const raw = JSON.stringify(list);
      if (raw.length > MAX_BYTES) {
        if (list.length <= 1) return;
        list = list.slice(0, -1);
        continue;
      }
      sessionStorage.setItem(KEY, raw);
      return;
    } catch {
      if (list.length <= 1) return;
      list = list.slice(0, -1);
    }
  }
}

/** 命中返回整页结果；歌曲集合/候选变化会 miss */
export function readExploreCache(
  playlistId: string,
  songSetId: string,
  songCount: number,
  preferenceFingerprint: string,
  colorRevision: number,
): ExploreCacheEntry | null {
  void colorRevision;
  const found = readAll().find(
    (entry) =>
      entry.playlistId === playlistId &&
      entry.songSetId === songSetId &&
      entry.songCount === songCount &&
      entry.preferenceFingerprint === preferenceFingerprint,
  );
  return found ?? null;
}

/** 写入新版本；同一歌单旧 songSet/候选版本一并作废 */
export function writeExploreCache(entry: ExploreCacheEntry): void {
  const keep = readAll().filter(
    (old) =>
      old.playlistId !== entry.playlistId &&
      !(
        old.playlistId === entry.playlistId &&
        old.songSetId === entry.songSetId &&
        old.preferenceFingerprint === entry.preferenceFingerprint &&
        old.colorRevision === entry.colorRevision
      ),
  );
  writeAll([entry, ...keep]);
}

/** 调试 / 验证 */
export function readAllExploreCache(): ExploreCacheEntry[] {
  return readAll();
}

export function clearExploreCache(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
