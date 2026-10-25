import { useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  Heart,
  Mic2,
  Loader2,
} from "lucide-react";
import { usePlayerStore, getPlaybackPosition } from "@/stores/playerStore";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { requestFullscreen } from "@/lib/fullscreen";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { addFavorite, removeFavorite, isFavorite } from "@/lib/storage";
import { useEffectiveArtists } from "@/lib/artistOverrides";

export default function PlayerBar() {
  const current = usePlayerStore((s) => s.current);
  const playing = usePlayerStore((s) => s.playing);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const loading = usePlayerStore((s) => s.loading);
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const seek = usePlayerStore((s) => s.seek);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setLyricsOpen = useAppStore((s) => s.setLyricsOpen);
  const fullscreenOnLyrics = useSettingsStore((s) => s.fullscreenOnLyrics);

  const [progress, setProgress] = useState(0);
  const [fav, setFav] = useState(false);
  /** 歌手：用户在「歌曲设置」里改过就显示改后的值 */
  const displayArtists = useEffectiveArtists(current);
  /** 正在拖动进度条：暂停定时回写，避免和手指抢 */
  const seekingRef = useRef(false);

  useEffect(() => {
    if (!current) return;
    let on = true;
    isFavorite(current.id).then((v) => on && setFav(v));
    return () => {
      on = false;
    };
  }, [current?.id]);

  useEffect(() => {
    const id = setInterval(() => {
      // 拖动进度条期间不要回写，否则会和手指抢
      if (seekingRef.current) return;
      /*
       * 用播放器统一的取位置接口而不是 h.seek()：它会在「松手搜索后、音频还没追上」
       * 的过渡期内报告目标值，否则会先跳回原处再跳到目标（来回跳一下）。
       */
      setProgress(getPlaybackPosition());
    }, 250);
    return () => clearInterval(id);
  }, []);

  if (!current) return null;

  const toggleFav = async () => {
    if (fav) {
      await removeFavorite(current.id);
      setFav(false);
    } else {
      await addFavorite(current);
      setFav(true);
    }
  };

  const openLyrics = () => {
    setLyricsOpen(true);
    if (fullscreenOnLyrics) requestFullscreen();
  };

  return (
    <div className="flex items-center gap-3 border-t bg-background/95 px-3 py-2 backdrop-blur">
      {/* 歌曲信息 */}
      <div className="flex w-[30%] min-w-0 items-center gap-3">
        <button
          onClick={openLyrics}
          title="打开全屏歌词"
          className="group/cover relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-muted transition-transform hover:scale-105"
        >
          {current.picUrl && (
            <img src={current.picUrl} className="h-full w-full object-cover" alt="" />
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover/cover:opacity-100">
            <Mic2 className="h-5 w-5 text-white" />
          </span>
        </button>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{current.name}</div>
          <div className="truncate text-xs text-muted-foreground">{displayArtists}</div>
        </div>
        <Button variant="ghost" size="icon" className="shrink-0" onClick={toggleFav}>
          <Heart className={cn("h-4 w-4", fav && "fill-red-500 text-red-500")} />
        </Button>
      </div>

      {/* 控制区 */}
      <div className="flex flex-1 flex-col items-center gap-1">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={prev}>
            <SkipBack className="h-5 w-5" />
          </Button>
          <Button size="icon" className="h-10 w-10 rounded-full" onClick={toggle}>
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : playing ? (
              <Pause className="h-5 w-5" />
            ) : (
              <Play className="h-5 w-5" />
            )}
          </Button>
          <Button variant="ghost" size="icon" onClick={next}>
            <SkipForward className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex w-full max-w-lg items-center gap-2">
          <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
            {formatTime(progress)}
          </span>
          <Slider
            value={[progress]}
            max={Math.max(duration, 1)}
            step={1}
            // 拖动时只更新显示，松手才真正跳转
            onValueChange={([v]) => {
              seekingRef.current = true;
              setProgress(v);
            }}
            onValueCommit={([v]) => {
              seekingRef.current = false;
              seek(v);
            }}
            className="flex-1"
          />
          <span className="w-10 text-xs tabular-nums text-muted-foreground">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* 音量 / 歌词 */}
      <div className="hidden w-[30%] items-center justify-end gap-2 sm:flex">
        <Volume2 className="h-4 w-4 text-muted-foreground" />
        <Slider
          value={[Math.round(volume * 100)]}
          max={100}
          step={1}
          onValueChange={([v]) => setVolume(v / 100)}
          className="w-24"
        />
        <Button variant="ghost" size="icon" onClick={openLyrics}>
          <Mic2 className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
