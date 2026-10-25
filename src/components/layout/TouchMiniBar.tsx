import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Pause, Play, Search } from "lucide-react";
import { usePlayerStore } from "@/stores/playerStore";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { requestFullscreen } from "@/lib/fullscreen";
import { registerMorphSlot } from "@/lib/touchMorph";
import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "./nav";
import { useNavHighlight } from "./useNavHighlight";
import { useEffectiveArtists } from "@/lib/artistOverrides";

/** 折叠态那一行的高度：圆形按钮与歌曲胶囊共用，保证三者严格等高对齐 */
const MINI_H = 52;

/**
 * 触屏竖屏的**合一态**底栏：一整行，三块。
 *
 *   左：圆形按钮，里面是**当前页面**的图标 —— 点击**展开回两栏**（原来是不可点的死 DIV）
 *   中：歌曲胶囊 —— 封面点开沉浸歌词页、播放/暂停切换播放，
 *        **其余部分（歌名/歌手、以及胶囊的空白背景）点击展开回两栏**
 *   右：对称的圆形搜索按钮 —— 点击进入 /search
 *
 * 它由 AppLayout 按「内容区滚动方向 / 静置超时」切换显示 —— 这一层只管画，
 * 不参与折叠判定。材质沿用液态玻璃（.liquid-glass），与展开态的药丸同一套折射参数。
 *
 * 三个元素还各自登记成 @/lib/touchMorph 的 mini:* 槽位：
 * 它们是合一态里被**形变**出来的目标（折叠时）或源（展开时），
 * 所以哪怕看起来只是个图标，也必须是一个能被量到矩形的真实盒子。
 */
export default function TouchMiniBar({ onExpand }: { onExpand: () => void }) {
  const navigate = useNavigate();

  const current = usePlayerStore((s) => s.current);
  /** 歌手：用户在「歌曲设置」里改过就显示改后的值 */
  const displayArtists = useEffectiveArtists(current);
  const playing = usePlayerStore((s) => s.playing);
  const loading = usePlayerStore((s) => s.loading);
  const toggle = usePlayerStore((s) => s.toggle);
  const setLyricsOpen = useAppStore((s) => s.setLyricsOpen);
  const fullscreenOnLyrics = useSettingsStore((s) => s.fullscreenOnLyrics);
  /** 「按压形变」设置：合一态按下反馈的幅度（与展开态那颗大药丸同一个旋钮） */
  const pressDeform = useSettingsStore((s) => s.glassPressDeform);

  /*
   * 按下反馈的幅度来自设置项「按压形变」（见 lib/settings.ts 的映射）。
   * 三块元素原来是写死的 active:scale-90 / active:scale-95（按下缩小），
   * 现在改成把系数交给 index.css 的 .mini-press / .mini-press-soft：
   *   圆形按钮（左圆 / 右圆 / 播放键）：1 - 0.10t（t=50 默认 → 0.90，正好是原来的 scale-90）
   *   歌曲胶囊里的封面：1 - 0.05t（t=50 默认 → 0.95，原来的 scale-95）
   * t=0 → 都是 1（完全不动），t=100 → 0.90 / 0.95。
   * 用纯 CSS 的 :active（而不是 React 状态）是刻意的：按下时长完全由指针决定，
   * 按住期间 re-render 也不会把形变提前收回；形变动画期间由 @/lib/touchMorph
   * 往元素上写行内 transform 压住它（那条路径原本就在，未改动）。
   */
  const deformT = Math.min(100, Math.max(0, pressDeform ?? 50)) / 100;
  const miniPressVars = {
    "--mini-press": String(1 - deformT * 0.1),
    "--mini-press-soft": String(1 - deformT * 0.05),
  } as CSSProperties;

  /*
   * 当前页面图标：复用统一的高亮解析（归属匹配 + 「从哪来回哪去」的退路）。
   * 所以 /favorites、/history、/song-settings、/playlist/:id 显示的都是来源那一项的图标。
   */
  const index = useNavHighlight();
  const item = NAV_ITEMS[index >= 0 ? index : 0];
  const PageIcon = item.icon;

  const openLyrics = () => {
    setLyricsOpen(true);
    if (fullscreenOnLyrics) requestFullscreen();
  };

  return (
    <div
      className="flex items-center gap-2"
      style={{
        // 与药丸同款内缩：左右贴屏幕圆角的同心位置，底部让开 iOS 安全区
        marginLeft: "var(--dock-inset)",
        marginRight: "var(--dock-inset)",
        marginBottom: "calc(var(--dock-inset) + env(safe-area-inset-bottom, 0px))",
        // 按下缩放的系数（见上面的 miniPressVars），由 .mini-press* 在 :active 时使用
        ...miniPressVars,
      }}
    >
      {/* 左：当前页图标 —— 点它展开回两栏 */}
      <button
        ref={(el) => {
          registerMorphSlot("mini:left", el);
        }}
        data-morph="mini-left"
        type="button"
        onClick={onExpand}
        aria-label={`展开歌曲栏与导航（当前：${item.label}）`}
        className={cn(
          "liquid-glass flex shrink-0 items-center justify-center rounded-full text-primary mini-press",
        )}
        style={{ width: MINI_H, height: MINI_H }}
      >
        <PageIcon className="h-6 w-6" />
      </button>

      {/* 中：歌曲胶囊。没有正在播放的歌时留一个空位，左右两个圆仍贴在两边 */}
      {current ? (
        /*
         * 展开的点击挂在**容器**上：封面与播放键各自的处理器里 stopPropagation，
         * 所以「点封面 → 歌词页」「点播放键 → 切播放」都不会顺带展开。
         * 容器不写成 <button>：里面已经有两个按钮，按钮套按钮是非法结构，
         * 键盘用户由里面那几个真实按钮负责可达性，这一层只是鼠标 / 触摸的便利热区。
         */
        <div
          ref={(el) => {
            registerMorphSlot("mini:song", el);
          }}
          data-morph="mini-song"
          onClick={onExpand}
          className="liquid-glass flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-full pl-1.5 pr-1.5"
          style={{ height: MINI_H }}
        >
          {/* 封面 → 沉浸歌词页 */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openLyrics();
            }}
            aria-label="打开沉浸歌词页"
            className={cn(
              "h-10 w-10 shrink-0 overflow-hidden rounded-full bg-muted mini-press-soft",
            )}
          >
            {current.picUrl && (
              <img src={current.picUrl} alt="" className="h-full w-full object-cover" />
            )}
          </button>

          {/* 歌名 / 歌手（连同这里的空白也是展开热区，冒泡到容器） */}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium leading-tight">{current.name}</div>
            <div className="truncate text-[10px] leading-tight text-muted-foreground">
              {displayArtists}
            </div>
          </div>

          {/* 播放 / 暂停：只切播放，不展开 */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            aria-label={playing ? "暂停" : "播放"}
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary mini-press",
            )}
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : playing ? (
              <Pause className="h-5 w-5" />
            ) : (
              <Play className="h-5 w-5" />
            )}
          </button>
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* 右：搜索 */}
      <button
        ref={(el) => {
          registerMorphSlot("mini:right", el);
        }}
        data-morph="mini-right"
        type="button"
        onClick={() => navigate("/search")}
        aria-label="搜索"
        className={cn(
          "liquid-glass flex shrink-0 items-center justify-center rounded-full text-muted-foreground mini-press",
        )}
        style={{ width: MINI_H, height: MINI_H }}
      >
        <Search className="h-6 w-6" />
      </button>
    </div>
  );
}
