import { useEffect, useState } from "react";
import { Routes, Route } from "react-router-dom";
import AppLayout from "@/components/layout/AppLayout";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  ensureLyricsCached,
  applyAudioMountSetting,
  getPlaybackPosition,
  getPreloadedLyrics,
  restorePlayerState,
  usePlayerStore,
} from "@/stores/playerStore";
import {
  bindMediaSessionActions,
  clearMediaPosition,
  refreshMediaSessionHandlers,
  updateMediaMetadata,
  updateMediaPlaybackState,
  updateMediaPosition,
} from "@/lib/mediaSession";
import {
  loadSongOverrides,
  getSongOverrides,
  saveSongOverride,
} from "@/lib/storage";
import { resolveNoLyrics, applyLyricDisplaySettings } from "@/lib/lyrics";
import { listLocalAudioIds } from "@/lib/audioStore";
import { applyAppFont } from "@/lib/fonts";
import {
  clampGlassTransparency,
  glassBodyOpacity,
  glassBlurPx,
  glassEdgeAlphaScale,
  glassSaturatePct,
  GLASS_BODY_TOP_RATIO,
} from "@/lib/glassTone";
import { publishSongSettings, startShareSync } from "@/lib/share";
import { useLyricsFollowFullscreen } from "@/hooks/useLyricsFollowFullscreen";
import { usePlayerShortcuts } from "@/hooks/usePlayerShortcuts";
import { DisclaimerGate } from "@/components/common/DisclaimerGate";

/** 清理指向「已不存在的本地音频」的替换标记（例如浏览器不允许持久化存储时） */
async function pruneMissingLocalAudio(): Promise<void> {
  const marked = getSongOverrides().filter((o) => o.audioName);
  if (!marked.length) return;
  const ids = new Set(await listLocalAudioIds());
  for (const o of marked) {
    if (ids.has(o.songId)) continue;
    await saveSongOverride({
      songId: o.songId,
      name: o.name,
      artists: o.artists,
      instrumental: o.instrumental,
      lyricFormat: o.lyricFormat,
      lyricText: o.lyricText,
      audioName: "",
      audioSize: 0,
      // 只清"指向不存在文件的音频标记"，显示设置原样保留
      skipLeadingLines: o.skipLeadingLines ?? 0,
      translationShift: o.translationShift ?? 0,
    });
  }
}
import UserPage from "@/pages/UserPage";
import PlaylistPage from "@/pages/PlaylistPage";
import ExplorePage from "@/pages/ExplorePage";
import AlbumPage from "@/pages/AlbumPage";
import SearchPage from "@/pages/SearchPage";
import FavoritesPage from "@/pages/FavoritesPage";
import HistoryPage from "@/pages/HistoryPage";
import SongsPage from "@/pages/SongsPage";
import SongSettingsPage from "@/pages/SongSettingsPage";
import SettingsPage from "@/pages/SettingsPage";

/**
 * 取「当前应该显示在锁屏上行的歌词」。
 *
 * 只取歌词正文 —— 翻译与音译（AMLL 的 translatedLyric / romanLyric）一律不用；
 * 背景人声行也跳过，避免主歌词被和声抢走。
 * 纯音乐（手动标记为纯音乐，或压根没有歌词）返回空串，此时锁屏沿用「歌名 / 歌手」两行。
 */
/** 锁屏上行歌词的换句记忆（供「每句最短停留」使用） */
let lockLyricShownText = "";
let lockLyricShownAt = 0;

function currentLyricFor(trackId: number, posSec: number): string {
  /*
   * 单曲显示设置（跳过前 N 行 / 翻译偏移）是**整条歌词管线的最后一道后处理**，
   * 锁屏上行也必须走同一道 —— 否则会出现「沉浸页裁掉了前两行、锁屏却还在显示它们」。
   * 这里只是现算一份显示视图，不改动底层歌词缓存、也不影响沉浸页那一份。
   */
  const lines = applyLyricDisplaySettings(trackId, getPreloadedLyrics(trackId) ?? []);
  if (lines.length === 0) return "";
  /*
   * 用全应用统一的那套判定：手动标记优先，其次按歌词内容自动识别。
   * 网易云对纯音乐常返回「纯音乐，请欣赏」这类占位歌词 —— 只看手动标记会漏掉，
   * 结果锁屏上行把占位文案当成了歌词。纯音乐应当维持「歌名 / 歌手」两行。
   */
  if (resolveNoLyrics(trackId, lines)) return "";
  const cfg = useSettingsStore.getState();
  /*
   * 偏移直接加在播放位置上：负数 = 用「更靠后」的位置去查歌词行，
   * 也就是这一行会更早出现（提前）；正数则延后。
   * 默认 -600ms = 每句提前 0.6 秒更新。
   */
  const posMs = posSec * 1000 - (cfg.lockLyricOffsetMs || 0);
  let text = "";
  for (const ln of lines) {
    if (ln.startTime > posMs) break;
    if ((ln as { isBG?: boolean }).isBG) continue;
    const t = (ln.words ?? [])
      .map((w) => w.word ?? "")
      .join("")
      .trim();
    if (t) text = t;
  }
  if (!text) return "";
  // 每句最短停留：短句密集时不要立刻翻页，否则锁屏上行会闪个不停
  const dwell = cfg.lockLyricMinDwellMs || 0;
  if (text !== lockLyricShownText) {
    if (dwell > 0 && lockLyricShownText && Date.now() - lockLyricShownAt < dwell) {
      return lockLyricShownText;
    }
    lockLyricShownText = text;
    lockLyricShownAt = Date.now();
  }
  return text;
}

export default function App() {
  const appFontFamily = useSettingsStore((s) => s.appFontFamily);
  // 锁屏兼容（进阶）：见设置页「锁屏兼容（进阶）」卡片；默认「开 + 开」= 实机验证可用的组合
  const lockMountAudio = useSettingsStore((s) => s.lockMountAudio);
  const lockPushPosition = useSettingsStore((s) => s.lockPushPosition);

  const shareSongSettings = useSettingsStore((st) => st.shareSongSettings);
  const settingsLoaded = useSettingsStore((st) => st.loaded);
  /**
   * 启动期的「歌曲设置」是否已经读完。
   *
   * 为什么必须有这道闸：发布共享时要读 getSongOverrides()，而那份内存缓存在
   * 启动时是空的 —— 真正的读取在上面那个启动 IIFE 里（读 IndexedDB / localStorage
   * 是异步的，实测比设置加载慢一拍以上）。设置一 loaded 就发布的话，
   * 会把 **overrides: [] 的空共享**发上去（服务端照样返回 200），
   * 对方拉到的就是空的 —— 这也是「开了共享却没用」的原因之一。
   * 所以在读完之前不许发布，读完后本副作用重跑、补发一次。
   */
  const [songSettingsReady, setSongSettingsReady] = useState(false);

  useEffect(() => {
    // 启动时加载设置；歌曲手动标记要先就绪，歌词加载是同步读缓存的
    void useSettingsStore.getState().load();
    void (async () => {
      /*
       * 这里用 try/finally 是**必须**的：songSettingsReady 决定「共享开关有没有反应」，
       * 一旦某一步抛错（IndexedDB 被禁用 / 配额满 / 本地音频记录损坏…）让这个 IIFE
       * 提前 reject，闸门就永远不会开 —— 表现是开关怎么点都不发任何 /share/ 请求，
       * 连关闭共享的那次发布都没有。所以"读过一次歌曲设置"这件事无论成败都要放行。
       */
      try {
        await loadSongOverrides();
        await pruneMissingLocalAudio();
        await restorePlayerState();
        // 覆盖信息就绪后，通知歌词页重新判断一次
        window.dispatchEvent(new Event("song-overrides-changed"));
      } catch (err) {
        console.error("[Aurora Music] 启动时加载歌曲设置失败（共享闸门照常放行）：", err);
      } finally {
        setSongSettingsReady(true);
      }
    })();
  }, []);

  /*
   * 液态玻璃透明度：写进 CSS 变量供停靠栏（与设置页预览条）的玻璃涂装取用。
   *
   * ── 口径：滑块数字 = 底栏大胶囊的透明度数值 ────────────────────────
   * 不解释成"感知上的通透程度"，就是 a = (100-t)/100：
   *   t = 80（默认）→ a = 0.20：半透明玻璃
   *   t = 94        → a = 0.06：几乎完全不可见
   * 大胶囊自身的**全部涂装**都乘 a（本体两层色标、描边、顶部高光 / 内阴影、
   * sheen 光泽），保持它们彼此的相对关系 —— 于是数字变了，整层玻璃一起变。
   *
   * 背后的磨砂也跟着同一条轴走（否则数字说"几乎全透明"、背后却还糊着）：
   *   blur：    80% → 18px（就是 CSS 里今天那个值）→ 94% → 0px
   *   saturate：80% → 180% → 94% → 100%
   *
   * 以前"调了没用"的根因：只有本体底色在变，描边 / 高光 / sheen / 背景磨砂
   * 一概不动，数字变了那层玻璃外观照旧。
   *
   * **文字与图标绝不跟着淡**：a 只写在玻璃的涂装变量上（背景图 / 描边 / 阴影 /
   * ::after 光泽），不会加到含内容的容器上；浅色背景下的文字转深色由
   * lib/glassTone.ts 的色调自适应负责。
   *
   * 读到的值一律先经 clampGlassTransparency 钳到 80..94：
   * 老版本存的是 72（乃至手改的 99），不钳就会算出范围外的模糊 / 饱和度。
   *
   * 作用域：只有 .liquid-glass--tone（触屏竖屏那颗药丸 + 设置页预览条）读这些变量；
   * 歌曲栏 / 合一态那几块玻璃沿用 :root 里的固定材质，观感一行都没变。
   */
  const glassTransparency = useSettingsStore((s) => s.glassTransparency);
  useEffect(() => {
    const root = document.documentElement;
    const t = clampGlassTransparency(glassTransparency);
    const a = glassBodyOpacity(t);
    // 大胶囊的透明度数值：两层色标都按 a 缩放，上沿另乘 0.71 只是明暗配比
    root.style.setProperty("--glass-body-top", (a * GLASS_BODY_TOP_RATIO).toFixed(3));
    root.style.setProperty("--glass-body-bottom", a.toFixed(3));
    // 涂装（描边 / 高光 / 内阴影 / 光泽）按同一比例缩放：80% → 1，94% → 0.30
    const paint = glassEdgeAlphaScale(t);
    root.style.setProperty("--glass-edge-fade", paint.toFixed(3));
    root.style.setProperty("--glass-shadow-fade", paint.toFixed(3));
    // 背后的磨砂跟着同一条轴走
    root.style.setProperty("--glass-blur", `${glassBlurPx(t).toFixed(1)}px`);
    root.style.setProperty("--glass-saturate", `${glassSaturatePct(t).toFixed(0)}%`);
  }, [glassTransparency]);

  /*
   * 歌曲设置共享：
   *  - 开启 → 把本机设置发布到本机代理，并监听「歌曲设置已变化」事件重新发布；
   *  - 关闭 → 通知服务端清掉已发布的内容，避免关了之后别人还能拉到。
   * 等设置加载完再执行，否则会先用默认值（关闭）把已有的共享清掉。
   */
  useEffect(() => {
    if (!settingsLoaded) return;
    /* 启动期的闸门：见 songSettingsReady 的说明（空共享就是这么发上去的） */
    if (!songSettingsReady) return;
    if (!shareSongSettings) {
      void publishSongSettings(false);
      return;
    }
    return startShareSync();
  }, [settingsLoaded, shareSongSettings, songSettingsReady]);

  /*
   * 锁屏 / 系统媒体面板（iPhone 锁屏、安卓通知栏、桌面媒体键都走这套 Media Session）：
   *  1) 绑定播放/暂停、上一首/下一首、拖动进度等动作 —— 不绑定这些按钮就是灰的；
   *  2) 换歌与播放状态变化时更新标题、作者、封面 —— 不设就只显示网页标题；
   *  3) 每秒同步一次进度 —— 不给 setPositionState 就没有进度条，也拖不动。
   */
  useEffect(() => {
    bindMediaSessionActions({
      play: () => {
        const st = usePlayerStore.getState();
        if (!st.playing) st.toggle();
      },
      pause: () => {
        const st = usePlayerStore.getState();
        if (st.playing) st.toggle();
      },
      next: () => usePlayerStore.getState().next(),
      prev: () => usePlayerStore.getState().prev(),
      seek: (sec) => {
        const st = usePlayerStore.getState();
        st.seek(sec);
        /*
         * 只在「搜索这一刻」把新位置告诉系统，之后由系统自己推算。
         * 绝不能用定时器反复推：拖动锁屏进度条时，定时推送会把滑块一次次
         * 拽回当前播放位置，表现成「根本拖不动」（iOS 上尤其明显）。
         *
         * 若这次搜索来自锁屏（seekto），mediaSession 层已经先开了 3 秒抑制窗口，
         * 下面这次写入会被静默拦下 —— 那是刻意的：拖动中不写。
         */
        const dur = st.duration || st.current?.duration || 0;
        if (dur > 0) updateMediaPosition(dur, sec);
      },
      stop: () => {
        const st = usePlayerStore.getState();
        if (st.playing) st.toggle();
        clearMediaPosition();
      },
    });
  }, []);

  useEffect(() => {
    const st0 = usePlayerStore.getState();
    updateMediaMetadata(st0.current, "");
    updateMediaPlaybackState(st0.playing);

    const unsub = usePlayerStore.subscribe((st, prev) => {
      if (st.current?.id !== prev.current?.id) {
        // 换歌先把换句记忆清掉，免得沿用上一首的最后一句
        lockLyricShownText = "";
        lockLyricShownAt = 0;
        /*
         * 重装锁屏动作处理器：Howler 每首歌都会新建 <audio> 元素，
         * 系统可能在媒体元素更换后把处理器重置，重置后锁屏就退回默认的 ±10 秒键。
         */
        refreshMediaSessionHandlers();
        // 换歌先用「歌名 / 歌手」，歌词由下面的定时器在拿到后补上
        updateMediaMetadata(st.current, "");
        /*
         * 换歌时**不再**主动推一次位置：位置只在「开始播放 / 搜索发生 / 首次拿到时长」
         * 这三个时刻推。紧接着的「时长变了」分支会把这个新曲目的时长范围补上，
         * 所以进度条不会失去范围。
         *
         * 但**绝对不要**在时长未知时清空位置状态：setPositionState() 不带参数是
         * 「重置」语义，一旦清掉，系统手上就没有时长范围了 —— 锁屏进度条会变成
         * 只读、怎么拖都不动（这正是"进度条拖不动"的根因之一）。
         */
      }
      if (st.playing !== prev.playing) {
        updateMediaPlaybackState(st.playing);
        if (st.playing) {
          // 开始播放时再确认一次动作处理器在位（Safari 可能延迟暴露 mediaSession）
          refreshMediaSessionHandlers();
          /*
           * 只在**开始播放**时推一次位置，其余时间不再推送 —— 系统会按
           * playbackRate 自行推算进度，这样既不会和用户拖动打架，进度条也照常前进。
           *
           * 暂停时**绝不**推：抓取锁屏滑块时系统可能先下发 pause，
           * 此刻写位置就是在和用户的手抢滑块（表现为「拖不动」）。
           */
          const pos = getPlaybackPosition();
          const dur = st.duration || st.current?.duration || 0;
          if (dur > 0) updateMediaPosition(dur, pos);
          /*
           * iOS 常常忽略「还没开始播放时」设置的锁屏信息与进度，
           * 所以真正进入播放时再补一次，封面/作者与进度条才会稳定出现。
           */
          updateMediaMetadata(
            st.current,
            st.current ? currentLyricFor(st.current.id, pos) : "",
          );
        }
      }
      /*
       * 时长刚拿到（音频元数据加载完成）时立刻补一次进度，进度条才能尽早可用。
       * 换歌后的新时长也走这一条 —— 这就是「换歌不再单独推位置」的兜底。
       */
      if (st.duration !== prev.duration && st.duration > 0) {
        updateMediaPosition(st.duration, getPlaybackPosition());
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    /*
     * 这个定时器**只用来刷新歌词**（锁屏上行文字）。
     *
     * 进度**不在这里推**：它由下面单独的 1 秒定时器负责（那是「让锁屏进度条可拖」的
     * 必要推送，且会被 seekto 后的抑制窗口挡住）。把两件事拆开是因为节奏不同：
     * 歌词要 500ms 跟手，位置 1 秒一次就够，混在一起只会互相牵连。
     * 元数据内部有文字去重，内容没变时不会重复下发；真正下发时若正好落在
     * 「收到 seekto 后的 3 秒抑制窗口」内，mediaSession 层会静默拦下
     * —— 歌词功能本身照常运行（这里只是不再写媒体会话）。
     */
    const id = window.setInterval(() => {
      const st = usePlayerStore.getState();
      if (!st.current) return;
      /*
       * 这里**不再**定时重装动作处理器。
       *
       * 之前为了治「锁屏切歌键变回 ±10 秒」加了每 5 秒重装一次，但拖动锁屏进度条时
       * 重装处理器可能把正在进行的拖拽打断（表现为进度条拖不动）。
       * 真正修好 ±10 秒的是下面两处按需重装（换歌 / 开始播放），保留即可。
       */
      if (getPreloadedLyrics(st.current.id) === undefined) ensureLyricsCached(st.current.id);
      updateMediaMetadata(st.current, currentLyricFor(st.current.id, getPlaybackPosition()));
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  /*
   * 锁屏进度的**周期推送**（每秒一次）。
   *
   * iOS Safari 的锁屏进度条通常需要 App 持续更新 positionState 才是「可拖动」的，
   * 所以这里必须推；但拖动期间推送会把滑块拽回播放位置，因此：
   *   · 收到 seekto 之后的 3 秒内，mediaSession 的抑制窗口会把这次推送拦下
   *     —— 不与用户的手抢滑块；
   *   · 暂停时照推（位置不变）：让系统一直握着合法的时长范围，进度条才不会变只读；
   *   · 没有当前歌曲、或还拿不到合法时长时不推。
   * 注意：这里**只推位置**，不重装动作处理器、不改 metadata。
   *
   * 锁屏兼容（进阶设置）里的「每秒推 positionState」可以关掉这个定时器：
   * 关掉后不再周期推位置（实测进度条很可能因此不再可拖），仅供排查用。
   */
  useEffect(() => {
    if (!lockPushPosition) return;
    const id = window.setInterval(() => {
      const st = usePlayerStore.getState();
      if (!st.current) return;
      const dur = st.duration || st.current.duration || 0;
      if (!(dur > 0)) return;
      updateMediaPosition(dur, getPlaybackPosition());
    }, 1000);
    return () => window.clearInterval(id);
  }, [lockPushPosition]);

  /*
   * 锁屏兼容（进阶设置）里的「把 <audio> 挂进文档」切换后**立即生效**：挂上或移出文档，
   * 不用刷新（移出/挂上都不断播放）。开关值由 playerStore 在挂载时直接读取，
   * 这里只负责"切换的那一刻"。
   */
  useEffect(() => {
    applyAudioMountSetting();
  }, [lockMountAudio]);

  /*
   * 沉浸歌词跟随全屏（设置页「通用」卡片里的开关，**仅电脑端**）：
   * 开启后网页进入全屏自动打开沉浸歌词页、退出全屏自动关闭。
   * 默认关闭或触屏设备时这个 hook 不注册任何监听，既有行为不受影响。
   */
  useLyricsFollowFullscreen();

  /*
   * 键盘快捷键：沉浸歌词页里 Space = 暂停/播放、← / → = 上一首/下一首；
   * 其它页面用 Tab + Space、Tab + ← / Tab + →（见 hooks/usePlayerShortcuts.ts）。
   * 输入框、下拉菜单与打开的模态框里一律让行，不抢键。
   */
  usePlayerShortcuts();

  return (
    <>
      <AppLayout>
        <Routes>
          {/*
            首页 = 用户主页：原来的「欢迎页」（HomePage）已删除，
            根路由直接指向 UserPage；/user 与 /user/:uid 保留可用。
          */}
          <Route path="/" element={<UserPage />} />
          <Route path="/user" element={<UserPage />} />
          <Route path="/user/:uid" element={<UserPage />} />
          <Route path="/playlist/:id" element={<PlaylistPage />} />
          {/* 歌曲探索：歌单页的「探索」入口进来；路径独立，刷新 / 直接打开都能复现同一排列 */}
          <Route path="/playlist/:id/explore" element={<ExplorePage />} />
          <Route path="/album/:id" element={<AlbumPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/history" element={<HistoryPage />} />
          {/* 「歌曲」卡片页；原来的歌曲设置挪到 /song-settings */}
          <Route path="/songs" element={<SongsPage />} />
          <Route path="/song-settings" element={<SongSettingsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<UserPage />} />
        </Routes>
      </AppLayout>
      {/*
        版权与免责声明：首次启动弹一次（人工点「我已了解」后才记录，
        记录落在 kv 存储里，见 lib/storage.ts 的 getDisclaimerAccepted / saveDisclaimerAccepted）。
      */}
      <DisclaimerGate />
    </>
  );
}
