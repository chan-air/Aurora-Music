import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import FavoriteButton from "./FavoriteButton";
import type { FavoriteType } from "@/lib/storage";

interface MediaCardProps {
  type: FavoriteType;
  id: number;
  name: string;
  subtitle?: string;
  picUrl?: string;
  href?: string;
}

/** 通用媒体卡片：歌手 / 用户（圆形头像）、专辑 / 歌单（方形封面），带收藏按钮 */
export default function MediaCard({
  type,
  id,
  name,
  subtitle = "",
  picUrl = "",
  href,
}: MediaCardProps) {
  const round = type === "artist" || type === "user";

  const inner = (
    <>
      <div
        className={cn(
          "relative aspect-square overflow-hidden bg-muted",
          round ? "rounded-full" : "rounded-lg",
        )}
      >
        {picUrl && (
          <img src={picUrl} className="h-full w-full object-cover" alt="" loading="lazy" />
        )}
        <FavoriteButton
          type={type}
          id={id}
          name={name}
          subtitle={subtitle}
          picUrl={picUrl}
          className="absolute right-2 top-2"
        />
      </div>
      <div className="mt-2 line-clamp-1 text-center text-sm font-medium">{name}</div>
      {subtitle && (
        <div className="line-clamp-1 text-center text-xs text-muted-foreground">{subtitle}</div>
      )}
    </>
  );

  const wrapClass = "block rounded-lg p-3 transition-colors hover:bg-accent/50";

  if (href) {
    return (
      <Link to={href} className={wrapClass}>
        {inner}
      </Link>
    );
  }
  return <div className={wrapClass}>{inner}</div>;
}
