import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isFavoriteItem,
  addFavoriteItem,
  removeFavoriteItem,
  type FavoriteType,
} from "@/lib/storage";

interface FavoriteButtonProps {
  type: FavoriteType;
  id: number;
  name: string;
  subtitle?: string;
  picUrl?: string;
  className?: string;
}

/** 通用收藏按钮（歌单 / 歌手 / 用户 / 专辑） */
export default function FavoriteButton({
  type,
  id,
  name,
  subtitle = "",
  picUrl = "",
  className,
}: FavoriteButtonProps) {
  const [fav, setFav] = useState(false);

  useEffect(() => {
    let on = true;
    isFavoriteItem(type, id).then((v) => on && setFav(v));
    return () => {
      on = false;
    };
  }, [type, id]);

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (fav) {
      await removeFavoriteItem(type, id);
      setFav(false);
    } else {
      await addFavoriteItem({ type, id, name, subtitle, picUrl });
      setFav(true);
    }
    window.dispatchEvent(new Event("favorites-changed"));
  };

  return (
    <button
      onClick={toggle}
      title={fav ? "取消收藏" : "收藏"}
      aria-label="收藏"
      className={cn(
        "grid h-8 w-8 place-items-center rounded-full bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/60",
        className,
      )}
    >
      <Heart className={cn("h-4 w-4", fav && "fill-red-500 text-red-500")} />
    </button>
  );
}
