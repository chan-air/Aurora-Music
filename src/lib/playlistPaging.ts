import { netease } from "@/lib/netease";
import type { NeteaseSong } from "@/types/netease";

/** 网易云 /playlist/track/all 单页上限；首屏保持 1000 首不变 */
export const PLAYLIST_PAGE_SIZE = 1000;

/** 按歌曲 id 去重；保留首次出现的顺序 */
export function dedupeSongsById<T extends { id: number }>(songs: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const song of songs) {
    if (seen.has(song.id)) continue;
    seen.add(song.id);
    out.push(song);
  }
  return out;
}

/**
 * 探索页用：在已有首屏 songs 的基础上，按 trackCount 把剩余页取全。
 *
 * - offset 以**接口原始返回条数**推进，不用去重后的条数，避免网页端去重后跳页；
 * - 去重按 song.id，翻页期间歌单变化也不会出现重复行；
 * - trackCount > 0 时以总数为准；trackCount 未知（0）时才退化为“本页是否满页”；
 * - 失败直接抛出，由调用方的错误态处理，不在这里无限重试。
 */
export async function fetchRemainingPlaylistSongs(
  id: number,
  initialSongs: NeteaseSong[],
  trackCount: number,
  onPage?: (pageSize: number, rawLoaded: number, total: number) => void,
): Promise<NeteaseSong[]> {
  const all = dedupeSongsById(initialSongs);
  const seen = new Set<number>(all.map((song) => song.id));
  let offset = initialSongs.length;

  for (;;) {
    if (trackCount > 0 && offset >= trackCount) break;
    const page = await netease.playlistTracks(id, PLAYLIST_PAGE_SIZE, offset);
    const songs = page.songs ?? [];
    if (songs.length === 0) break;

    for (const song of songs) {
      if (seen.has(song.id)) continue;
      seen.add(song.id);
      all.push(song);
    }
    offset += songs.length;
    onPage?.(songs.length, offset, trackCount);

    // 总数未知时只能靠满页判断；有总数时即使本页不满也继续按 offset 取到总数
    if (trackCount === 0 && songs.length < PLAYLIST_PAGE_SIZE) break;
  }

  return all;
}
