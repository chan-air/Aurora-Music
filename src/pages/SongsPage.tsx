import { Link } from "react-router-dom";
import { Heart, History, ListMusic, type LucideIcon } from "lucide-react";

/**
 * 「歌曲」页：底栏的第二项。
 *
 * 它本身不放列表，只是三个入口小卡片 ——
 *   我的收藏（/favorites）、播放历史（/history）、歌曲设置（/song-settings）。
 * 也就是说这三个页面从底栏「下沉」到了这一层，底栏才能精简成 4 项。
 */
interface SongEntry {
  to: string;
  label: string;
  desc: string;
  icon: LucideIcon;
}

const ENTRIES: SongEntry[] = [
  { to: "/favorites", label: "我的收藏", desc: "收藏的歌曲、歌单与歌手", icon: Heart },
  { to: "/history", label: "播放历史", desc: "最近播放过的歌曲", icon: History },
  { to: "/song-settings", label: "歌曲设置", desc: "逐首歌词 / 纯音乐标记 / 本地音频", icon: ListMusic },
];

export default function SongsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6">
      <h2 className="text-2xl font-bold">歌曲</h2>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {ENTRIES.map(({ to, label, desc, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group flex items-center gap-3 rounded-xl border bg-card p-4 shadow transition-colors hover:bg-accent"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{label}</span>
              <span className="block truncate text-xs text-muted-foreground">{desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
