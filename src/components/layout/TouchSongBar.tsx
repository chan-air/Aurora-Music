import { Mic2 } from "lucide-react";
import { usePlayerStore } from "@/stores/playerStore";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { requestFullscreen } from "@/lib/fullscreen";
import { registerMorphSlot } from "@/lib/touchMorph";
import { useEffectiveArtists } from "@/lib/artistOverrides";
import SkipButton from "@/components/player/SkipButton";
import PlayPauseButton from "@/components/player/PlayPauseButton";
import { DOCK_H } from "./TouchDockNav";

/**
 * 三个按钮的盒子尺寸 —— **与沉浸歌词页那套按键完全一致**（就是组件默认的 h-16 w-16），
 * 歌曲栏里不再各自缩放一套。图标是组件内部的 h-14 w-14，两边自然也一样大。
 */
const BTN = 64;
/** 药丸圆角半径 = 半高（rounded-full），与大胶囊同一个道理 */
const PILL_R = DOCK_H / 2;
/** 玻璃本体 1px 描边：算同心时要扣掉，做法同大胶囊里的 CAPSULE_INSET - border */
const BORDER = 1;
/** 左右内边距 */
const PAD = 6;
/**
 * 最右切歌键与右端圆弧**同心**所需的负外边距。
 *
 * 药丸是 rounded-full，右端圆弧圆心到边框内侧的距离 = PILL_R - BORDER。
 * 按键是边长 BTN 的方盒（图标按钮的"圆"就是它的外接圆，半径 BTN/2），
 * 要让两个圆心重合，它的中心就必须落在离内侧右沿 (PILL_R - BORDER) 的地方；
 * 而 flex 默认把它顶到内边距盒右沿，中心在 PAD + BTN/2 处 —— 两者之差就是这笔偏移。
 * 因为 BTN/2 = 32 > PILL_R - BORDER = 27，按键必然要**探出内边距盒 5px**，
 * 所以只能是负外边距（药丸没有 overflow-hidden，视觉上只有图标会画出来）。
 */
const LAST_BTN_INSET = PAD + BTN / 2 - (PILL_R - BORDER);

/**
 * 触屏竖屏专用的**歌曲栏**（展开态上面那一行）。
 *
 * 它和鼠标端 / 横屏的 PlayerBar 是两套东西：
 *  1) 外形必须与下面那枚大胶囊（TouchDockNav）**是一对** ——
 *     同高度（DOCK_H = 56）、同左右内缩（--dock-inset）、同 border-radius: 9999px、
 *     同一套 .liquid-glass 材质，上下叠放时看起来就是一对玻璃药丸；
 *  2) 内容只保留「封面 + 歌名/歌手 + 三个按钮」，**没有进度条**：
 *       最左：专辑封面（点击 → 沉浸歌词页）
 *       中间：歌名 + 歌手（min-w-0 + truncate，390px 下也不会被挤没）
 *       最右：上一首 / 播放暂停 / 下一首
 *  3) 三个按钮**直接复用沉浸歌词页那套组件**（SkipButton / PlayPauseButton），
 *     动画类（skip-shift-a / skip-exit / skip-enter / skip-appear、按下缩放、磁吸）
 *     与歌词页完全一致，不另起一套。这里只是把按钮盒子改小（h-11 w-11）以便塞进药丸，
 *     组件内部的图标与关键帧一个字都没动。
 *
 * 它同时是合一态「中间歌曲胶囊」的形变来源（见 @/lib/touchMorph），
 * 所以根节点要登记成 full:song 槽位。
 */
export default function TouchSongBar() {
  const current = usePlayerStore((s) => s.current);
  /** 歌手：用户在「歌曲设置」里改过就显示改后的值 */
  const displayArtists = useEffectiveArtists(current);
  const playing = usePlayerStore((s) => s.playing);
  const loading = usePlayerStore((s) => s.loading);
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setLyricsOpen = useAppStore((s) => s.setLyricsOpen);
  const fullscreenOnLyrics = useSettingsStore((s) => s.fullscreenOnLyrics);

  // 没有正在播放的歌时整条不渲染（与 PlayerBar 一致），此时底栏只剩大药丸
  if (!current) return null;

  const openLyrics = () => {
    setLyricsOpen(true);
    if (fullscreenOnLyrics) requestFullscreen();
  };

  return (
    <div
      ref={(el) => {
        registerMorphSlot("full:song", el);
      }}
      data-morph="full-song"
      className="liquid-glass liquid-glass-sheen flex items-center gap-1"
      style={{
        // 与下方大药丸同款：同高度、同左右内缩（与屏幕圆角同心）、同圆角
        height: DOCK_H,
        borderRadius: 9999,
        // 按键比药丸高（64 > 56），靠 items-center 在**内容盒**里居中；
        // 内容盒上下各让开 1px 描边，中心与药丸中心严格重合
        alignItems: "center",
        paddingLeft: PAD,
        paddingRight: PAD,
        marginLeft: "var(--dock-inset)",
        marginRight: "var(--dock-inset)",
        // 两枚药丸之间留一条缝，看着才是一对而不是粘在一起
        marginBottom: 8,
      }}
    >
      {/* 最左：封面 → 沉浸歌词页 */}
      <button
        type="button"
        onClick={openLyrics}
        aria-label="打开沉浸歌词页"
        className="group/cover relative h-11 w-11 shrink-0 overflow-hidden rounded-full bg-muted transition-transform active:scale-95"
      >
        {current.picUrl && <img src={current.picUrl} alt="" className="h-full w-full object-cover" />}
        <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white opacity-0 transition-opacity group-hover/cover:opacity-100">
          <Mic2 className="h-4 w-4" />
        </span>
      </button>

      {/* 中间：歌名 / 歌手 —— min-w-0 + truncate，窄屏也不会被挤没 */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight">{current.name}</div>
        <div className="truncate text-[11px] leading-tight text-muted-foreground">
          {displayArtists}
        </div>
      </div>

      {/* 最右：三个按钮（与沉浸歌词页同款组件、同款尺寸、同款动画）；
          最后一个包一层只为把负外边距写出来，让它的圆心与右端圆弧同心 */}
      <SkipButton direction="prev" onClick={prev} className="shrink-0" />
      <PlayPauseButton
        playing={playing}
        loading={loading}
        onClick={toggle}
        className="shrink-0"
      />
      <div className="flex shrink-0 items-center" style={{ marginRight: -LAST_BTN_INSET }}>
        <SkipButton direction="next" onClick={next} className="shrink-0" />
      </div>
    </div>
  );
}
