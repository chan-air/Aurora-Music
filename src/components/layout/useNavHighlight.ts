import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAppStore } from "@/stores/appStore";
import { navIndexForOwnPath, navIndexForPath } from "./nav";

/**
 * 四处导航面（触屏药丸 TouchDockNav、合一态左圆 TouchMiniBar、
 * 鼠标端 BottomNav / Sidebar）**共用**的高亮下标。
 *
 * 它做两件事：
 *   1) 返回当前应该高亮的下标 —— 当前路径自己有归属就用它，否则沿用来源那一项
 *      （「从哪来回哪去」，规则全在 nav.ts 的 navIndexForPath 里，这里不重复判断）；
 *   2) 顺手把**归属明确的**当前路径记进 appStore.lastNavPath，作为下一次「无归属页面」
 *      的来源。
 *
 * 为什么记录放在这里、而不是只在「点击导航项」时记录：
 * 来源页面未必是点导航项到的 —— 例如首页的「创建的歌单」标签页（/ 或 /user/:uid）、
 * 从收藏页点进歌单（/favorites）都属于「有归属但不是刚点过导航项」的情况。
 * 只要当前页归属明确就记下来，来源永远是最新的那一个，规则也更简单：
 * 「无归属页 → 最近一个有归属的页」。
 *
 * 只记归属明确的路径：无归属的页（/playlist/:id）不能覆盖来源，
 * 否则从首页进歌单、再点开歌单里的一首歌单，来源就丢了。
 */
export function useNavHighlight(): number {
  const { pathname } = useLocation();
  const lastNavPath = useAppStore((s) => s.lastNavPath);
  const recordNavPath = useAppStore((s) => s.recordNavPath);

  const index = navIndexForPath(pathname, lastNavPath);

  useEffect(() => {
    // 只认「路径自身本来就有归属」的（navIndexForOwnPath，**不是**带来源兜底的 navIndexForPath）——
    // 否则 /user/:uid 这种靠兜底才有下标的页面会被记成来源，来源链就错了
    if (navIndexForOwnPath(pathname) >= 0) recordNavPath(pathname);
  }, [pathname, recordNavPath]);

  return index;
}
