import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Box,
  Compass,
  LayoutGrid,
  Loader2,
  Music2,
  Play,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { netease } from "@/lib/netease";
import {
  mapSongToTrack,
  mapPlaylistMeta,
  type Track,
  type PlaylistMeta,
} from "@/lib/mappers";
import { formatTime } from "@/lib/format";
import {
  buildExploreLayout,
  buildExploreHeights,
  exploreSongSetId,
  type ExploreColor,
  type ExploreColorMap,
  type ExploreLayout,
  type ExplorePlacement,
} from "@/lib/exploreLayout";
import { coverColorForSong, getCoverColorCacheRevision } from "@/lib/coverColorCache";
import { springProgress } from "@/lib/touchMorph";
import { fetchRemainingPlaylistSongs } from "@/lib/playlistPaging";
import { getFavorites, getHistory } from "@/lib/storage";
import { useEffectiveArtists } from "@/lib/artistOverrides";
import {
  readAllExploreCache,
  readExploreCache,
  writeExploreCache,
} from "@/lib/exploreCache";
import {
  readAllExploreSessions,
  readExploreSession,
  writeExploreFocus,
} from "@/lib/exploreSession";
import {
  getFullscreenElement,
  isFullscreenNow,
  isWindowFullscreen,
  onFullscreenSignal,
} from "@/lib/fullscreen";
import { useAppStore } from "@/stores/appStore";
import { usePlayerStore } from "@/stores/playerStore";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 歌曲探索 · 全屏沉浸式交互层。
 *
 *  - 画布是远大于内容的**硬边界世界平面**（至少 6 个视口宽高）；内容居中，
 *    空白区域可以自由拖动；拖到世界硬边界才停，不会在内容边缘被吸回去。
 *  - 焦点只由「屏幕中心最近的歌曲」决定；焦点落在空白时保持上一首并提示继续探索。
 *  - 点任意歌曲把焦点/相机吸附过去；点当前焦点进入沉浸歌词页。
 *  - 全屏只由用户自己按 F11 / 浏览器全屏触发，探索页不主动请求或退出全屏。
 *  - 2D/3D 共用同一份布局；3D 以焦点顶面的投影中心对齐视口中心。
 *
 * 页面通过 portal 挂到 document.body 上，而不是留在 AppLayout 的 [data-app-behind]
 * 里：沉浸歌词页会给 [data-app-behind] 做 scale(0.9) + blur(6px) 的“背景后退”，
 * 那是**另一套动画**。portal 让它成为独立的 fixed 层（z-35，低于歌词页 z-40），
 * 歌词页打开期间仍保持挂载和可见，关闭时直接露出探索层而不是歌单页。
 */

/** 内容显示大小滑条：只改变 cell，不碰浏览器 zoom / DPR */
const CONTENT_SCALE_MIN = 0.7;
const CONTENT_SCALE_MAX = 1.4;
const CONTENT_SCALE_STEP = 0.01;
/** 环形平铺的 3×3 份内容副本（每份都按同一 layout 取歌） */
const COPY_OFFSETS = [-1, 0, 1] as const;

function wrapPeriod(value: number, period: number): number {
  if (!(period > 0) || !Number.isFinite(value)) return 0;
  return ((value % period) + period) % period;
}

/** 2D 单位格基准尺寸：让网格至少铺出屏幕，而不是缩成一条 */
const CELL_2D_FILL = 1.12;
/** 3D 的平面被相机压扁，单位格再放大一点，保证也铺出屏幕 */
const CELL_3D_FACTOR = 1.15;
/** 3D 相机：固定俯角 + 固定旋转；不设 perspective，因此是平行投影。
 *  48° 而不是更陡的 58°：屏幕竖屏下 7×8 的网格会被压得太扁、下方空出一大块；
 *  48° 仍能看清侧面高度，同时网格铺满整屏。 */
const CAMERA_TILT_X = 48;
const CAMERA_ROTATE_Z = -28;
/** 3D 块高度范围（相对单位格） */
const HEIGHT_MIN_UNITS = 0.16;
const HEIGHT_MAX_UNITS = 1.9;
/** 吸附动画时长：与底栏大药丸的 460ms 吸附节奏一致；曲线复用 touchMorph.springProgress */
const SNAP_MS = 460;
/** 松手时按最近的 120ms 速度多甩一段，再找最近格位 */
const FLING_MS = 150;
/** 拖拽超过这个距离就不算点击 */
const TAP_SLOP = 8;
/** 点击最长持续时间；超过按拖动处理（慢速短拖也不能误判为点击） */
const TAP_MAX_MS = 520;
/** 点击允许的最大位移：真实点击 0–2px；3–7px 的小幅甩动必须算拖动 */
const TAP_MAX_MOVE = 2.5;
/** 峰值速度阈值（px/ms）：快速小幅甩动即使位移 <8px 也算拖动 */
const DRAG_SPEED_THRESHOLD = 0.1;
/** 小于这个位移只可能是手指抖动，不参与速度判别（真实点击 0–2px 不受影响） */
const DRAG_SPEED_MIN_DISTANCE = 2.5;
/** 进入歌词页的过渡：探索层放大/模糊时长、背景变色时长 */
const OPEN_MOVE_MS = 620;
const OPEN_TINT_MS = 420;

type Mode = "2d" | "3d";
type Status = "loading" | "ready" | "empty" | "error";

interface DragState {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
  lastMoveTime: number;
  /** 本次手势的峰值速度（px/ms），用于区分快速小幅甩动与点击 */
  peakSpeed: number;
  moved: boolean;
  /** 按下时命中的歌曲块（orderIndex）；空背景为 null */
  hitOrder: number | null;
  /** 按下时命中的 wrap 副本偏移 */
  hitCopyX: number | null;
  hitCopyY: number | null;
  samples: { t: number; x: number; y: number }[];
}

interface ViewPoint {
  /** 画布中心对应的世界坐标，单位＝单元格（不是 px） */
  wx: number;
  wy: number;
}

interface ExploreWorld {
  /** 世界宽/高（单位格） */
  w: number;
  h: number;
  /** 内容左上角在世界里的偏移（单位格） */
  offX: number;
  offY: number;
}

interface ExploreGeom {
  layout: ExploreLayout | null;
  mode: Mode;
  cell: number;
  world: ExploreWorld;
  /** 3D 焦点块顶面的 z 高度（px），用于把顶面投影中心对到视口中心 */
  focusTopZ: number;
}

/** 给封面加网易图床缩略参数，列表用小图，减少流量 */
function coverThumb(url: string, size: number): string {
  if (!url) return "";
  if (/[?&]param=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}param=${size}y${size}`;
}

/** 把 0..255 的平均色压暗，作为 3D 四个侧面颜色；取不到时用中性深灰 */
function sideColors(color: ExploreColor | null | undefined): {
  south: string;
  north: string;
  east: string;
  west: string;
} {
  if (!color) {
    return {
      south: "rgb(63 63 70)",
      north: "rgb(45 45 52)",
      east: "rgb(39 39 42)",
      west: "rgb(33 33 38)",
    };
  }
  const r = Math.max(0, Math.min(255, Math.round(color.r)));
  const g = Math.max(0, Math.min(255, Math.round(color.g)));
  const b = Math.max(0, Math.min(255, Math.round(color.b)));
  const shade = (k: number) =>
    `rgb(${Math.round(r * k)} ${Math.round(g * k)} ${Math.round(b * k)})`;
  return {
    south: shade(0.46),
    north: shade(0.34),
    east: shade(0.58),
    west: shade(0.4),
  };
}

const loadedCoverUrls = new Set<string>();

/**
 * 封面占位 + 120ms 淡入。
 * 块一挂载就铺 dominant 主色；已经解码过的 URL 再次挂载时直接 opacity=1，
 * 2D/3D 切换或滑条改尺寸不会重新淡入一次。
 */
function CoverArt({
  src,
  color,
}: {
  src: string;
  color: ExploreColor | null | undefined;
}) {
  const [loaded, setLoaded] = useState(() => (src ? loadedCoverUrls.has(src) : true));
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dominant = color?.dominant;
  const bg = dominant
    ? `rgb(${Math.round(dominant.r)} ${Math.round(dominant.g)} ${Math.round(dominant.b)})`
    : color
      ? `rgb(${Math.round(color.r)} ${Math.round(color.g)} ${Math.round(color.b)})`
      : "rgb(24 24 30)";

  useEffect(() => {
    if (src && loadedCoverUrls.has(src)) {
      setLoaded(true);
      return;
    }
    setLoaded(false);
    const img = imgRef.current;
    if (!img) return;
    let alive = true;
    const mark = () => {
      if (!alive) return;
      loadedCoverUrls.add(src);
      setLoaded(true);
    };
    if (img.complete && img.naturalWidth > 0) mark();
    if (typeof img.decode === "function") {
      void img.decode().then(mark).catch(mark);
    }
    return () => {
      alive = false;
    };
  }, [src]);

  return (
    <span
      data-cover
      data-cover-bg={bg}
      className="absolute inset-0 block"
      style={{ background: bg }}
    >
      {src ? (
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          loading="eager"
          decoding="async"
          onLoad={() => {
            loadedCoverUrls.add(src);
            setLoaded(true);
          }}
          onError={() => setLoaded(true)}
          className="h-full w-full object-cover"
          style={{
            opacity: loaded ? 1 : 0,
            transition: "opacity 120ms ease",
          }}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-muted-foreground">
          <Music2 className="h-1/3 w-1/3" />
        </span>
      )}
    </span>
  );
}

function immersiveTint(color: ExploreColor | null | undefined): string {
  if (!color) return "rgb(9 9 14)";
  const mix = (v: number) => Math.round(Math.min(72, Math.max(6, 8 + Number(v) * 0.18)));
  return `rgb(${mix(color.r)} ${mix(color.g)} ${mix(color.b)})`;
}

/**
 * 取完封面平均色，组成「歌曲 id -> 平均色」的显式输入。
 * 任何一张失败 / 没有封面 → null（算法侧按 0 处理）。
 * 不再限制 160 张：所有有封面的歌都取，用 12 并发避免一次打爆。
 */
async function collectCoverColors(
  tracks: Track[],
  onProgress: (done: number, total: number) => void,
): Promise<{ map: ExploreColorMap; total: number }> {
  // 按 songId 排序取色，保证同一组歌在不同歌单里拿到的颜色子集一致
  const ordered = [...tracks].sort((a, b) => a.id - b.id);
  const targets = ordered.filter((track) => Boolean(track.picUrl));
  const map: ExploreColorMap = {};
  for (const track of tracks) map[String(track.id)] = null;

  let cursor = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= targets.length) return;
      const track = targets[index];
      // 先查本地歌曲颜色表；命中不发网络，未命中才取图并写回
      const color = await coverColorForSong(track.id, track.picUrl);
      map[String(track.id)] = color ? { ...color } : null;
      done++;
      if (done === targets.length || done % 4 === 0) onProgress(done, targets.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, targets.length) }, () => worker()));
  if (targets.length === 0) onProgress(0, 0);
  else onProgress(targets.length, targets.length);
  return { map, total: targets.length };
}

export default function ExplorePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const playTrack = usePlayerStore((s) => s.playTrack);
  const lyricsOpen = useAppStore((s) => s.lyricsOpen);
  const setLyricsOpen = useAppStore((s) => s.setLyricsOpen);

  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [stageText, setStageText] = useState("正在读取歌单…");
  const [colorProgress, setColorProgress] = useState({ done: 0, total: 0 });
  const [meta, setMeta] = useState<PlaylistMeta | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [colors, setColors] = useState<ExploreColorMap>({});
  const [layout, setLayout] = useState<ExploreLayout | null>(null);
  const [mode, setMode] = useState<Mode>("2d");
  const [focusOrder, setFocusOrder] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [opening, setOpening] = useState(false);
  const [tint, setTint] = useState("rgb(9 9 14)");
  const [reloadKey, setReloadKey] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [fullscreenApi, setFullscreenApi] = useState(false);
  const [windowFullscreen, setWindowFullscreen] = useState(false);
  const [contentScale, setContentScale] = useState(1);
  const [virtualEpoch, setVirtualEpoch] = useState(0);
  const virtualBucketRef = useRef({ x: Number.NaN, y: Number.NaN });
  const viewRafRef = useRef(0);
  const lastHitOrderRef = useRef<number | null>(null);
  const [exploreStats, setExploreStats] = useState({
    fromCache: false,
    colorTotal: 0,
    colorFetched: 0,
    algorithmMs: 0,
    preferredCount: 0,
    bigCount: 0,
    songSetId: "",
  });
  const vw = viewport.width;
  const vh = viewport.height;
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const planeRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<ViewPoint>({ wx: 1, wy: 1 });
  const focusRef = useRef(0);
  /** 焦点按 songId 记忆：视口/全屏变化重算 cell 时用它把焦点找回，而不是依赖索引 */
  const focusSongIdRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const snapRafRef = useRef(0);
  const snapTimerRef = useRef(0);
  const snapTargetRef = useRef<(ViewPoint & { orderIndex: number }) | null>(null);
  const openingRef = useRef(false);
  /** 从 session 恢复的相机世界坐标；只在首次 layout effect 消费一次 */
  const initialViewRef = useRef<ViewPoint | null>(null);
  const lastFocusLayoutRef = useRef<ExploreLayout | null>(null);
  const layoutRef = useRef(layout);
  const idRef = useRef(id);
  layoutRef.current = layout;
  idRef.current = id;

  const goBack = useCallback(() => {
    if (id) navigate(`/playlist/${id}`);
    else navigate(-1);
  }, [id, navigate]);

  /* ---------------- 视口 / 全屏信号 ---------------- */

  /*
   * 画布尺寸完全由视口推导（cell = max(vw/cols, vh/rows) * 系数），
   * 所以 F11 / 浏览器全屏 / 窗口缩放时**必须重新量**。resize、ResizeObserver 与
   * fullscreen.ts 的 onFullscreenSignal 三条都接上：F11 不派发 fullscreenchange，
   * 唯一可靠信号就是窗口尺寸变化。
   */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setViewport((prev) => {
        if (Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5) {
          return prev;
        }
        return { width: rect.width, height: rect.height };
      });
    };
    measure();
    setFullscreenApi(getFullscreenElement() !== null);
    setWindowFullscreen(isWindowFullscreen());

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    const off = onFullscreenSignal(() => {
      // onFullscreenSignal 已经合并了 resize / fullscreenchange；这里再量一次，
      // 保证 cell/plane 在状态落定后的第一帧就按新视口重算。
      measure();
      setFullscreenApi(getFullscreenElement() !== null);
      setWindowFullscreen(isWindowFullscreen());
    });
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      off();
    };
  }, []);

  /* ---------------- 数据加载（与上一版一致，颜色先结算再排） ---------------- */

  useEffect(() => {
    const playlistId = Number(id);
    if (!id || !Number.isFinite(playlistId)) {
      setStatus("error");
      setError("无效的歌单 ID");
      return;
    }

    let alive = true;
    /*
     * 进入那一刻的播放器当前曲目（可能是暂停状态）——只读一次；
     * 之后 currentTrack 变化不再改变已经进入页面的焦点。
     */
    const currentAtEntry = usePlayerStore.getState().current;
    setStatus("loading");
    setError("");
    setLayout(null);
    setMeta(null);
    setTracks([]);
    setColors({});
    setFocusOrder(0);
    focusRef.current = 0;
    focusSongIdRef.current = null;
    initialViewRef.current = null;
    setColorProgress({ done: 0, total: 0 });
    setStageText("正在读取歌单…");

    void (async () => {
      try {
        const [detail, trackResult] = await Promise.all([
          netease.playlistDetail(playlistId),
          netease.playlistTracks(playlistId),
        ]);
        if (!alive) return;
        if (detail.playlist) setMeta(mapPlaylistMeta(detail.playlist));

        /*
         * /playlist/track/all 单页最多 1000 首；探索页要按页把剩下的取全，
         * 否则 >1000 首的歌单会少掉后半段。首屏仍是 1000，追加页按 trackCount 判断。
         */
        const initialSongs = trackResult.songs ?? [];
        const allSongs = await fetchRemainingPlaylistSongs(
          playlistId,
          initialSongs,
          detail.playlist?.trackCount ?? 0,
        );
        if (!alive) return;

        const list = allSongs.map(mapSongToTrack);
        setTracks(list);
        if (list.length === 0) {
          setStatus("empty");
          return;
        }

        /*
         * 2×2 只给常听/收藏：收藏全算；历史里同一首播放次数 ≥2 算常听。
         * 两者都没有候选时，算法会给全部 1×1。
         */
        let history: Awaited<ReturnType<typeof getHistory>> = [];
        let favorites: Awaited<ReturnType<typeof getFavorites>> = [];
        try {
          [history, favorites] = await Promise.all([getHistory(500), getFavorites()]);
        } catch {
          /* 本机存储不可用时按无候选处理，不影响探索页 */
        }
        const historyCount = new Map<number, number>();
        for (const item of history) {
          historyCount.set(item.songId, (historyCount.get(item.songId) ?? 0) + 1);
        }
        const preferred = new Set<number>();
        for (const item of favorites) preferred.add(item.songId);
        for (const [songId, count] of historyCount) {
          if (count >= 2) preferred.add(songId);
        }
        const preferenceFingerprint = Array.from(preferred)
          .sort((a, b) => a - b)
          .join(",");
        const songSetId = exploreSongSetId(list);

        const colorRevisionBefore = getCoverColorCacheRevision();
        const cached = readExploreCache(
          String(playlistId),
          songSetId,
          list.length,
          preferenceFingerprint,
          colorRevisionBefore,
        );

        let colorMap: ExploreColorMap;
        let nextLayout: ExploreLayout;
        let colorTotal = 0;
        let algorithmMs = 0;

        if (cached) {
          colorMap = cached.colors;
          nextLayout = cached.layout;
          colorTotal = cached.colorTotal;
          algorithmMs = 0;
          setColorProgress({ done: colorTotal, total: colorTotal });
        } else {
          setStageText("正在提取封面颜色…");
          const colorResult = await collectCoverColors(list, (done, total) => {
            if (!alive) return;
            setColorProgress({ done, total });
          });
          if (!alive) return;
          colorMap = colorResult.map;
          colorTotal = colorResult.total;

          // 颜色全部结算后才算一次布局：网络时序不会改变同一组歌的排序
          const started = performance.now();
          nextLayout = buildExploreLayout(
            playlistId,
            list.map((track) => ({
              id: track.id,
              duration: track.duration,
              artists: track.artists,
              album: track.album,
              albumId: track.albumId,
            })),
            colorMap,
            { preferredSongIds: preferred },
          );
          algorithmMs = performance.now() - started;
          if (!alive) return;
          writeExploreCache({
            playlistId: String(playlistId),
            songSetId,
            songCount: list.length,
            preferenceFingerprint,
            colorRevision: getCoverColorCacheRevision(),
            layout: nextLayout,
            colors: colorMap,
            colorTotal,
            algorithmMs,
            createdAt: Date.now(),
          });
        }
        if (!alive) return;

        setExploreStats({
          fromCache: Boolean(cached),
          colorTotal,
          colorFetched: cached ? 0 : colorTotal,
          algorithmMs,
          preferredCount: preferred.size,
          bigCount: nextLayout.placements.filter((placement) => placement.span === 2).length,
          songSetId,
        });

        /*
         * 初始焦点规则：
         *  A. 上次退出后一直待在同一页面（stillOnExitPath）→ 恢复该歌单上次的
         *     focusSongId + 相机世界坐标；
         *  B. 已离开过退出页 → 用进入那一刻的 currentTrack（暂停也算）；
         *     不在本歌单则回落到算法默认选中。
         * 位置邻近度依赖输入顺序，这里传入的 list 顺序就是当前歌单顺序。
         */
        const session = readExploreSession(String(playlistId));
        const restore =
          Boolean(session?.stillOnExitPath) && session?.focusSongId != null;
        const targetSongId = restore ? session!.focusSongId : currentAtEntry?.id ?? null;
        const targetOrder =
          targetSongId != null ? nextLayout.orderSongIds.indexOf(targetSongId) : -1;
        const fallback =
          nextLayout.placements[nextLayout.selectedOrder] ?? nextLayout.placements[0];
        const anchor = targetOrder >= 0 ? nextLayout.placements[targetOrder] : fallback;
        if (restore && targetOrder >= 0 && session?.view) {
          initialViewRef.current = { wx: session.view.wx, wy: session.view.wy };
        } else {
          initialViewRef.current = null;
        }
        if (anchor) {
          viewRef.current = {
            wx: anchor.col + anchor.span / 2,
            wy: anchor.row + anchor.span / 2,
          };
          focusRef.current = anchor.orderIndex;
          focusSongIdRef.current = nextLayout.orderSongIds[anchor.orderIndex] ?? null;
          setFocusOrder(anchor.orderIndex);
        }
        setColors(colorMap);
        setLayout(nextLayout);
        setStatus("ready");
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "加载失败");
        setStatus("error");
      }
    })();

    return () => {
      alive = false;
    };
  }, [id, reloadKey]);

  // 记录当前歌单的焦点/相机位置（供 A 恢复）；不改 exitPath / stillOnExitPath
  useEffect(() => {
    if (!layout || !id) return;
    writeExploreFocus(
      String(id),
      layout.orderSongIds[focusOrder] ?? null,
      { wx: viewRef.current.wx, wy: viewRef.current.wy },
    );
  }, [focusOrder, id, layout]);

  // 卸载时再写一次，覆盖「拖到空白/平移后没有改焦点」的最后相机位置
  useEffect(() => {
    return () => {
      const l = layoutRef.current;
      if (!l || !idRef.current) return;
      writeExploreFocus(
        String(idRef.current),
        l.orderSongIds[focusRef.current] ?? null,
        { wx: viewRef.current.wx, wy: viewRef.current.wy },
      );
    };
  }, []);

  /* ---------------- 视口 / 单位格尺寸 ---------------- */

  const cell2d = useMemo(() => {
    if (!layout || vw <= 0 || vh <= 0) return 0;
    const base = Math.max(
      vw / Math.max(1, layout.cols),
      vh / Math.max(1, layout.rows),
    );
    return Math.min(420, Math.max(48, base * CELL_2D_FILL * contentScale));
  }, [contentScale, layout, vw, vh]);
  const cell3d = useMemo(() => {
    if (!cell2d) return 0;
    return Math.min(420, Math.max(48, cell2d * CELL_3D_FACTOR));
  }, [cell2d]);
  const cell = mode === "2d" ? cell2d : cell3d;

  /**
   * 环形平铺的 3×3 份内容。世界坐标只是用来做拖动累积；
   * 相机/焦点统一落到中间那份（off = 一个内容周期），再按内容宽高 wrap。
   */
  const world = useMemo<ExploreWorld>(() => {
    if (!layout) return { w: 0, h: 0, offX: 0, offY: 0 };
    return {
      w: layout.cols * 3,
      h: layout.rows * 3,
      offX: layout.cols,
      offY: layout.rows,
    };
  }, [layout]);

  const heights = useMemo(
    () => (layout ? buildExploreHeights(layout, focusOrder) : []),
    [focusOrder, layout],
  );
  const heightByOrder = useMemo(
    () => new Map(heights.map((h) => [h.orderIndex, h])),
    [heights],
  );
  const focusTopZ = useMemo(() => {
    if (mode !== "3d" || !cell3d) return 0;
    const shape = heightByOrder.get(focusOrder);
    if (!shape) return 0;
    return cell3d * (HEIGHT_MIN_UNITS + (HEIGHT_MAX_UNITS - HEIGHT_MIN_UNITS) * shape.height);
  }, [cell3d, focusOrder, heightByOrder, mode]);

  const geomRef = useRef<ExploreGeom>({ layout, mode, cell, world, focusTopZ });
  geomRef.current = { layout, mode, cell, world, focusTopZ };

  const localView = useCallback(
    (wx: number, wy: number, _l: ExploreLayout, w: ExploreWorld): ViewPoint => ({
      wx: wrapPeriod(wx, w.w),
      wy: wrapPeriod(wy, w.h),
    }),
    [],
  );

  const nearestCopy = useCallback(
    (
      wx: number,
      wy: number,
      l: ExploreLayout,
      w: ExploreWorld,
    ): { placement: ExplorePlacement; copyX: number; copyY: number; x: number; y: number } => {
      let best = {
        placement: l.placements[0],
        copyX: 0,
        copyY: 0,
        x: w.offX + (l.placements[0]?.col ?? 0),
        y: w.offY + (l.placements[0]?.row ?? 0),
      };
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const placement of l.placements) {
        for (const copyX of COPY_OFFSETS) {
          for (const copyY of COPY_OFFSETS) {
            const x = (1 + copyX) * l.cols + placement.col + placement.span / 2;
            const y = (1 + copyY) * l.rows + placement.row + placement.span / 2;
            const dx = wx - x;
            const dy = wy - y;
            const distance = dx * dx + dy * dy;
            if (
              distance < bestDistance - 1e-12 ||
              (Math.abs(distance - bestDistance) <= 1e-12 &&
                placement.orderIndex < best.placement.orderIndex)
            ) {
              best = { placement, copyX, copyY, x, y };
              bestDistance = distance;
            }
          }
        }
      }
      return best;
    },
    [],
  );

  /**
   * 把「画布中心」的世界坐标写进 plane 的 transform。
   *
   * 2D：plane 顶左在屏幕中心 - W/2；世界点像素 = wx*cell；要让它落在屏幕中心：
   *     tx = W/2 - wx*cell。
   * 3D：plane 先绕中心 rotateX/rotateZ；一个相对中心 (dx,dy) 的点投影为
   *     u = dx·cosZ - dy·sinZ；v = dx·sinZ + dy·cosZ；屏幕 y = v·cosX。
   *     焦点块的**顶面**在 z=focusTopZ，投影后还会上移 focusTopZ·sinX；
   *     因此 ty 额外加 focusTopZ·sinX，让顶面中心而不是底面中心对到视口中心。
   *     这里绝不写 perspective。
   */
  const applyView = useCallback(() => {
    const el = planeRef.current;
    const g = geomRef.current;
    if (!el || !g.layout || g.cell <= 0) return;
    const local = localView(viewRef.current.wx, viewRef.current.wy, g.layout, g.world);
    const wx = local.wx;
    const wy = local.wy;
    const W = g.world.w * g.cell;
    const H = g.world.h * g.cell;
    if (g.mode === "2d") {
      const tx = W / 2 - wx * g.cell;
      const ty = H / 2 - wy * g.cell;
      el.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0)`;
    } else {
      const rad = Math.PI / 180;
      const tilt = CAMERA_TILT_X * rad;
      const rot = CAMERA_ROTATE_Z * rad;
      const cosX = Math.cos(tilt);
      const sinX = Math.sin(tilt);
      const cosZ = Math.cos(rot);
      const sinZ = Math.sin(rot);
      const dx = wx * g.cell - W / 2;
      const dy = wy * g.cell - H / 2;
      const u = dx * cosZ - dy * sinZ;
      const v = dx * sinZ + dy * cosZ;
      const tx = -u;
      const ty = -v * cosX + g.focusTopZ * sinX;
      el.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) rotateX(${CAMERA_TILT_X}deg) rotateZ(${CAMERA_ROTATE_Z}deg)`;
    }
    el.dataset.world = `${wx.toFixed(4)},${wy.toFixed(4)}`;
  }, []);

  /** 拖动时只改 ref，rAF 合并后写一次 transform；不触发 React 重渲染 */
  const scheduleApplyView = useCallback(() => {
    if (viewRafRef.current) return;
    viewRafRef.current = requestAnimationFrame(() => {
      viewRafRef.current = 0;
      applyView();
    });
  }, [applyView]);

  const cancelScheduledView = useCallback(() => {
    if (viewRafRef.current) {
      cancelAnimationFrame(viewRafRef.current);
      viewRafRef.current = 0;
    }
  }, []);

  useEffect(() => cancelScheduledView, [cancelScheduledView]);

  useLayoutEffect(() => {
    /*
     * 视口 / 尺寸 / 模式变化导致 unit / 世界尺寸变化时，用**songId**把焦点找回来：
     * 不依赖 focusOrder 索引；并把该曲目重新摆到屏幕中心。
     * 如果本次是「A. 恢复上次位置」，优先使用会话里保存的世界坐标（只消费一次）。
     */
    cancelScheduledView();
    const g = geomRef.current;
    const l = g.layout;
    const id = focusSongIdRef.current;
    const savedView = initialViewRef.current;
    // 模式/尺寸/视口变化不能把位置重置到规范格位；只有布局本身（歌单/候选）变化才重新定位
    const layoutChanged = l !== lastFocusLayoutRef.current;
    lastFocusLayoutRef.current = l;
    let viewChanged = false;
    if (savedView) {
      initialViewRef.current = null;
      viewRef.current = savedView;
      viewChanged = true;
    } else if (l && id != null && layoutChanged) {
      const anchor = l.placements.find((p) => l.orderSongIds[p.orderIndex] === id);
      if (anchor) {
        if (focusRef.current !== anchor.orderIndex) {
          focusRef.current = anchor.orderIndex;
          setFocusOrder(anchor.orderIndex);
        }
        viewRef.current = {
          wx: g.world.offX + anchor.col + anchor.span / 2,
          wy: g.world.offY + anchor.row + anchor.span / 2,
        };
        viewChanged = true;
      }
    }
    // 渲染窗口/选中副本都依赖 viewRef（非 state），view 变了必须重渲染一次
    if (viewChanged) setVirtualEpoch((value) => value + 1);
    applyView();
  }, [applyView, cancelScheduledView, contentScale, cell2d, cell3d, layout, mode, vw, vh, world]);

  // 焦点变化/高度变化时只更新 3D 顶面居中修正，不动正在进行的吸附轨迹
  useLayoutEffect(() => {
    applyView();
  }, [applyView, focusTopZ]);

  /**
   * 屏幕位移 → 世界位移（手指拖动画布时，画布中心的世界坐标反向移动）。
   * 3D 的屏幕 y 被相机压了 cosX，反解时先除以它，再逆旋转。
   */
  const screenDeltaToWorld = useCallback(
    (dx: number, dy: number, unit: number, m: Mode): ViewPoint => {
      if (unit <= 0) return { wx: 0, wy: 0 };
      const rad = Math.PI / 180;
      const cosX = m === "3d" ? Math.cos(CAMERA_TILT_X * rad) : 1;
      const rot = m === "3d" ? CAMERA_ROTATE_Z * rad : 0;
      const cosZ = Math.cos(rot);
      const sinZ = Math.sin(rot);
      const u = -dx / unit;
      const v = -dy / (unit * cosX);
      return { wx: u * cosZ + v * sinZ, wy: -u * sinZ + v * cosZ };
    },
    [],
  );

  /* ---------------- 吸附 / 甩动 ---------------- */

  const cancelSnap = useCallback(() => {
    if (snapRafRef.current) {
      cancelAnimationFrame(snapRafRef.current);
      snapRafRef.current = 0;
    }
    if (snapTimerRef.current) {
      window.clearTimeout(snapTimerRef.current);
      snapTimerRef.current = 0;
    }
  }, []);

  const snapTo = useCallback(
    (placement: ExplorePlacement, targetX?: number, targetY?: number) => {
      cancelSnap();
      cancelScheduledView();
      const w = geomRef.current.world;
      const l = geomRef.current.layout!;
      // 点/吸附到某个 wrap 副本时，用该副本的局部坐标，绝不回到“规范格位”
      const nearest = nearestCopy(viewRef.current.wx, viewRef.current.wy, l, w);
      const targetWx = targetX ?? nearest.x;
      const targetWy = targetY ?? nearest.y;
      const from = localView(viewRef.current.wx, viewRef.current.wy, l, w);
      viewRef.current = from;
      const target = { wx: targetWx, wy: targetWy };
      snapTargetRef.current = { ...target, orderIndex: placement.orderIndex };
      focusRef.current = placement.orderIndex;
      focusSongIdRef.current = l.orderSongIds[placement.orderIndex] ?? null;
      setFocusOrder(placement.orderIndex);
      setSnapping(true);

      const started = performance.now();
      const tick = () => {
        const t = (performance.now() - started) / SNAP_MS;
        if (t >= 1) {
          viewRef.current = target;
          snapTargetRef.current = null;
          snapRafRef.current = 0;
          applyView();
          setSnapping(false);
          return;
        }
        // 复用底栏同一套 cubic-bezier(.34,1.56,.64,1)：会越过目标约 10% 再回弹
        const p = springProgress(t);
        viewRef.current = {
          wx: from.wx + (targetWx - from.wx) * p,
          wy: from.wy + (targetWy - from.wy) * p,
        };
        applyView();
        snapRafRef.current = requestAnimationFrame(tick);
      };
      snapRafRef.current = requestAnimationFrame(tick);
      // rAF 被饿死（后台 / 无头）时的兜底：直接落到精确目标
      snapTimerRef.current = window.setTimeout(() => {
        viewRef.current = target;
        snapTargetRef.current = null;
        snapRafRef.current = 0;
        applyView();
        setSnapping(false);
      }, SNAP_MS + 180);
    },
    [applyView, cancelScheduledView, cancelSnap, localView],
  );

  /* ---------------- 进入沉浸歌词页 ---------------- */

  /**
   * 点中心：播放该曲 → 走现有 setLyricsOpen(true) 通路。
   *
   * 探索页不请求/退出全屏；setLyricsOpen(true) 会顺带抬起 lyricsUserClosed 门闩，
   * 语义与歌曲栏 / 药丸一致。探索层保持挂载并留在歌词页下面，不隐藏。
   */
  const openCenter = useCallback(() => {
    if (!layout || openingRef.current) return;
    const placement = layout.placements[focusRef.current];
    const song = placement ? tracks[layout.order[placement.orderIndex]] : null;
    if (!song) return;
    openingRef.current = true;
    setTint(immersiveTint(colors[String(song.id)]));
    setOpening(true);
    // playTrack 的同步部分会立刻把 current 设为这首歌，随后 setLyricsOpen 打开的就是它
    void playTrack(song, tracks);
    setLyricsOpen(true);
  }, [colors, layout, playTrack, setLyricsOpen, tracks]);

  /* ---------------- 指针拖动 ---------------- */

  const finishDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, allowTap: boolean) => {
      const d = dragRef.current;
      if (!d || d.id !== e.pointerId) return;
      dragRef.current = null;
      setDragging(false);
      const now = performance.now();
      const duration = now - d.startTime;
      /*
       * 有些浏览器在 touchEnd 的 pointerup 上给回按下点坐标；取「up 位移」和
       * 「最后一个 move 位移」的较大者，避免快速小幅甩动被当成 0 位移点击。
       */
      const lastSample = d.samples[d.samples.length - 1];
      const upDx = e.clientX - d.startX;
      const upDy = e.clientY - d.startY;
      const sampleDx = lastSample ? lastSample.x - d.startX : 0;
      const sampleDy = lastSample ? lastSample.y - d.startY : 0;
      const useSample = Math.hypot(sampleDx, sampleDy) > Math.hypot(upDx, upDy);
      const totalDx = useSample ? sampleDx : upDx;
      const totalDy = useSample ? sampleDy : upDy;
      const total = Math.hypot(totalDx, totalDy);
      const g = geomRef.current;
      const l = g.layout;

      // 轻点：位移≈0、时间短、无速度，才点中哪首切哪首；
      // 快速小幅甩动 / 慢速短拖都按拖动处理，绝不回到按下时那首。
      const speedLooksLikeDrag =
        total >= DRAG_SPEED_MIN_DISTANCE && d.peakSpeed > DRAG_SPEED_THRESHOLD;
      const isTap =
        allowTap &&
        !d.moved &&
        total <= TAP_MAX_MOVE &&
        !speedLooksLikeDrag &&
        duration < TAP_MAX_MS;
      if (isTap) {
        if (!l) return;
        if (d.hitOrder != null) {
          const hit = l.placements[d.hitOrder];
          if (hit) {
            if (hit.orderIndex === focusRef.current) openCenter();
            else {
              const copyX = d.hitCopyX ?? 0;
              const copyY = d.hitCopyY ?? 0;
              snapTo(
                hit,
                (1 + copyX) * l.cols + hit.col + hit.span / 2,
                (1 + copyY) * l.rows + hit.row + hit.span / 2,
              );
            }
            return;
          }
        }
        // 没命中歌曲块（例如点在 3D 焦点块的“地面”空隙）：屏幕中心小热区仍可进入
        const placement = l.placements[focusRef.current];
        const half = placement ? (placement.span * g.cell) / 2 : 0;
        const radius = Math.min(72, Math.max(40, half * 0.82));
        if (
          Math.hypot(e.clientX - vw / 2, e.clientY - vh / 2) <= radius
        ) {
          openCenter();
        }
        return;
      }

      if (!l) return;
      let vx = 0;
      let vy = 0;
      if (d.samples.length >= 2) {
        const first = d.samples[0];
        const last = d.samples[d.samples.length - 1];
        const dt = last.t - first.t;
        if (dt > 0) {
          vx = (last.x - first.x) / dt;
          vy = (last.y - first.y) / dt;
        }
      }
      /*
       * 落点规则：
       *  1) 默认以松手位置最近的格位吸附（拖动实际走到哪就落到哪）；
       *  2) 只有「甩动速度与从按下到松手的总位移同向」时才按 FLING_MS 外推，
       *     先拖后回拉（速度反向）直接忽略甩动，绝不落到拖动反方向。
       */
      const sameDirection = totalDx * vx + totalDy * vy > 0;
      const fling = sameDirection
        ? screenDeltaToWorld(vx, vy, g.cell, g.mode)
        : { wx: 0, wy: 0 };
      let projected = {
        wx: viewRef.current.wx + fling.wx * FLING_MS,
        wy: viewRef.current.wy + fling.wy * FLING_MS,
      };
      /*
       * 快速小幅甩动（位移 <8px、峰值速度大）：至少推进一格，
       * 保证落在相邻歌而不是停在原焦点；方向取总位移方向。
       */
      const fastFlick =
        total > TAP_MAX_MOVE && total <= TAP_SLOP && duration < TAP_MAX_MS;
      if (fastFlick) {
        const dir = screenDeltaToWorld(totalDx, totalDy, g.cell, g.mode);
        const mag = Math.hypot(dir.wx, dir.wy);
        if (mag > 1e-6) {
          projected = {
            wx: viewRef.current.wx + (dir.wx / mag) * 1.0,
            wy: viewRef.current.wy + (dir.wy / mag) * 1.0,
          };
        }
      }
      const local = localView(projected.wx, projected.wy, l, g.world);
      const copy = nearestCopy(local.wx, local.wy, l, g.world);
      snapTo(copy.placement, copy.x, copy.y);
    },
    [
      applyView,
      localView,
      nearestCopy,
      openCenter,
      screenDeltaToWorld,
      snapTo,
      vw,
      vh,
    ],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (openingRef.current || status !== "ready") return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      cancelSnap();
      setSnapping(false);
      const now = performance.now();
      const target = e.target as HTMLElement | null;
      const hitEl = target?.closest<HTMLElement>("[data-explore-order]");
      const parsedHit = hitEl ? Number(hitEl.getAttribute("data-explore-order")) : null;
      const parsedCopyX = hitEl ? Number(hitEl.getAttribute("data-copy-x")) : null;
      const parsedCopyY = hitEl ? Number(hitEl.getAttribute("data-copy-y")) : null;
      lastHitOrderRef.current =
        parsedHit != null && Number.isFinite(parsedHit) ? parsedHit : null;
      dragRef.current = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        startTime: now,
        lastMoveTime: now,
        peakSpeed: 0,
        moved: false,
        hitOrder: parsedHit != null && Number.isFinite(parsedHit) ? parsedHit : null,
        hitCopyX: parsedCopyX != null && Number.isFinite(parsedCopyX) ? parsedCopyX : null,
        hitCopyY: parsedCopyY != null && Number.isFinite(parsedCopyY) ? parsedCopyY : null,
        samples: [{ t: now, x: e.clientX, y: e.clientY }],
      };
      setDragging(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件 / 无效 pointerId 时忽略 */
      }
    },
    [cancelSnap, status],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d || d.id !== e.pointerId || openingRef.current) return;
      const now = performance.now();
      const total = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      const step = Math.hypot(e.clientX - d.lastX, e.clientY - d.lastY);
      const dt = Math.max(1, now - d.lastMoveTime);
      d.peakSpeed = Math.max(d.peakSpeed, step / dt);
      d.lastMoveTime = now;
      // 位移、峰值速度任一超阈值即视为拖动；相机从第一像素就跟随，不做死区
      if (
        total > TAP_SLOP ||
        (total >= DRAG_SPEED_MIN_DISTANCE && d.peakSpeed > DRAG_SPEED_THRESHOLD)
      ) {
        d.moved = true;
      }
      const g = geomRef.current;
      if (!g.layout || g.cell <= 0) return;

      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      const delta = screenDeltaToWorld(dx, dy, g.cell, g.mode);
      viewRef.current = {
        wx: viewRef.current.wx + delta.wx,
        wy: viewRef.current.wy + delta.wy,
      };
      scheduleApplyView();

      d.samples.push({ t: now, x: e.clientX, y: e.clientY });
      while (d.samples.length > 2 && now - d.samples[0].t > 120) d.samples.shift();

      const local = localView(viewRef.current.wx, viewRef.current.wy, g.layout, g.world);
      const nearest = nearestCopy(local.wx, local.wy, g.layout, g.world);
      if (nearest.placement.orderIndex !== focusRef.current) {
        focusRef.current = nearest.placement.orderIndex;
        focusSongIdRef.current = g.layout.orderSongIds[nearest.placement.orderIndex] ?? null;
        setFocusOrder(nearest.placement.orderIndex);
      }
      // 虚拟化窗口每跨过 3 个格位才触发一次重渲染（render 时不改 view）
      const bucketX = Math.floor(local.wx / 3);
      const bucketY = Math.floor(local.wy / 3);
      if (bucketX !== virtualBucketRef.current.x || bucketY !== virtualBucketRef.current.y) {
        virtualBucketRef.current = { x: bucketX, y: bucketY };
        setVirtualEpoch((value) => value + 1);
      }
    },
    [localView, nearestCopy, scheduleApplyView, screenDeltaToWorld],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => finishDrag(e, true),
    [finishDrag],
  );
  const onPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => finishDrag(e, false),
    [finishDrag],
  );

  // 歌词页关闭后，恢复探索层交互；探索层本身一直没有卸载/隐藏
  useEffect(() => {
    if (lyricsOpen) return;
    openingRef.current = false;
    setOpening(false);
  }, [lyricsOpen]);

  // 组件卸载：清掉所有定时器 / 动画 / 指针状态
  useEffect(() => {
    return () => {
      cancelSnap();
      dragRef.current = null;
    };
  }, [cancelSnap]);

  // 禁止页面滚动：探索页自己接管拖动
  useEffect(() => {
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevOverscroll = body.style.overscrollBehavior;
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    return () => {
      body.style.overflow = prevOverflow;
      body.style.overscrollBehavior = prevOverscroll;
    };
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "歌曲探索";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  /* ---------------- 派生数据 ---------------- */

  const focusSong = useMemo(() => {
    if (!layout || focusOrder < 0 || focusOrder >= layout.order.length) return null;
    return tracks[layout.order[focusOrder]] ?? null;
  }, [focusOrder, layout, tracks]);

  /** 顶部那首中心歌曲的歌手：用户在「歌曲设置」里改过就显示改后的值 */
  const displayFocusArtists = useEffectiveArtists(focusSong);

  const focusPlacement: ExplorePlacement | undefined = layout?.placements[focusOrder];

  // 开发环境调试面：验证脚本读它，生产构建不会出现
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const debug = {
      playlistId: String(id ?? ""),
      songSetId: layout?.songSetId ?? "",
      mode,
      focusOrder,
      focusSongId: layout?.orderSongIds[focusOrder] ?? null,
      currentSongId: layout?.orderSongIds[focusOrder] ?? null,
      lyricsOpen,
      layout,
      heights,
      viewport: { width: vw, height: vh },
      world: { ...world },
      contentScale,
      focusTopZ,
      exploreSessions: readAllExploreSessions(),
      exploreStats,
      cacheEntries: readAllExploreCache().length,
      renderCount: renderCountRef.current,
      virtualEpoch,
      lastHitOrder: lastHitOrderRef.current,
      lastHitSongId: layout && lastHitOrderRef.current != null
        ? layout.orderSongIds[lastHitOrderRef.current] ?? null
        : null,
      fullscreen: {
        api: getFullscreenElement() !== null,
        window: isWindowFullscreen(),
        now: isFullscreenNow(),
      },
      getView: () => ({ ...viewRef.current }),
      getWrappedView: () => {
        const g = geomRef.current;
        return g.layout ? localView(viewRef.current.wx, viewRef.current.wy, g.layout, g.world) : null;
      },
      getCell: () => geomRef.current.cell,
      getWorld: () => ({ ...geomRef.current.world }),
      getTransform: () => planeRef.current?.style.transform ?? "",
      getPhase: () => "visible",
      getOpening: () => opening,
      getFullscreen: () => ({
        api: getFullscreenElement() !== null,
        window: isWindowFullscreen(),
        now: isFullscreenNow(),
      }),
    };
    (window as unknown as Record<string, unknown>).__AURORA_EXPLORE__ = debug;
    return () => {
      delete (window as unknown as Record<string, unknown>).__AURORA_EXPLORE__;
    };
  }, [
    contentScale,
    dragging,
    exploreStats,
    focusOrder,
    focusTopZ,
    fullscreenApi,
    heights,
    id,
    layout,
    lyricsOpen,
    localView,
    mode,
    opening,
    vw,
    vh,
    virtualEpoch,
    windowFullscreen,
    world,
  ]);

  /* ---------------- 渲染 ---------------- */

  const modeSwitch = (next: Mode) => {
    // 若正在吸附，先把视点落到吸附目标，避免切换模式后中心格位偏一半
    if (snapTargetRef.current) {
      viewRef.current = {
        wx: snapTargetRef.current.wx,
        wy: snapTargetRef.current.wy,
      };
      cancelSnap();
      snapTargetRef.current = null;
      setSnapping(false);
    }
    setMode(next);
  };

  const ready = Boolean(layout && status === "ready" && vw > 0 && vh > 0);

  /*
   * 入场遮罩（z-[90]）只在「还没有任何可显示内容」时不透明：
   *  - loading：保持主题渐变底，加载提示与进度浮在它上面（见下面 z-[95] 的加载层）
   *  - ready：等布局算完，双 rAF 之后才淡出，避免先闪一帧空画布
   *  - empty / error：没有画布可等，直接淡出 —— 否则提示卡片和返回键会被遮罩挡死
   */
  const [entryOpen, setEntryOpen] = useState(false);
  useEffect(() => {
    if (entryOpen) return;
    if (status === "empty" || status === "error") {
      setEntryOpen(true);
      return;
    }
    if (!ready) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntryOpen(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [ready, entryOpen, status]);

  /*
   * 加载层：状态离开 loading 后再多留 200ms 做淡出，
   * 否则加载动画会凭空消失，和遮罩淡出叠在一起显得突兀。
   */
  const [loadingLayerLive, setLoadingLayerLive] = useState(true);
  useEffect(() => {
    if (status === "loading") {
      setLoadingLayerLive(true);
      return;
    }
    const timer = window.setTimeout(() => setLoadingLayerLive(false), 200);
    return () => window.clearTimeout(timer);
  }, [status]);
  const colorPct =
    colorProgress.total > 0
      ? Math.round((colorProgress.done / colorProgress.total) * 100)
      : 0;

  const renderPlane = () => {
    if (!layout || !ready) return null;
    const unit = mode === "2d" ? cell2d : cell3d;
    if (!unit) return null;
    const W = world.w * unit;
    const H = world.h * unit;
    const gap = 0; // 环形平铺时块与块紧贴，任何屏幕位置都由封面覆盖
    const animate = layout.order.length <= 220;
    // 虚拟化：只渲染视口 + 一圈缓冲内的副本/格位
    const g = geomRef.current;
    const local = g.layout
      ? localView(viewRef.current.wx, viewRef.current.wy, g.layout, g.world)
      : { wx: world.offX, wy: world.offY };
    // 相对平铺：3×3 份副本永远围绕相机重排，而不是把相机归一化到规范格位。
    // 跨 wrap 时 blocks 与 plane transform 同步平移，屏幕内容连续、视觉不跳切。
    const copyShiftX = Math.floor(local.wx / layout.cols);
    const copyShiftY = Math.floor(local.wy / layout.rows);
    const shiftX = copyShiftX * layout.cols;
    const shiftY = copyShiftY * layout.rows;
    const halfW = vw / (2 * unit);
    const halfH = vh / (2 * unit);
    const reach =
      mode === "3d"
        ? Math.hypot(vw, vh) / (2 * unit) + 8
        : Math.max(halfW, halfH) + 8;
    const minX = local.wx - (mode === "3d" ? reach : halfW + 8);
    const maxX = local.wx + (mode === "3d" ? reach : halfW + 8);
    const minY = local.wy - (mode === "3d" ? reach : halfH + 8);
    const maxY = local.wy + (mode === "3d" ? reach : halfH + 8);
    const isVisibleBlock = (copyX: number, copyY: number, p: ExplorePlacement): boolean => {
      const x = (1 + copyX) * layout.cols + p.col - shiftX;
      const y = (1 + copyY) * layout.rows + p.row - shiftY;
      return x + p.span >= minX && x <= maxX && y + p.span >= minY && y <= maxY;
    };

    const focusPlacement = layout.placements.find((p) => p.orderIndex === focusOrder);
    // 吸附中优先用吸附目标，保证高亮落在被点的副本上（而不是最近但不同的副本）
    const snapAim = snapTargetRef.current;
    const aim =
      snapAim && snapAim.orderIndex === focusOrder
        ? { wx: snapAim.wx, wy: snapAim.wy }
        : local;
    let focusCopyX = 0;
    let focusCopyY = 0;
    if (focusPlacement) {
      let best = Number.POSITIVE_INFINITY;
      for (const cx of COPY_OFFSETS) {
        for (const cy of COPY_OFFSETS) {
          const fx = (1 + cx) * layout.cols + focusPlacement.col + focusPlacement.span / 2;
          const fy = (1 + cy) * layout.rows + focusPlacement.row + focusPlacement.span / 2;
          const distance = (aim.wx - fx) ** 2 + (aim.wy - fy) ** 2;
          if (distance < best) {
            best = distance;
            focusCopyX = cx;
            focusCopyY = cy;
          }
        }
      }
    }
    return (
      <div
        ref={planeRef}
        className="explore-plane absolute left-1/2 top-1/2"
        data-explore-plane
        data-explore-mode={mode}
        data-world-size={`${world.w.toFixed(3)}x${world.h.toFixed(3)}`}
        style={{
          width: W,
          height: H,
          marginLeft: -W / 2,
          marginTop: -H / 2,
          transformStyle: "preserve-3d",
          transformOrigin: "50% 50%",
          willChange: "transform",
          // 大平面上的格线背景：内容之外也能看出自己在平面上移动
          // 平面底色与主题一致，3D 投影缝隙也只会看到深色而不是灰块
          backgroundColor: "#09090e",
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: `${unit}px ${unit}px`,
          backgroundPosition: "0 0",
          // 不设 perspective：平行投影
          perspective: "none",
        }}
      >
        {/* 3×3 份内容副本：任意拖多远、屏幕任意位置都由相邻副本补上歌曲 */}
        {COPY_OFFSETS.flatMap((copyX) =>
          COPY_OFFSETS.map((copyY) =>
            layout.placements
              .filter(
                (p) =>
                  isVisibleBlock(copyX, copyY, p) ||
                  (copyX === focusCopyX && copyY === focusCopyY && p.orderIndex === focusOrder),
              )
              .map((p) => {
          const song = tracks[layout.order[p.orderIndex]];
          const selected =
            copyX === focusCopyX && copyY === focusCopyY && p.orderIndex === focusOrder;
          const big = p.span === 2;
          const left = ((1 + copyX) * layout.cols + p.col - shiftX) * unit + gap / 2;
          const top = ((1 + copyY) * layout.rows + p.row - shiftY) * unit + gap / 2;
          const size = p.span * unit - gap;
          const side = sideColors(colors[String(song?.id ?? "")]);
          const blockKey = `${copyX}:${copyY}:${p.orderIndex}`;

          const shape = heightByOrder.get(p.orderIndex);
          const heightUnits = shape
            ? HEIGHT_MIN_UNITS + (HEIGHT_MAX_UNITS - HEIGHT_MIN_UNITS) * shape.height
            : HEIGHT_MIN_UNITS;
          const heightPx = unit * heightUnits;
          const is2d = mode === "2d";
          // 小尺寸/远处块不画侧面：只保留选中块与焦点附近，保证立体感又不拖慢
          const showSides = !is2d && (selected || (shape?.distance ?? 99) <= 2.2);
          const transition = animate
            ? "transform 360ms cubic-bezier(0.2,0.7,0.2,1), height 360ms cubic-bezier(0.2,0.7,0.2,1), width 360ms cubic-bezier(0.2,0.7,0.2,1), filter 280ms ease, box-shadow 280ms ease, border-color 280ms ease"
            : undefined;

          return (
            <div
              key={blockKey}
              data-block-key={blockKey}
              data-explore-order={p.orderIndex}
              data-copy-x={copyX}
              data-copy-y={copyY}
              data-song-id={song?.id ?? ""}
              data-col={p.col}
              data-row={p.row}
              data-span={p.span}
              data-selected={selected ? "true" : "false"}
              data-height={heightPx.toFixed(2)}
              data-height-unit={heightUnits.toFixed(4)}
              data-distance={shape?.distance.toFixed(3) ?? ""}
              className={cn(
                "absolute",
                is2d
                  ? cn(
                      "explore-2d-block overflow-hidden border bg-muted",
                      selected
                        ? "z-30 border-white/90 shadow-[0_0_0_1px_rgba(255,255,255,0.55),0_0_26px_7px_rgba(167,139,250,0.28)] brightness-105"
                        : "border-white/12",
                    )
                  : "explore-block",
              )}
              style={
                is2d
                  ? {
                      left,
                      top,
                      width: size,
                      height: size,
                      transform: selected ? "scale(1.07)" : undefined,
                      transformOrigin: "center center",
                      transition: selected && animate
                        ? "transform 300ms cubic-bezier(0.22,1,0.36,1), filter 300ms ease, box-shadow 300ms ease, border-color 300ms ease"
                        : undefined,
                    }
                  : {
                      left,
                      top,
                      width: size,
                      height: size,
                      transformStyle: "preserve-3d",
                    }
              }
            >
              {showSides && (
                <>
              <span
                data-face="south"
                data-side-height={heightPx.toFixed(2)}
                data-side-height-unit={heightUnits.toFixed(4)}
                className="explore-block-side absolute left-0 right-0"
                style={{
                  top: "100%",
                  height: heightPx,
                  transformOrigin: "top center",
                  transform: "rotateX(90deg)",
                  background: side.south,
                  backgroundImage:
                    "linear-gradient(to bottom, rgba(255,255,255,0.10), rgba(0,0,0,0.28))",
                  backfaceVisibility: "hidden",
                  transition: selected ? transition : undefined,
                  pointerEvents: "none",
                }}
              />
              <span
                data-face="east"
                data-side-height={heightPx.toFixed(2)}
                data-side-height-unit={heightUnits.toFixed(4)}
                className="explore-block-side absolute top-0"
                style={{
                  left: "100%",
                  width: heightPx,
                  height: "100%",
                  transformOrigin: "left center",
                  transform: "rotateY(-90deg)",
                  background: side.east,
                  backgroundImage:
                    "linear-gradient(to right, rgba(255,255,255,0.08), rgba(0,0,0,0.24))",
                  backfaceVisibility: "hidden",
                  transition: selected ? transition : undefined,
                  pointerEvents: "none",
                }}
              />
                </>
              )}
              <span
                key="top"
                data-face="top"
                data-selected={selected ? "true" : "false"}
                className={cn(
                  "absolute inset-0 block overflow-hidden",
                  !is2d && "explore-block-top border bg-muted",
                  !is2d &&
                    (selected
                      ? "z-10 border-white/95 shadow-[0_0_0_2px_rgba(255,255,255,0.85),0_0_34px_9px_rgba(139,92,246,0.55)] brightness-[1.15] saturate-[1.1]"
                      : "border-white/20"),
                )}
                style={
                  is2d
                    ? undefined
                    : {
                        transform: `translateZ(${heightPx}px)`,
                        transition: selected ? transition : undefined,
                      }
                }
              >
                <CoverArt
                  src={song?.picUrl ? coverThumb(song.picUrl, big ? 220 : 160) : ""}
                  color={song ? colors[String(song.id)] : null}
                />
                <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-black/0 to-black/0" />
                {big && (
                  <span className="pointer-events-none absolute inset-x-2 bottom-1.5 line-clamp-1 text-[10px] font-medium text-white drop-shadow">
                    {song?.name}
                  </span>
                )}
                {selected && (
                  <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-white/95 text-black shadow-lg">
                    <Play className="h-3.5 w-3.5 fill-current" />
                  </span>
                )}
              </span>
            </div>
          );
        }),
          ),
        )}
        {mode === "2d" && (
          <div
            className="pointer-events-none absolute inset-0 z-20 bg-black/[0.14]"
            data-explore-dim
            aria-hidden
          />
        )}
      </div>
    );
  };

  const shell = (
    <div
      ref={rootRef}
      className={cn(
        "explore-root fixed inset-0 z-[35] select-none overflow-hidden touch-none",
        opening && "explore-opening",
        dragging && "explore-dragging",
      )}
      data-explore-root
      data-phase="visible"
      data-opening={opening ? "true" : "false"}
      data-explore-mode={mode}
      data-focus-order={focusOrder}
      data-snapping={snapping ? "true" : "false"}
      data-content-scale={contentScale.toFixed(2)}
      data-fullscreen-api={fullscreenApi ? "true" : "false"}
      data-window-fullscreen={windowFullscreen ? "true" : "false"}
    >
      <div
        className="explore-root-bg pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 0%, hsl(263 55% 19% / 0.9), transparent 62%), radial-gradient(90% 90% at 82% 100%, hsl(190 60% 17% / 0.55), transparent 68%)",
        }}
      />
      {/* 进入歌词页时，这层背景色过渡到该曲封面主色的深色版本 */}
      <div
        data-explore-tint
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundColor: tint,
          opacity: opening ? 1 : 0,
          transition: `opacity ${OPEN_TINT_MS}ms ease`,
        }}
      />

      {ready && (
        <div
          className="absolute inset-0 z-[1] overflow-hidden touch-none"
          data-explore-canvas
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={(e) => {
            // 捕获意外丢失时不要卡在“拖拽中”：按当前位置吸附，不当作点击
            if (dragRef.current) finishDrag(e, false);
          }}
        >
          {renderPlane()}
        </div>
      )}

      {/* 顶部浮层：绝对定位，不占画布空间 */}
      <header
        className="pointer-events-none absolute inset-x-0 top-0 z-30 px-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 10px)" }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goBack}
            disabled={opening}
            aria-label="返回歌单"
            className={cn(
              "pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white shadow-lg backdrop-blur-md transition-transform active:scale-95",
              opening && "pointer-events-none opacity-40",
            )}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 backdrop-blur-md">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-300" />
            <h1 className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-white">歌曲探索</h1>
            <span className="min-w-0 truncate text-[10px] text-white/50">
              {meta?.name ?? "歌单"} · {tracks.length} 首
            </span>
          </div>

          {status === "ready" && (
            <div
              className="pointer-events-auto flex shrink-0 items-center rounded-full border border-white/15 bg-black/35 p-0.5 shadow-lg backdrop-blur-md"
              role="group"
              aria-label="显示模式"
            >
              <button
                type="button"
                onClick={() => modeSwitch("2d")}
                disabled={opening}
                aria-pressed={mode === "2d"}
                aria-label="二维模式"
                className={cn(
                  "flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                  mode === "2d" ? "bg-white/90 text-black shadow" : "text-white/65",
                  opening && "pointer-events-none opacity-40",
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                二维
              </button>
              <button
                type="button"
                onClick={() => modeSwitch("3d")}
                disabled={opening}
                aria-pressed={mode === "3d"}
                aria-label="三维模式"
                className={cn(
                  "flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                  mode === "3d" ? "bg-white/90 text-black shadow" : "text-white/65",
                  opening && "pointer-events-none opacity-40",
                )}
              >
                <Box className="h-3.5 w-3.5" />
                三维
              </button>
            </div>
          )}
          {status === "ready" && (
            <label
              className={cn(
                "pointer-events-auto flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-black/35 px-2 text-[9px] text-white/55 shadow-lg backdrop-blur-md",
                opening && "pointer-events-none opacity-40",
              )}
              title="内容显示大小（只改变内容 cell，不改变浏览器缩放）"
            >
              尺寸
              <input
                type="range"
                min={CONTENT_SCALE_MIN}
                max={CONTENT_SCALE_MAX}
                step={CONTENT_SCALE_STEP}
                value={contentScale}
                disabled={opening}
                onChange={(event) => setContentScale(Number(event.target.value))}
                aria-label="内容显示大小"
                data-content-size={contentScale.toFixed(2)}
                className="h-1 w-14 cursor-pointer accent-violet-300"
              />
              <span className="w-8 text-right tabular-nums text-white/75">
                {contentScale.toFixed(2)}×
              </span>
            </label>
          )}
        </div>

        {status === "ready" && focusSong && (
          <div
            className="pointer-events-auto mt-2 flex items-center gap-2.5 rounded-2xl border border-white/12 bg-black/35 p-2 shadow-xl backdrop-blur-md"
            data-now-song-id={focusSong.id}
            data-now-order={focusOrder}
            aria-live="polite"
          >
            <div className="h-12 w-12 shrink-0 overflow-hidden bg-muted">
              {focusSong.picUrl ? (
                <img
                  src={coverThumb(focusSong.picUrl, 160)}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-muted-foreground">
                  <Music2 className="h-5 w-5" />
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-tight text-white" title={focusSong.name}>
                {focusSong.name}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-white/60">
                {displayFocusArtists}
                {focusSong.album ? ` · ${focusSong.album}` : ""}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-white/40">
                <span>中心歌曲</span>
                <span aria-hidden>·</span>
                <span>{formatTime(focusSong.duration)}</span>
                <span aria-hidden>·</span>
                <span>{focusPlacement?.span === 2 ? "2×2" : "1×1"}</span>
              </div>
            </div>
            <span className="mr-1 hidden shrink-0 items-center gap-1 text-[9px] text-white/45 sm:flex">
              <Play className="h-3 w-3" />
              点中心进入
            </span>
          </div>
        )}
      </header>

      {/* 底部提示 / 过渡期状态 */}
      {status === "ready" && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 text-center text-[10px] text-white/45"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)" }}
        >
          <span className="pointer-events-auto rounded-full border border-white/10 bg-black/25 px-3 py-1 backdrop-blur-sm">
            拖动 / 甩动切换中心歌曲 · 点任意歌曲切换焦点 · 再点中心进入沉浸歌词
          </span>
        </div>
      )}

      {loadingLayerLive && (
        <div
          aria-live="polite"
          aria-busy={status === "loading"}
          className={cn(
            "pointer-events-none absolute inset-0 z-[95] flex flex-col items-center justify-center gap-4 px-8 text-center transition-opacity duration-200",
            status === "loading" ? "opacity-100" : "opacity-0",
          )}
        >
          <Loader2 className="h-7 w-7 animate-spin text-white/70" />
          <div className="text-sm text-white/80">{stageText}</div>
          {colorProgress.total > 0 && (
            <div className="w-48">
              <div className="h-1 overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full rounded-full bg-white/70 transition-[width] duration-300"
                  style={{ width: `${colorPct}%` }}
                />
              </div>
              <div className="mt-1.5 text-[10px] tabular-nums text-white/45">
                {colorProgress.done} / {colorProgress.total} 张封面
              </div>
            </div>
          )}
        </div>
      )}

      {status === "empty" && (
        <div className="absolute inset-0 z-20 flex items-center justify-center px-6">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-3xl border border-white/10 bg-card/70 px-6 py-10 text-center shadow-2xl backdrop-blur-xl">
            <Compass className="h-10 w-10 text-white/50" />
            <p className="text-sm font-semibold">这个歌单还没有歌曲</p>
            <p className="text-xs leading-relaxed text-white/55">
              先往歌单里添加几首歌，再回来探索它们的排列吧。
            </p>
            <Button size="sm" variant="outline" onClick={goBack} className="mt-1">
              <ArrowLeft className="h-3.5 w-3.5" />
              返回歌单
            </Button>
          </div>
        </div>
      )}

      {status === "error" && (
        <div className="absolute inset-0 z-20 flex items-center justify-center px-6">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-3xl border border-white/10 bg-card/70 px-6 py-10 text-center shadow-2xl backdrop-blur-xl">
            <Compass className="h-10 w-10 text-white/50" />
            <p className="text-sm font-semibold">歌单加载失败</p>
            <p className="text-xs leading-relaxed text-white/55">
              {error || "未知错误"}。请确认本机网易云代理已启动，或稍后再试。
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                <RefreshCw className="h-3.5 w-3.5" />
                重试
              </Button>
              <Button size="sm" variant="outline" onClick={goBack}>
                <ArrowLeft className="h-3.5 w-3.5" />
                返回歌单
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 首次进入/二次进入：先铺与主题一致的纯色底，布局就绪后 180ms 一次性淡入，绝不先闪白 */}
      <div
        data-explore-entry-veil
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[90]"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 0%, hsl(263 45% 13%), #09090e 62%, #06060a)",
          opacity: entryOpen ? 0 : 1,
          transition: "opacity 180ms ease",
        }}
      />

      {/* 进入歌词页时探索层整体缩放 + 模糊；transition 由 CSS 的 .explore-opening 承担 */}
      <style>{`
        .explore-root {
          height: 100vh;
          height: 100dvh;
          background: #08080c;
          transition: transform ${OPEN_MOVE_MS}ms cubic-bezier(0.22,1,0.36,1), filter ${OPEN_MOVE_MS}ms cubic-bezier(0.22,1,0.36,1);
          transform-origin: center center;
          will-change: transform;
        }
        .explore-root.explore-opening {
          transform: scale(1.12);
          filter: blur(14px) brightness(0.72);
        }
      `}</style>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(shell, document.body) : null;
}
