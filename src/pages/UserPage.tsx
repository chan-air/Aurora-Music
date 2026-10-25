import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2, Music2 } from "lucide-react";
import { netease, parseUserHomeUrl } from "@/lib/netease";
import type { NeteaseUser, NeteasePlaylist, RecordItem } from "@/types/netease";
import { mapSongToTrack, type Track } from "@/lib/mappers";
import { formatCount } from "@/lib/format";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import PlaylistCard from "@/components/playlist/PlaylistCard";
import SongRow from "@/components/playlist/SongRow";
import { useSettingsStore } from "@/stores/settingsStore";

interface RankedTrack {
  track: Track;
  playCount: number;
}

export default function UserPage() {
  const { uid } = useParams();
  const savedHomeUrl = useSettingsStore((s) => s.neteaseHomeUrl);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<NeteaseUser | null>(null);
  const [listenSongs, setListenSongs] = useState(0);
  const [playlists, setPlaylists] = useState<NeteasePlaylist[]>([]);
  const [allData, setAllData] = useState<RankedTrack[]>([]);
  const [weekData, setWeekData] = useState<RankedTrack[]>([]);
  const [range, setRange] = useState<"all" | "week">("all");

  const targetUid = uid ? Number(uid) : parseUserHomeUrl(savedHomeUrl);

  const load = async (id: number) => {
    setLoading(true);
    setError(null);
    setUser(null);
    setPlaylists([]);
    setAllData([]);
    setWeekData([]);
    try {
      const [detail, pl] = await Promise.all([
        netease.userDetail(id),
        netease.userPlaylists(id),
      ]);
      setUser(detail.profile ?? null);
      setListenSongs(detail.listenSongs ?? 0);
      setPlaylists(pl.playlist ?? []);

      // 听歌排行可能因对方隐私设置不可用，单独捕获，避免影响歌单加载
      try {
        const [recAll, recWeek] = await Promise.all([
          netease.userRecord(id, 0),
          netease.userRecord(id, 1),
        ]);
        setAllData((recAll.allData ?? []).map((r: RecordItem) => ({ track: mapSongToTrack(r.song), playCount: r.playCount })));
        setWeekData((recWeek.weekData ?? []).map((r: RecordItem) => ({ track: mapSongToTrack(r.song), playCount: r.playCount })));
      } catch {
        setAllData([]);
        setWeekData([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (targetUid) void load(targetUid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUid]);

  const created = playlists.filter((p) => !p.subscribed);
  const subscribed = playlists.filter((p) => p.subscribed);
  const ranking = range === "all" ? allData : weekData;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      {!targetUid && (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
          <Music2 className="h-10 w-10 opacity-40" />
          <p>尚未设置网易云主页链接，请在「设置」中填写</p>
        </div>
      )}

      {loading && (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Skeleton className="h-20 w-20 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        </div>
      )}

      {error && <div className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error}</div>}

      {user && !loading && (
        <>
          {/* 用户信息 */}
          <div className="flex items-center gap-4">
            <Avatar className="h-20 w-20">
              <AvatarImage src={user.avatarUrl} />
              <AvatarFallback>{user.nickname?.slice(0, 1) ?? "U"}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-2xl font-bold">{user.nickname}</h1>
                <Badge variant="secondary">Lv.{user.level ?? 0}</Badge>
              </div>
              {user.signature && (
                <p className="line-clamp-1 text-sm text-muted-foreground">{user.signature}</p>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>歌单 {playlists.length}</span>
                <span>累计听歌 {formatCount(listenSongs)}</span>
                <span>粉丝 {formatCount(user.followeds)}</span>
                <span>关注 {formatCount(user.follows)}</span>
              </div>
            </div>
          </div>

          <Tabs defaultValue="created">
            <TabsList>
              <TabsTrigger value="created">创建的歌单 ({created.length})</TabsTrigger>
              <TabsTrigger value="subscribed">收藏的歌单 ({subscribed.length})</TabsTrigger>
              <TabsTrigger value="ranking">听歌排行</TabsTrigger>
            </TabsList>

            <TabsContent value="created">
              {created.length === 0 ? (
                <Empty text="暂无公开的创建歌单" />
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {created.map((p) => (
                    <PlaylistCard key={p.id} playlist={p} />
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="subscribed">
              {subscribed.length === 0 ? (
                <Empty text="暂无公开的收藏歌单" />
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {subscribed.map((p) => (
                    <PlaylistCard key={p.id} playlist={p} />
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="ranking">
              <div className="mb-3 flex gap-2">
                <Button
                  variant={range === "all" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setRange("all")}
                >
                  总榜
                </Button>
                <Button
                  variant={range === "week" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setRange("week")}
                >
                  最近一周
                </Button>
              </div>
              {ranking.length === 0 ? (
                <Empty text="暂无听歌排行数据（可能对方未公开）" />
              ) : (
                <div className="space-y-0.5">
                  {ranking.map((r, i) => (
                    <SongRow
                      key={`${range}-${r.track.id}-${i}`}
                      track={r.track}
                      index={i}
                      rightText={`${formatCount(r.playCount)} 次`}
                      list={ranking.map((x) => x.track)}
                    />
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
      <Music2 className="h-8 w-8 opacity-40" />
      <p className="text-sm">{text}</p>
    </div>
  );
}
