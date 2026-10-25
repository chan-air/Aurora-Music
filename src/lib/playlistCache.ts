import type { PlaylistMeta, Track } from "@/lib/mappers";

/**
 * 歌单列表页缓存：按歌单 id 缓存已加载的全部页，重新进入/刷新时直接复用。
 *
 * - 存储：sessionStorage（同标签页跨路由/刷新）
 * - 容量：最多 3 个歌单，总序列化上限约 2.2MB
 * - 失效：10 分钟 TTL；超时重新拉取首屏。歌单在 TTL 内被外部修改可能短暂陈旧，
 *   这是为了满足“同一次会话内不重复请求”的取舍。
 */
export interface PlaylistCacheEntry {
  playlistId: string;
  meta: PlaylistMeta | null;
  tracks: Track[];
  trackCount: number;
  nextOffset: number;
  hasMore: boolean;
  updatedAt: number;
}

const KEY = "aurora:playlist:cache:v1";
const MAX_ENTRIES = 3;
const MAX_BYTES = 2_200_000;
const TTL_MS = 10 * 60 * 1000;

function readAll(): PlaylistCacheEntry[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PlaylistCacheEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries: PlaylistCacheEntry[]): void {
  if (typeof sessionStorage === "undefined") return;
  let list = entries.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES);
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

export function readPlaylistCache(playlistId: string): PlaylistCacheEntry | null {
  const found = readAll().find((entry) => entry.playlistId === playlistId);
  if (!found) return null;
  if (Date.now() - found.updatedAt > TTL_MS) return null;
  return found;
}

export function writePlaylistCache(entry: Omit<PlaylistCacheEntry, "updatedAt">): void {
  const next: PlaylistCacheEntry = { ...entry, updatedAt: Date.now() };
  const keep = readAll().filter((old) => old.playlistId !== entry.playlistId);
  writeAll([next, ...keep]);
}

export function readAllPlaylistCache(): PlaylistCacheEntry[] {
  return readAll();
}

export function clearPlaylistCache(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
