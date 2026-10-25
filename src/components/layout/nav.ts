import {
  History,
  Heart,
  ListMusic,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import HomeGlyph from "./HomeGlyph";

/**
 * 导航图标类型：既接受 lucide 图标，也接受自绘的内联 SVG（如圆角小房子）。
 * 只约定 `className` 一个属性 —— 三处导航（BottomNav / Sidebar / TouchDockNav）
 * 都只传它，这样自绘图标不必伪装成 lucide 的完整 props。
 */
export type NavIcon = LucideIcon | ComponentType<{ className?: string }>;

export interface NavItem {
  to: string;
  label: string;
  icon: NavIcon;
  end?: boolean;
  /**
   * 额外算作「本项」的路径（**前缀**匹配：路径本身或其子路径都命中）。
   * 用途：子页面 / 关联页面仍然让本项保持高亮 ——
   * 例如 /song-settings、/favorites、/history 都归属「歌曲」。
   */
  match?: string[];
  /**
   * 额外算作「本项」的路径，但**必须完全相等**才命中（不做子路径展开）。
   *
   * 用途：`/user` 是「我自己的主页」，而 `/user/:uid` 是**别人的**主页 ——
   * 后者不能被前缀归到首页，必须走「从哪来回哪去」（从搜索点进去就跟随「搜索」）。
   */
  exact?: string[];
}

/**
 * 底部 / 侧边导航项。
 *
 * **顺序固定为：首页、歌曲、设置、搜索**（触屏竖屏的液态玻璃药丸按此顺序均分宽度，
 * 高亮胶囊与变色透镜都依赖这个数组的下标）。
 */
export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "首页", icon: HomeGlyph, end: true, exact: ["/user"] },
  {
    to: "/songs",
    label: "歌曲",
    icon: ListMusic,
    match: ["/song-settings", "/favorites", "/history"],
  },
  { to: "/settings", label: "设置", icon: Settings },
  { to: "/search", label: "搜索", icon: Search },
];

/** 「首页」那一项的下标（无来源时的兜底要用到，避免写死 0） */
const HOME_INDEX = NAV_ITEMS.findIndex((it) => it.to === "/");

/**
 * 当前路径**自身**命中的导航项下标；都不命中时返回 -1。
 *
 * 只看路由归属（`to` + 前缀 `match` + 完全相等 `exact`），不看来源。
 * 两个容易踩的点：
 *   · `/user/:uid`（别人的主页）**不归属首页** —— 首页那条只把 `/user` 放进 `exact`；
 *   · /playlist/:id 与 /album/:id 也**有意不列入**任何归属：它们既可能是从首页
 *     （用户创建的歌单 / 专辑）进来的，也可能是从搜索进来的，唯一正确的答案
 *     只能由「来源」决定 —— 见下面的 navIndexForPath。
 */
function ownNavIndex(pathname: string): number {
  return NAV_ITEMS.findIndex((it) => {
    if ((it.exact ?? []).includes(pathname)) return true;
    const hit = it.end
      ? pathname === it.to
      : pathname === it.to || pathname.startsWith(`${it.to}/`);
    if (hit) return true;
    return (it.match ?? []).some((m) => pathname === m || pathname.startsWith(`${m}/`));
  });
}

/**
 * 只看路径自身的归属（不套用来源兜底）。
 *
 * 给 useNavHighlight 判断「这条路径能不能充当来源」用：能用来源的必须自己**本来就有归属**，
 * 否则 /user/:uid 这种「靠兜底才勉强有下标」的路径会被记成来源，来源链就断错了。
 */
export function navIndexForOwnPath(pathname: string): number {
  return ownNavIndex(pathname);
}

/**
 * 当前应该**高亮**哪一项；实在没有答案时返回 -1（不高亮）。
 *
 * 「从哪来回哪去」的解析，唯一入口（四处导航面全部调用它，规则只有这一份）：
 *
 *   ① 当前路径自己有归属 → 用它的下标：
 *        /songs、/favorites、/history、/song-settings → 歌曲；
 *        `/`、`/user`（仅此一条，必须完全相等）→ 首页；/settings → 设置；/search → 搜索；
 *   ② 自己没有归属（/user/:uid、/playlist/:id、/album/:id 等）→ 沿用 lastNavPath
 *      （最近一次归属明确的路径，例如从「搜索」页点进来的就是 /search）对应的下标
 *      —— 来源那一项保持高亮；
 *   ③ `/user/:uid` 又没有来源（直接深链打开别人的主页）→ 兜底为**首页**：
 *      这一页与首页是同一个组件、语义上就是「某人的主页」，而且触屏药丸自身
 *      在无解时本来就回落到首项，取首页能让四处导航面结论一致；
 *   ④ 其余情况（例如首次直接打开 /playlist/:id）→ -1，不高亮。
 *
 * @param pathname    当前路由路径
 * @param lastNavPath 最近一次归属明确的路径（appStore.lastNavPath），可为空
 */
export function navIndexForPath(pathname: string, lastNavPath?: string | null): number {
  const direct = ownNavIndex(pathname);
  if (direct >= 0) return direct;
  if (lastNavPath) {
    const from = ownNavIndex(lastNavPath);
    if (from >= 0) return from;
  }
  // ③ 别人的主页：无来源时按「首页」处理（见上面说明）
  if (pathname.startsWith("/user/")) return HOME_INDEX;
  return -1;
}
