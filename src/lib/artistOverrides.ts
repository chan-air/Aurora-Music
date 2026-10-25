import { useSyncExternalStore } from "react";
import { getSongOverride } from "@/lib/storage";

/**
 * 单曲「歌手」覆盖的显示层。
 *
 * 为什么要有这一层：`SongOverride.artists` 是**用户自己填的**歌手信息，存在单曲覆盖里；
 * 而界面上的 `track.artists` 来自网易云接口。两者必须解耦，否则
 *   · 改了歌手之后，歌曲条 / 锁屏 / 探索页顶部还显示旧值；
 *   · 想让它们更新就得手动 setState 每个组件，容易漏。
 *
 * 所以：**存储只负责存**（`saveSongOverride`，读-改-写 + 写前 `:prev` 备份，不绕过）；
 * 显示统一走 `effectiveArtists()`；再用一个"版本号 + useSyncExternalStore"让所有
 * 显示点在同一刻重渲染。版本号由存储层已有的 `aurora:song-settings-changed` 事件驱动 ——
 * 页面保存、共享导入、删除标记都会触发，不需要各处各写一遍。
 */

/** 存储层在保存/删除单曲设置后派发的事件（见 lib/storage.ts 的 notifySongSettingsChanged） */
const SETTINGS_CHANGED_EVENT = "aurora:song-settings-changed";

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* 单个订阅者出错不影响其它订阅者 */
    }
  });
}

if (typeof window !== "undefined") {
  window.addEventListener(SETTINGS_CHANGED_EVENT, emit);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const getVersion = (): number => version;

/**
 * 把 "A / B / C" 拆成 chip 数组。
 *
 * 分隔符只认**两侧带空白的斜杠**（`A / B`，与 mappers 里的 `join(" / ")` 一致）：
 * 这样 `AC/DC` 这种名字里本身带斜杠的歌手不会被拆开。
 * 会 trim、去空、去重。
 */
export function splitArtistChips(value: string): string[] {
  const s = (value ?? "").trim();
  if (!s) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of s.split(/\s+\/\s+/)) {
    const chip = part.trim();
    if (!chip || seen.has(chip)) continue;
    seen.add(chip);
    out.push(chip);
  }
  return out;
}

/** chip 数组 → 存储用的字符串；空数组 → ""（表示"不自定义，用原歌手"） */
export function joinArtistChips(chips: string[]): string {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of chips) {
    const chip = raw.trim();
    if (!chip || seen.has(chip)) continue;
    seen.add(chip);
    cleaned.push(chip);
  }
  return cleaned.join(" / ");
}

/**
 * 某首歌最终应该显示的歌手文本。
 *
 * 覆盖里填了非空值就用它；否则回退到接口给的原文（`fallback`）。
 * 「清空所有 chip」= 覆盖值为空 = 回到原歌手，而不是把歌手栏留白。
 */
export function effectiveArtists(songId: number, fallback: string): string {
  const custom = getSongOverride(songId)?.artists?.trim();
  return custom ? custom : fallback;
}

/**
 * 组件里用的版本：读 `effectiveArtists`，并在单曲设置变化时自动重渲染。
 * `track` 允许为 null（未播放时）。
 */
export function useEffectiveArtists(track: { id: number; artists: string } | null | undefined): string {
  // 订阅版本号：任何单曲设置变化都会让本组件重算一次
  useSyncExternalStore(subscribe, getVersion, getVersion);
  if (!track) return "";
  return effectiveArtists(track.id, track.artists);
}
