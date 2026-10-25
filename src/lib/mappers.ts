import type { NeteaseSong, NeteasePlaylist, NeteaseAlbumDetail } from "@/types/netease";

/** 前端统一的「歌曲」模型，便于播放与存储 */
export interface Track {
  id: number;
  name: string;
  artists: string;
  album: string;
  albumId?: number;
  picUrl: string;
  duration: number; // 秒
}

export function mapSongToTrack(song: NeteaseSong): Track {
  // 兼容两种返回结构：/cloudsearch 用 ar/al/dt，旧版 /search 用 artists/album/duration
  const artists = song.ar ?? song.artists ?? [];
  const album = song.al ?? song.album;
  const durationMs = song.dt ?? song.duration ?? 0;
  return {
    id: song.id,
    name: song.name ?? "未知歌曲",
    artists: artists.map((a) => a.name).filter(Boolean).join(" / ") || "未知歌手",
    album: album?.name ?? "",
    albumId: album?.id,
    picUrl: album?.picUrl ?? album?.blurPicUrl ?? "",
    duration: durationMs ? Math.round(durationMs / 1000) : 0,
  };
}

export interface PlaylistMeta {
  id: number;
  name: string;
  coverImgUrl: string;
  description: string;
  trackCount: number;
  playCount: number;
  creator: string;
  tags: string[];
}

export function mapPlaylistMeta(p: NeteasePlaylist): PlaylistMeta {
  return {
    id: p.id,
    name: p.name ?? "未命名歌单",
    coverImgUrl: p.coverImgUrl ?? "",
    description: p.description ?? "",
    trackCount: p.trackCount ?? 0,
    playCount: p.playCount ?? 0,
    creator: p.creator?.nickname ?? "",
    tags: p.tags ?? [],
  };
}

export interface AlbumMeta {
  id: number;
  name: string;
  picUrl: string;
  artists: string;
  /** 发行时间（毫秒时间戳），0 表示接口未返回 */
  publishTime: number;
  size: number;
  description: string;
  company: string;
}

export function mapAlbumMeta(a: NeteaseAlbumDetail): AlbumMeta {
  return {
    id: a.id,
    name: a.name ?? "未命名专辑",
    picUrl: a.picUrl ?? a.blurPicUrl ?? "",
    artists: (a.artists ?? []).map((x) => x.name).filter(Boolean).join(" / "),
    publishTime: a.publishTime ?? 0,
    size: a.size ?? 0,
    description: a.description ?? "",
    company: a.company ?? "",
  };
}
