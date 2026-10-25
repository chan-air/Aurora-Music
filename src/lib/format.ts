/** 秒 -> mm:ss */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** 数字 -> 中文计数（万 / 亿） */
export function formatCount(n: number | undefined | null): string {
  const v = n ?? 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, "")} 亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, "")} 万`;
  return String(v);
}

/** 秒 -> 全时长（mm:ss 或 h:mm:ss） */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
