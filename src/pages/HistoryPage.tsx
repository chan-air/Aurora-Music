import { useEffect, useState } from "react";
import { History, Trash2 } from "lucide-react";
import { getHistory, clearHistory, type SavedSong } from "@/lib/storage";
import type { Track } from "@/lib/mappers";
import SongRow from "@/components/playlist/SongRow";
import { Button } from "@/components/ui/button";

function toTrack(s: SavedSong): Track {
  return {
    id: s.songId,
    name: s.name,
    artists: s.artists,
    album: s.album,
    picUrl: s.picUrl,
    duration: s.duration,
  };
}

function timeStr(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function HistoryPage() {
  const [songs, setSongs] = useState<SavedSong[]>([]);

  useEffect(() => {
    void getHistory().then(setSongs);
  }, []);

  const tracks = songs.map(toTrack);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">播放历史</h2>
        {songs.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await clearHistory();
              setSongs([]);
            }}
          >
            <Trash2 className="h-4 w-4" /> 清空
          </Button>
        )}
      </div>

      {tracks.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
          <History className="h-10 w-10 opacity-40" />
          <p className="text-sm">暂无播放记录</p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {tracks.map((t, i) => (
            <SongRow
              key={`${t.id}-${i}`}
              track={t}
              index={i}
              rightText={timeStr(songs[i]?.playedAt)}
              list={tracks}
            />
          ))}
        </div>
      )}
    </div>
  );
}
