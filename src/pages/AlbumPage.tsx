import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Play, Loader2, CalendarDays, Disc3 } from "lucide-react";
import { netease } from "@/lib/netease";
import { mapSongToTrack, mapAlbumMeta, type Track, type AlbumMeta } from "@/lib/mappers";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import SongRow from "@/components/playlist/SongRow";
import { usePlayerStore } from "@/stores/playerStore";

/**
 * 专辑发行时间格式化：接口给的是毫秒时间戳，取到「YYYY-MM-DD」即可。
 * 拿不到时间（0 / 非法）时返回空串，由调用处决定不渲染那一行。
 */
function formatPublishDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 专辑详情页：结构照搬 PlaylistPage（封面 + 元信息 + 播放全部 + 歌曲列表） */
export default function AlbumPage() {
  const { id } = useParams();
  const playTrack = usePlayerStore((s) => s.playTrack);

  const [meta, setMeta] = useState<AlbumMeta | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 专辑 id 必须是数字；非数字直接报错，不再打接口
    const albumId = Number(id);
    if (!id || !Number.isFinite(albumId)) {
      setLoading(false);
      setError("无效的专辑 ID");
      return;
    }
    let on = true;
    setLoading(true);
    setError(null);
    netease
      .album(albumId)
      .then((res) => {
        if (!on) return;
        if (!res.album) {
          setError("未找到该专辑");
          setTracks([]);
          return;
        }
        setMeta(mapAlbumMeta(res.album));
        // 歌曲一律走项目既有的 mapper，与歌单 / 搜索页保持同一套 Track 结构
        setTracks((res.songs ?? []).map(mapSongToTrack));
      })
      .catch((e) => {
        if (on) setError(e instanceof Error ? e.message : "加载失败");
      })
      .finally(() => {
        if (on) setLoading(false);
      });
    return () => {
      on = false;
    };
  }, [id]);

  const playAll = () => {
    if (tracks.length) void playTrack(tracks[0], tracks);
  };

  if (loading) {
    return (
      <div className="space-y-4 px-6 py-6">
        <div className="flex gap-4">
          <Skeleton className="h-44 w-44 rounded-lg" />
          <div className="space-y-3">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-32" />
          </div>
        </div>
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return <div className="px-6 py-10 text-sm text-destructive">{error}</div>;
  }

  const publishDate = formatPublishDate(meta?.publishTime ?? 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="h-44 w-44 shrink-0 overflow-hidden rounded-xl bg-muted">
          {meta?.picUrl && (
            <img src={meta.picUrl} className="h-full w-full object-cover" alt="" />
          )}
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-2">
          <h1 className="text-2xl font-bold">{meta?.name ?? "专辑"}</h1>
          {meta?.artists && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Disc3 className="h-4 w-4" />
              {meta.artists}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {publishDate && (
              <span className="flex items-center gap-1">
                <CalendarDays className="h-3.5 w-3.5" /> {publishDate} 发行
              </span>
            )}
            <span className="flex items-center gap-1">
              <Play className="h-3.5 w-3.5" /> {meta?.size || tracks.length} 首
            </span>
          </div>
          {meta?.company && (
            <p className="line-clamp-1 text-sm text-muted-foreground">{meta.company}</p>
          )}
          {meta?.description && (
            <p className="line-clamp-2 max-w-xl text-sm text-muted-foreground">
              {meta.description}
            </p>
          )}
          <div>
            <Button onClick={playAll} disabled={!tracks.length}>
              <Play className="h-4 w-4" /> 播放全部
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-0.5">
        {tracks.map((t, i) => (
          <SongRow key={`${t.id}-${i}`} track={t} index={i} list={tracks} />
        ))}
        {tracks.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {loading ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : "专辑为空或需要登录"}
          </p>
        )}
      </div>
    </div>
  );
}
