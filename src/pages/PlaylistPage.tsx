import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Play, Loader2, CalendarDays, ListMusic, Compass, RefreshCw } from "lucide-react";
import { netease } from "@/lib/netease";
import { mapSongToTrack, mapPlaylistMeta, type Track, type PlaylistMeta } from "@/lib/mappers";
import { formatCount } from "@/lib/format";
import { dedupeSongsById, PLAYLIST_PAGE_SIZE } from "@/lib/playlistPaging";
import { readPlaylistCache, writePlaylistCache } from "@/lib/playlistCache";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import SongRow from "@/components/playlist/SongRow";
import { usePlayerStore } from "@/stores/playerStore";

interface TrackPageRequest {
  limit: number;
  offset: number;
  count: number;
}

export default function PlaylistPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const playTrack = usePlayerStore((s) => s.playTrack);

  const openExplore = () => {
    // 探索页不主动请求/退出全屏；用户自己按 F11 即可
    navigate(`/playlist/${id}/explore`);
  };

  const [meta, setMeta] = useState<PlaylistMeta | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [cacheHit, setCacheHit] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const nextOffsetRef = useRef(0);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const loadMoreErrorRef = useRef(false);
  const trackCountRef = useRef(0);
  const idRef = useRef(id);
  const aliveRef = useRef(true);
  const requestLogRef = useRef<TrackPageRequest[]>([]);
  const metaRef = useRef<PlaylistMeta | null>(null);
  const tracksRef = useRef<Track[]>([]);
  metaRef.current = meta;
  tracksRef.current = tracks;

  useEffect(() => {
    idRef.current = id;
  }, [id]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /* 首屏：仍然只取第 0 页 1000 首，保持原来的首屏大小与加载体验 */
  useEffect(() => {
    if (!id) return;
    const playlistId = Number(id);
    if (!Number.isFinite(playlistId)) {
      setError("无效的歌单 ID");
      setLoading(false);
      return;
    }

    let on = true;
    setLoading(true);
    setError(null);
    setTracks([]);
    setMeta(null);
    setHasMore(false);
    hasMoreRef.current = false;
    setLoadingMore(false);
    loadingMoreRef.current = false;
    setLoadMoreError(null);
    loadMoreErrorRef.current = false;
    nextOffsetRef.current = 0;
    trackCountRef.current = 0;
    requestLogRef.current = [];

    // 同一标签页内重新进入/刷新：直接复用已加载的全部页，不再发请求
    const cached = readPlaylistCache(String(playlistId));
    if (cached) {
      setCacheHit(true);
      setMeta(cached.meta);
      metaRef.current = cached.meta;
      setTracks(cached.tracks);
      tracksRef.current = cached.tracks;
      trackCountRef.current = cached.trackCount;
      nextOffsetRef.current = cached.nextOffset;
      hasMoreRef.current = cached.hasMore;
      setHasMore(cached.hasMore);
      setLoading(false);
      return;
    }
    setCacheHit(false);

    void (async () => {
      try {
        const [detail, first] = await Promise.all([
          netease.playlistDetail(playlistId),
          // 显式传 pageSize/offset，首屏仍是原来的 1000 首
          netease.playlistTracks(playlistId, PLAYLIST_PAGE_SIZE, 0),
        ]);
        if (!on) return;

        const metaValue = detail.playlist ? mapPlaylistMeta(detail.playlist) : null;
        setMeta(metaValue);
        metaRef.current = metaValue;
        const songs = first.songs ?? [];
        requestLogRef.current.push({ limit: PLAYLIST_PAGE_SIZE, offset: 0, count: songs.length });

        const mapped = dedupeSongsById(songs.map(mapSongToTrack));
        const total = detail.playlist?.trackCount ?? 0;
        trackCountRef.current = total;
        nextOffsetRef.current = songs.length;
        /*
         * trackCount 是总曲目数，优先用它判断下方是否还有；
         * 只有接口没给总数时才退化为“本页是否满 1000”。
         */
        const more =
          songs.length > 0 &&
          (total > 0 ? songs.length < total : songs.length >= PLAYLIST_PAGE_SIZE);
        hasMoreRef.current = more;
        setHasMore(more);
        setTracks(mapped);
        tracksRef.current = mapped;
        writePlaylistCache({
          playlistId: String(playlistId),
          meta: metaValue,
          tracks: mapped,
          trackCount: total,
          nextOffset: songs.length,
          hasMore: more,
        });
      } catch (e) {
        if (!on) return;
        setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (on) setLoading(false);
      }
    })();

    return () => {
      on = false;
    };
  }, [id]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMoreRef.current || !hasMoreRef.current || loadMoreErrorRef.current) return;
    if (!id) return;
    const playlistId = Number(id);
    if (!Number.isFinite(playlistId)) return;

    const offset = nextOffsetRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);

    try {
      const page = await netease.playlistTracks(playlistId, PLAYLIST_PAGE_SIZE, offset);
      if (!aliveRef.current || String(idRef.current) !== String(id)) return;

      const songs = page.songs ?? [];
      requestLogRef.current.push({ limit: PLAYLIST_PAGE_SIZE, offset, count: songs.length });

      // 按 song.id 去重后再追加，翻页期间歌单变化也不会出现重复行
      const prev = tracksRef.current;
      const seen = new Set(prev.map((track) => track.id));
      const nextTracks = [...prev];
      for (const song of songs) {
        const track = mapSongToTrack(song);
        if (seen.has(track.id)) continue;
        seen.add(track.id);
        nextTracks.push(track);
      }
      tracksRef.current = nextTracks;
      setTracks(nextTracks);

      nextOffsetRef.current = offset + songs.length;
      const total = trackCountRef.current;
      const more =
        songs.length > 0 &&
        (total > 0 ? nextOffsetRef.current < total : songs.length >= PLAYLIST_PAGE_SIZE);
      hasMoreRef.current = more;
      setHasMore(more);
      setLoadMoreError(null);
      loadMoreErrorRef.current = false;

      // 已取过的页立刻写回缓存；再滑回/重新进入不会再请求
      writePlaylistCache({
        playlistId: String(playlistId),
        meta: metaRef.current,
        tracks: nextTracks,
        trackCount: total,
        nextOffset: nextOffsetRef.current,
        hasMore: more,
      });
    } catch (e) {
      if (!aliveRef.current || String(idRef.current) !== String(id)) return;
      const message = e instanceof Error ? e.message : "加载失败";
      loadMoreErrorRef.current = true;
      setLoadMoreError(message);
    } finally {
      loadingMoreRef.current = false;
      if (aliveRef.current && String(idRef.current) === String(id)) setLoadingMore(false);
    }
  }, [id, loading]);

  const retryLoadMore = () => {
    // 失败后不自动重试；只有用户点“重试”才继续
    loadMoreErrorRef.current = false;
    setLoadMoreError(null);
    void loadMore();
  };

  /*
   * 接近底部提前 400px 触发下一页。
   *
   * 内容滚动容器是 AppLayout 的 <main>（overflow-y-auto），不是 window；
   * 所以监听 main 的 scroll，并用 sentinel 相对 main 底部的距离判断。
   * loadingMoreRef 做并发闸门；loadMoreError 时注销监听，失败只能点重试，
   * 不会因为还在底部而无限自动重试。
   */
  useEffect(() => {
    if (loading || !hasMore || loadMoreError) return;
    const main = document.querySelector("main");
    if (!main) return;

    let raf = 0;
    const check = () => {
      raf = 0;
      const el = sentinelRef.current;
      if (!el) return;
      const mainRect = main.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      // 距离容器底部不足 400px 时预加载下一页
      if (rect.top <= mainRect.bottom + 400 && rect.bottom >= mainRect.top - 400) {
        void loadMore();
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };

    main.addEventListener("scroll", onScroll, { passive: true });
    check();
    return () => {
      main.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [loading, hasMore, loadMoreError, loadMore]);

  // 开发环境调试面：验证脚本读请求参数、条数、去重数和错误态
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__AURORA_PLAYLIST__ = {
      playlistId: String(id ?? ""),
      trackCount: meta?.trackCount ?? null,
      loaded: tracks.length,
      unique: new Set(tracks.map((track) => track.id)).size,
      hasMore,
      loadingMore,
      loadMoreError,
      cacheHit,
      requests: requestLogRef.current.map((request) => ({ ...request })),
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__AURORA_PLAYLIST__;
    };
  }, [cacheHit, hasMore, id, loadMoreError, loadingMore, meta, tracks]);

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

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="h-44 w-44 shrink-0 overflow-hidden rounded-xl bg-muted">
          {meta?.coverImgUrl && (
            <img src={meta.coverImgUrl} className="h-full w-full object-cover" alt="" />
          )}
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-2">
          <h1 className="text-2xl font-bold">{meta?.name ?? "歌单"}</h1>
          {meta?.creator && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <ListMusic className="h-4 w-4" />
              {meta.creator}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Play className="h-3.5 w-3.5" /> {formatCount(meta?.playCount)}
            </span>
            <span className="flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5" /> {meta?.trackCount ?? tracks.length} 首
            </span>
          </div>
          {meta?.description && (
            <p className="line-clamp-2 max-w-xl text-sm text-muted-foreground">
              {meta.description}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={playAll} disabled={!tracks.length}>
              <Play className="h-4 w-4" /> 播放全部
            </Button>
            {/* 歌曲探索入口：排列由歌曲集合与特征决定，同一组歌每次打开都一致。
                空歌单也允许进入，探索页会给出「还没有歌曲」的人话提示。 */}
            <Button
              variant="outline"
              onClick={openExplore}
              title="按时长与封面颜色重新排列，用二维 / 伪三维查看"
            >
              <Compass className="h-4 w-4" /> 探索
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-0.5" data-playlist-list>
        {tracks.map((t, i) => (
          <SongRow key={t.id} track={t} index={i} list={tracks} />
        ))}
        {tracks.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            歌单为空或需要登录
          </p>
        )}

        {hasMore && (
          <div
            ref={sentinelRef}
            className="h-px w-full"
            data-playlist-sentinel
            aria-hidden="true"
          />
        )}

        {loadingMore && (
          <div
            className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground"
            data-playlist-loading
          >
            <Loader2 className="h-4 w-4 animate-spin" /> 加载更多…
          </div>
        )}

        {loadMoreError && !loadingMore && (
          <div className="flex flex-col items-center gap-1 py-4" data-playlist-error>
            <button
              type="button"
              onClick={retryLoadMore}
              data-playlist-retry
              className="flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
            >
              <RefreshCw className="h-3.5 w-3.5" /> 加载失败，点击重试
            </button>
            <span
              className="max-w-full truncate text-[10px] text-muted-foreground/70"
              title={loadMoreError}
            >
              {loadMoreError}
            </span>
          </div>
        )}

        {!hasMore && tracks.length > 0 && (
          <p
            className="py-6 text-center text-xs text-muted-foreground"
            data-playlist-end
          >
            没有更多了
          </p>
        )}
      </div>
    </div>
  );
}
