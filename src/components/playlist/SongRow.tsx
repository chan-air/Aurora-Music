import { useEffect, useRef, useState } from "react";
import { Heart, Volume2 } from "lucide-react";
import type { Track } from "@/lib/mappers";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/playerStore";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { addFavorite, removeFavorite, isFavorite } from "@/lib/storage";
import { useEffectiveArtists } from "@/lib/artistOverrides";

interface SongRowProps {
  track: Track;
  index?: number;
  showAlbum?: boolean;
  /** 自定义右侧文本（如听歌次数 / 播放时间） */
  rightText?: string;
  /** 当前列表（用于「替换队列」双击行为） */
  list?: Track[];
}

export default function SongRow({
  track,
  index,
  showAlbum = true,
  rightText,
  list,
}: SongRowProps) {
  const current = usePlayerStore((s) => s.current);
  const playing = usePlayerStore((s) => s.playing);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const playNext = usePlayerStore((s) => s.playNext);
  const appendToQueue = usePlayerStore((s) => s.appendToQueue);
  const selectedId = useAppStore((s) => s.selectedId);
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const doubleClickAction = useSettingsStore((s) => s.doubleClickAction);
  /** 触屏设备：单击歌曲即播放 */
  const touch = useSettingsStore((s) => s.touch);
  const [fav, setFav] = useState(false);
  /** 按下反馈：略微变深 + 略微变小 */
  const [pressed, setPressed] = useState(false);
  /** 歌手：用户在「歌曲设置」里改过就显示改后的值 */
  const displayArtists = useEffectiveArtists(track);

  /** 触屏下单次点击的时间戳，用于忽略紧接着的第二下 */
  const lastPlayRef = useRef(0);
  const suppressDblClickRef = useRef(false);

  const active = current?.id === track.id;
  const selected = selectedId === track.id;

  useEffect(() => {
    let on = true;
    isFavorite(track.id).then((v) => on && setFav(v));
    return () => {
      on = false;
    };
  }, [track.id]);

  const runSongAction = () => {
    if (doubleClickAction === "next") {
      void playNext(track);
    } else if (doubleClickAction === "append") {
      void appendToQueue(track);
    } else {
      void playTrack(track, list && list.length ? list : [track]);
    }
  };

  const handleClick = () => {
    setSelectedId(track.id);
    if (!touch) return;
    // 触屏：单击就播放；迅速连点两下时忽略第二下，避免重复入队
    const now = Date.now();
    if (now - lastPlayRef.current < 400) return;
    lastPlayRef.current = now;
    runSongAction();
  };

  const handleDoubleClick = () => {
    if (touch) return; // 触屏已由单击处理
    if (suppressDblClickRef.current) {
      suppressDblClickRef.current = false;
      return;
    }
    runSongAction();
  };

  const handlePointerDown = () => {
    setPressed(true);
  };

  const handlePointerUp = () => {
    setPressed(false);
  };

  const toggleFav = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (fav) {
      await removeFavorite(track.id);
      setFav(false);
    } else {
      await addFavorite(track);
      setFav(true);
    }
    window.dispatchEvent(new Event("favorites-changed"));
  };

  return (
    <div
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerUp}
      data-song-id={track.id}
      data-song-index={index}
      className={cn(
        // touch-manipulation：关掉双击缩放
        "group flex cursor-pointer touch-manipulation items-center gap-3 rounded-lg px-3 py-2",
        "transition-[background-color,transform]",
        active ? "bg-primary/15" : selected ? "bg-accent/60" : "hover:bg-accent/40",
        // 按下：略微变深 + 略微变小（放在最后，靠 tailwind-merge 覆盖上面的底色）
        pressed && "scale-[0.98] bg-black/25",
      )}
      style={{
        transitionTimingFunction: pressed ? "ease-out" : "cubic-bezier(0.22, 1, 0.36, 1)",
        transitionDuration: pressed ? "75ms" : "180ms",
      }}
    >
      <div className="flex w-8 shrink-0 justify-center text-sm tabular-nums text-muted-foreground">
        {active && playing ? (
          <Volume2 className="h-4 w-4 animate-pulse text-primary" />
        ) : (
          <span>{index != null ? index + 1 : "♪"}</span>
        )}
      </div>

      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted">
        {track.picUrl && (
          <img src={track.picUrl} className="h-full w-full object-cover" loading="lazy" alt="" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm font-medium", active && "text-primary")}>
          {track.name}
        </div>
        <div className="truncate text-xs text-muted-foreground">{displayArtists}</div>
      </div>

      {showAlbum && (
        <div className="hidden w-44 truncate text-xs text-muted-foreground sm:block">
          {track.album}
        </div>
      )}

      {rightText && (
        <div className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {rightText}
        </div>
      )}

      <div className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatDuration(track.duration)}
      </div>

      <button
        onClick={toggleFav}
        className="shrink-0 rounded-md p-1.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
        aria-label="收藏"
      >
        <Heart className={cn("h-4 w-4", fav && "fill-red-500 text-red-500")} />
      </button>
    </div>
  );
}
