import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import {
  getFavorites,
  getFavoriteItems,
  type SavedSong,
  type FavoriteItem,
  type FavoriteType,
} from "@/lib/storage";
import type { Track } from "@/lib/mappers";
import SongRow from "@/components/playlist/SongRow";
import MediaCard from "@/components/common/MediaCard";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { usePlayerStore } from "@/stores/playerStore";

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

export default function FavoritesPage() {
  const [songs, setSongs] = useState<SavedSong[]>([]);
  const [items, setItems] = useState<FavoriteItem[]>([]);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const load = () => {
    void getFavorites().then(setSongs);
    void getFavoriteItems().then(setItems);
  };

  useEffect(() => {
    load();
    const onChanged = () => load();
    window.addEventListener("favorites-changed", onChanged);
    return () => window.removeEventListener("favorites-changed", onChanged);
  }, []);

  const tracks = songs.map(toTrack);
  const byType = (t: FavoriteType) => items.filter((i) => i.type === t);

  const hrefFor = (i: FavoriteItem) => {
    if (i.type === "playlist") return `/playlist/${i.id}`;
    if (i.type === "album") return `/album/${i.id}`;
    if (i.type === "user") return `/user/${i.id}`;
    if (i.type === "artist") return `/search?q=${encodeURIComponent(i.name)}`;
    return undefined;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6">
      <h2 className="text-2xl font-bold">我的收藏</h2>

      <Tabs defaultValue="songs">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="songs">歌曲 ({tracks.length})</TabsTrigger>
          <TabsTrigger value="playlists">歌单 ({byType("playlist").length})</TabsTrigger>
          <TabsTrigger value="artists">歌手 ({byType("artist").length})</TabsTrigger>
          <TabsTrigger value="albums">专辑 ({byType("album").length})</TabsTrigger>
          <TabsTrigger value="users">用户 ({byType("user").length})</TabsTrigger>
        </TabsList>

        <TabsContent value="songs">
          {tracks.length === 0 ? (
            <Empty />
          ) : (
            <div className="space-y-0.5">
              {tracks.map((t, i) => (
                <SongRow key={`${t.id}-${i}`} track={t} index={i} list={tracks} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="playlists">
          <Grid items={byType("playlist")} hrefFor={hrefFor} />
        </TabsContent>

        <TabsContent value="artists">
          <Grid items={byType("artist")} hrefFor={hrefFor} />
        </TabsContent>

        <TabsContent value="albums">
          <Grid items={byType("album")} hrefFor={hrefFor} />
        </TabsContent>

        <TabsContent value="users">
          <Grid items={byType("user")} hrefFor={hrefFor} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Grid({
  items,
  hrefFor,
}: {
  items: FavoriteItem[];
  hrefFor: (i: FavoriteItem) => string | undefined;
}) {
  if (items.length === 0) return <Empty />;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((i) => (
        <MediaCard
          key={`${i.type}-${i.id}`}
          type={i.type}
          id={i.id}
          name={i.name}
          subtitle={i.subtitle}
          picUrl={i.picUrl}
          href={hrefFor(i)}
        />
      ))}
    </div>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
      <Heart className="h-8 w-8 opacity-40" />
      <p className="text-sm">暂无收藏</p>
    </div>
  );
}
