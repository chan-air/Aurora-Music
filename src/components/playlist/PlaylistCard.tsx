import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import type { NeteasePlaylist } from "@/types/netease";
import { formatCount } from "@/lib/format";
import FavoriteButton from "@/components/common/FavoriteButton";

export default function PlaylistCard({ playlist }: { playlist: NeteasePlaylist }) {
  const subtitle = `${playlist.trackCount ?? 0} 首${
    playlist.creator?.nickname ? ` · by ${playlist.creator.nickname}` : ""
  }`;

  return (
    <Link
      to={`/playlist/${playlist.id}`}
      className="group rounded-lg p-3 transition-colors hover:bg-accent/50"
    >
      <div className="relative aspect-square overflow-hidden rounded-lg bg-muted">
        {playlist.coverImgUrl && (
          <img
            src={playlist.coverImgUrl}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
            alt={playlist.name}
          />
        )}
        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">
          <Play className="h-3 w-3 fill-current" />
          {formatCount(playlist.playCount)}
        </div>
        <FavoriteButton
          type="playlist"
          id={playlist.id}
          name={playlist.name}
          subtitle={subtitle}
          picUrl={playlist.coverImgUrl ?? ""}
          className="absolute right-1.5 top-1.5"
        />
      </div>
      <div className="mt-2 line-clamp-2 text-sm font-medium">{playlist.name}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
    </Link>
  );
}
