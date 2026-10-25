import { API_BASE } from "./env";
import type {
  UserDetailResponse,
  UserPlaylistResponse,
  UserRecordResponse,
  PlaylistDetailResponse,
  PlaylistTrackAllResponse,
  SongUrlResponse,
  SongUrlItem,
  LyricResponse,
  SearchSongsResponse,
  SearchPlaylistsResponse,
  SearchArtistsResponse,
  SearchAlbumsResponse,
  SearchUsersResponse,
  AlbumDetailResponse,
} from "@/types/netease";

/** 网易云接口错误码 -> 友好提示 */
function neteaseError(code: number): string {
  const map: Record<number, string> = {
    301: "该内容需要登录后才能访问",
    400: "请求参数错误",
    403: "权限不足",
    404: "资源不存在",
    405: "接口异常",
    512: "请求过于频繁，请稍后再试",
  };
  return map[code] ?? `接口返回错误码 ${code}`;
}

/** 通用请求封装 */
async function request<T>(
  path: string,
  params?: Record<string, string | number | boolean>,
): Promise<T> {
  const url = new URL(path, API_BASE);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`请求失败 HTTP ${res.status}：${path}`);
  }
  const json = (await res.json()) as { code?: number };
  if (typeof json.code === "number" && json.code !== 200) {
    throw new Error(neteaseError(json.code));
  }
  return json as T;
}

/** 网易云 API 客户端（全部经由 Node.js NeteaseCloudMusicApi 代理） */
export const netease = {
  /** 用户详情 */
  userDetail: (uid: number) => request<UserDetailResponse>("/user/detail", { uid }),

  /** 用户歌单（创建 + 收藏） */
  userPlaylists: (uid: number, limit = 1000, offset = 0) =>
    request<UserPlaylistResponse>("/user/playlist", { uid, limit, offset }),

  /** 用户听歌排行：type 0 = 所有时间，1 = 最近一周 */
  userRecord: (uid: number, type: 0 | 1 = 0) =>
    request<UserRecordResponse>("/user/record", { uid, type }),

  /** 歌单详情（元信息） */
  playlistDetail: (id: number) => request<PlaylistDetailResponse>("/playlist/detail", { id }),

  /** 歌单全部歌曲 */
  playlistTracks: (id: number, limit = 1000, offset = 0) =>
    request<PlaylistTrackAllResponse>("/playlist/track/all", { id, limit, offset }),

  /** 专辑详情 + 专辑歌曲（/album 一次返回 album 元信息与 songs 列表） */
  album: (id: number) => request<AlbumDetailResponse>("/album", { id }),

  /** 获取可播放地址（level: standard / higher / exhigh / lossless） */
  songUrl: async (id: number, level = "exhigh"): Promise<SongUrlItem | null> => {
    const res = await request<SongUrlResponse>("/song/url/v1", { id, level });
    return res.data?.[0] ?? null;
  },

  /** 歌词（新版接口：lrc 行级 / tlyric 翻译 / yrc 逐字） */
  lyric: (id: number) => request<LyricResponse>("/lyric/new", { id }),

  /** 按关键字搜索歌曲（用 /cloudsearch，返回带封面 picUrl 与 ar 歌手的新版结构） */
  searchSongs: (keywords: string, limit = 30, offset = 0) =>
    request<SearchSongsResponse>("/cloudsearch", { keywords, limit, offset, type: 1 }),

  /** 按关键字搜索歌单 */
  searchPlaylists: (keywords: string, limit = 20, offset = 0) =>
    request<SearchPlaylistsResponse>("/search", { keywords, limit, offset, type: 1000 }),

  /** 按关键字搜索歌手 */
  searchArtists: (keywords: string, limit = 20, offset = 0) =>
    request<SearchArtistsResponse>("/search", { keywords, limit, offset, type: 100 }),

  /** 按关键字搜索专辑 */
  searchAlbums: (keywords: string, limit = 20, offset = 0) =>
    request<SearchAlbumsResponse>("/search", { keywords, limit, offset, type: 10 }),

  /** 按关键字搜索用户 */
  searchUsers: (keywords: string, limit = 20, offset = 0) =>
    request<SearchUsersResponse>("/search", { keywords, limit, offset, type: 1002 }),
};

/**
 * 解析网易云「个人主页链接」为 userId。
 * 支持：
 *   - https://music.163.com/#/user/home?id=12345678
 *   - https://music.163.com/user/home?id=12345678
 *   - 纯数字 ID：12345678
 */
export function parseUserHomeUrl(input: string): number | null {
  const s = (input || "").trim();
  if (!s) return null;

  if (/^\d{4,}$/.test(s)) return Number(s);

  const patterns = [
    /[?&#]id=(\d+)/i,
    /[?&#]uid=(\d+)/i,
    /\/user\/home\/(\d+)/i,
    /\/user\/(\d+)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return Number(m[1]);
  }

  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const id = u.searchParams.get("id") ?? u.searchParams.get("uid");
    if (id && /^\d{4,}$/.test(id)) return Number(id);
  } catch {
    /* 忽略非法 URL */
  }
  return null;
}
