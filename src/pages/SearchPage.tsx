import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Loader2 } from "lucide-react";
import { netease } from "@/lib/netease";
import { mapSongToTrack, type Track } from "@/lib/mappers";
import type {
  NeteasePlaylist,
  NeteaseArtistSearch,
  NeteaseAlbumSearch,
  NeteaseUserSearch,
} from "@/types/netease";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import SongRow from "@/components/playlist/SongRow";
import PlaylistCard from "@/components/playlist/PlaylistCard";
import MediaCard from "@/components/common/MediaCard";
import { usePlayerStore } from "@/stores/playerStore";

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [kw, setKw] = useState(q);
  const [songs, setSongs] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<NeteasePlaylist[]>([]);
  const [artists, setArtists] = useState<NeteaseArtistSearch[]>([]);
  const [albums, setAlbums] = useState<NeteaseAlbumSearch[]>([]);
  const [users, setUsers] = useState<NeteaseUserSearch[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const doSearch = async (keyword: string) => {
    setLoading(true);
    setSearched(true);
    try {
      const [sr, pr, ar, alr, ur] = await Promise.all([
        netease.searchSongs(keyword),
        netease.searchPlaylists(keyword),
        netease.searchArtists(keyword),
        netease.searchAlbums(keyword),
        netease.searchUsers(keyword),
      ]);
      setSongs((sr.result?.songs ?? []).map(mapSongToTrack));
      setPlaylists(pr.result?.playlists ?? []);
      setArtists(ar.result?.artists ?? []);
      setAlbums(alr.result?.albums ?? []);
      setUsers(ur.result?.userprofiles ?? []);
    } catch {
      setSongs([]);
      setPlaylists([]);
      setArtists([]);
      setAlbums([]);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setKw(q);
    if (q) void doSearch(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const submit = () => {
    const k = kw.trim();
    if (!k) return;
    setParams({ q: k });
  };

  const playAll = () => {
    if (songs.length) void playTrack(songs[0], songs);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex gap-2">
        <Input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder="搜索歌曲、歌手、歌单、专辑、用户…"
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <Button onClick={submit}>
          <Search className="h-4 w-4" /> 搜索
        </Button>
      </div>

      {loading && (
        <div className="flex justify-center py-20 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {!loading && searched && (
        <Tabs defaultValue="songs">
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="songs">歌曲 ({songs.length})</TabsTrigger>
            <TabsTrigger value="playlists">歌单 ({playlists.length})</TabsTrigger>
            <TabsTrigger value="artists">歌手 ({artists.length})</TabsTrigger>
            <TabsTrigger value="albums">专辑 ({albums.length})</TabsTrigger>
            <TabsTrigger value="users">用户 ({users.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="songs">
            {songs.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">未找到相关歌曲</p>
            ) : (
              <div className="space-y-0.5">
                <div className="mb-2">
                  <Button size="sm" onClick={playAll}>
                    播放全部
                  </Button>
                </div>
                {songs.map((t, i) => (
                  <SongRow key={`${t.id}-${i}`} track={t} index={i} list={songs} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="playlists">
            {playlists.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">未找到相关歌单</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {playlists.map((p) => (
                  <PlaylistCard key={p.id} playlist={p} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="artists">
            {artists.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">未找到相关歌手</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {artists.map((a) => (
                  <MediaCard
                    key={a.id}
                    type="artist"
                    id={a.id}
                    name={a.name}
                    subtitle={a.musicSize ? `${a.musicSize} 首歌` : ""}
                    picUrl={a.picUrl ?? ""}
                    href={`/search?q=${encodeURIComponent(a.name)}`}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="albums">
            {albums.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">未找到相关专辑</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {albums.map((a) => (
                  <MediaCard
                    key={a.id}
                    type="album"
                    id={a.id}
                    name={a.name}
                    subtitle={a.artist?.name ?? ""}
                    picUrl={a.picUrl ?? ""}
                    href={`/album/${a.id}`}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="users">
            {users.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">未找到相关用户</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {users.map((u) => (
                  <MediaCard
                    key={u.userId}
                    type="user"
                    id={u.userId}
                    name={u.nickname}
                    subtitle={u.signature ?? ""}
                    picUrl={u.avatarUrl ?? ""}
                    href={`/user/${u.userId}`}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      {!loading && !searched && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          输入关键字搜索歌曲、歌手、歌单、专辑或用户
        </p>
      )}
    </div>
  );
}
