// NeteaseCloudMusicApi 返回数据类型定义（与 Node 代理 /song/url/v1 等接口对应）

export interface NeteaseArtist {
  id: number;
  name: string;
}

export interface NeteaseAlbum {
  id: number;
  name: string;
  picUrl?: string;
  blurPicUrl?: string;
  picId?: number;
}

/**
 * 专辑详情（/album 接口返回的 album 对象）。
 * 比搜索结果的 NeteaseAlbumSearch 多出歌手列表、发行时间、曲目数等字段。
 */
export interface NeteaseAlbumDetail extends NeteaseAlbum {
  artists?: NeteaseArtist[];
  publishTime?: number; // 发行时间（毫秒时间戳）
  size?: number; // 曲目数
  company?: string; // 发行公司
  description?: string;
}

export interface NeteaseSong {
  id: number;
  name: string;
  // /cloudsearch、歌曲详情等新接口
  ar?: NeteaseArtist[];
  al?: NeteaseAlbum;
  dt?: number; // 时长（毫秒）
  // 旧版 /search 接口用的是这几个字段
  artists?: NeteaseArtist[];
  album?: NeteaseAlbum;
  duration?: number; // 时长（毫秒）
  fee?: number; // 0 免费 / 1 VIP / 8 付费等
  mv?: number;
}

export interface NeteaseUser {
  userId: number;
  nickname: string;
  avatarUrl: string;
  signature?: string;
  gender?: number;
  birthday?: number;
  level?: number;
  followeds?: number;
  follows?: number;
  eventCount?: number;
  playlistCount?: number;
}

export interface NeteasePlaylist {
  id: number;
  name: string;
  coverImgUrl?: string;
  trackCount?: number;
  playCount?: number;
  description?: string;
  tags?: string[];
  subscribed?: boolean;
  creator?: { userId: number; nickname: string; avatarUrl?: string };
}

export interface UserDetailResponse {
  code: number;
  level?: number;
  listenSongs?: number;
  profile?: NeteaseUser;
  createTime?: number;
  createDays?: number;
}

export interface UserPlaylistResponse {
  code: number;
  more?: boolean;
  version?: string;
  playlist?: NeteasePlaylist[];
}

export interface RecordItem {
  playCount: number;
  score: number;
  song: NeteaseSong;
}

export interface UserRecordResponse {
  code: number;
  allData?: RecordItem[];
  weekData?: RecordItem[];
}

export interface PlaylistDetailResponse {
  code: number;
  playlist?: NeteasePlaylist & { trackIds?: { id: number }[]; tracks?: NeteaseSong[] };
}

export interface PlaylistTrackAllResponse {
  code: number;
  songs?: NeteaseSong[];
  privileges?: unknown[];
}

/** /album 接口：一次返回专辑元信息与全部歌曲 */
export interface AlbumDetailResponse {
  code: number;
  album?: NeteaseAlbumDetail;
  songs?: NeteaseSong[];
}

export interface SongUrlItem {
  id: number;
  url: string | null;
  br?: number;
  size?: number;
  type?: string;
  level?: string;
  encodeType?: string;
}

export interface SongUrlResponse {
  code: number;
  data?: SongUrlItem[];
}

export interface LyricResponse {
  code: number;
  lrc?: { version?: number; lyric?: string };
  klyric?: { version?: number; lyric?: string };
  tlyric?: { version?: number; lyric?: string };
  romalrc?: { version?: number; lyric?: string };
  yrc?: { version?: number; lyric?: string };
  nolyric?: boolean;
  uncollected?: boolean;
}

export interface SongDetailResponse {
  code: number;
  songs?: NeteaseSong[];
}

export interface SearchSongsResponse {
  code: number;
  result?: { songs?: NeteaseSong[]; songCount?: number };
}

export interface SearchPlaylistsResponse {
  code: number;
  result?: { playlists?: NeteasePlaylist[]; playlistCount?: number };
}

export interface NeteaseArtistSearch {
  id: number;
  name: string;
  picUrl?: string;
  albumSize?: number;
  musicSize?: number;
  followed?: boolean;
}

export interface NeteaseAlbumSearch {
  id: number;
  name: string;
  artist?: { id: number; name: string };
  picUrl?: string;
  size?: number;
}

export interface NeteaseUserSearch {
  userId: number;
  nickname: string;
  avatarUrl?: string;
  signature?: string;
  followed?: boolean;
}

export interface SearchArtistsResponse {
  code: number;
  result?: { artists?: NeteaseArtistSearch[]; artistCount?: number };
}

export interface SearchAlbumsResponse {
  code: number;
  result?: { albums?: NeteaseAlbumSearch[]; albumCount?: number };
}

export interface SearchUsersResponse {
  code: number;
  result?: { userprofiles?: NeteaseUserSearch[]; userprofileCount?: number };
}
