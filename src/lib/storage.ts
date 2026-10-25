import { isTauri } from "./env";
import type { Track } from "./mappers";

/**
 * 本地存储抽象：Tauri 桌面/移动端使用 SQLite（tauri-plugin-sql），
 * Web 端回退到 localStorage —— 保证同一套代码多端可用。
 */

export interface SavedSong {
  songId: number;
  name: string;
  artists: string;
  album: string;
  picUrl: string;
  duration: number;
  addedAt?: number; // 收藏时间
  playedAt?: number; // 播放时间
}

export type FavoriteType = "playlist" | "artist" | "user" | "album";

export interface FavoriteItem {
  type: FavoriteType;
  id: number;
  name: string;
  subtitle: string;
  picUrl: string;
  addedAt: number;
}

interface Db {
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

const SQL_CREATE = `
CREATE TABLE IF NOT EXISTS favorites (
  song_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  artists TEXT,
  album TEXT,
  pic_url TEXT,
  duration INTEGER,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS play_history (
  song_id INTEGER,
  name TEXT NOT NULL,
  artists TEXT,
  album TEXT,
  pic_url TEXT,
  duration INTEGER,
  played_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS favorite_items (
  type TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  subtitle TEXT,
  pic_url TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (type, item_id)
);
CREATE TABLE IF NOT EXISTS song_overrides (
  song_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  artists TEXT,
  instrumental INTEGER,
  lyric_format TEXT,
  lyric_text TEXT,
  audio_name TEXT,
  audio_size INTEGER,
  skip_leading_lines INTEGER,
  translation_shift INTEGER,
  updated_at INTEGER NOT NULL
);
`;

/** 旧库补列（新装时 CREATE TABLE 已包含，重复执行会报错，忽略即可） */
const SQL_MIGRATIONS = [
  "ALTER TABLE song_overrides ADD COLUMN audio_name TEXT",
  "ALTER TABLE song_overrides ADD COLUMN audio_size INTEGER",
  "ALTER TABLE song_overrides ADD COLUMN skip_leading_lines INTEGER",
  "ALTER TABLE song_overrides ADD COLUMN translation_shift INTEGER",
];

let dbPromise: Promise<Db | null> | null = null;

async function loadDb(): Promise<Db | null> {
  if (!isTauri()) return null;
  if (!dbPromise) {
    dbPromise = (async () => {
      const { default: Database } = await import("@tauri-apps/plugin-sql");
      const db = await Database.load("sqlite:aurora_music.db");
      await db.execute(SQL_CREATE);
      for (const sql of SQL_MIGRATIONS) {
        try {
          await db.execute(sql);
        } catch {
          /* 列已存在，忽略 */
        }
      }
      return db as unknown as Db;
    })().catch((e) => {
      console.error("SQLite 初始化失败，回退到内存模式：", e);
      return null;
    });
  }
  return dbPromise;
}

interface FavRow {
  song_id: number;
  name: string;
  artists: string | null;
  album: string | null;
  pic_url: string | null;
  duration: number | null;
  added_at: number;
}

interface HistRow {
  song_id: number;
  name: string;
  artists: string | null;
  album: string | null;
  pic_url: string | null;
  duration: number | null;
  played_at: number;
}

function favRowToSong(r: FavRow): SavedSong {
  return {
    songId: r.song_id,
    name: r.name,
    artists: r.artists ?? "",
    album: r.album ?? "",
    picUrl: r.pic_url ?? "",
    duration: r.duration ?? 0,
    addedAt: r.added_at,
  };
}

function histRowToSong(r: HistRow): SavedSong {
  return {
    songId: r.song_id,
    name: r.name,
    artists: r.artists ?? "",
    album: r.album ?? "",
    picUrl: r.pic_url ?? "",
    duration: r.duration ?? 0,
    playedAt: r.played_at,
  };
}

/* ---------------- 收藏 ---------------- */

export async function getFavorites(): Promise<SavedSong[]> {
  const db = await loadDb();
  if (db) {
    const rows = await db.select<FavRow>(
      "SELECT song_id, name, artists, album, pic_url, duration, added_at FROM favorites ORDER BY added_at DESC",
    );
    return rows.map(favRowToSong);
  }
  // 解析失败只告警、不清空原始数据（收藏是用户资产，丢了没法补）
  return readLocalJsonArray("aurora:favorites") as unknown as SavedSong[];
}

export async function addFavorite(track: Track): Promise<void> {
  const now = Date.now();
  const db = await loadDb();
  if (db) {
    await db.execute(
      "INSERT OR REPLACE INTO favorites (song_id, name, artists, album, pic_url, duration, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [track.id, track.name, track.artists, track.album, track.picUrl, track.duration, now],
    );
    return;
  }
  const list = await getFavorites();
  if (!list.some((s) => s.songId === track.id)) {
    list.unshift({ songId: track.id, name: track.name, artists: track.artists, album: track.album, picUrl: track.picUrl, duration: track.duration, addedAt: now });
    backupLocalRaw("aurora:favorites");
    localStorage.setItem("aurora:favorites", JSON.stringify(list));
  }
}

export async function removeFavorite(songId: number): Promise<void> {
  const db = await loadDb();
  if (db) {
    await db.execute("DELETE FROM favorites WHERE song_id = ?", [songId]);
    return;
  }
  const list = await getFavorites();
  backupLocalRaw("aurora:favorites");
  localStorage.setItem("aurora:favorites", JSON.stringify(list.filter((s) => s.songId !== songId)));
}

export async function isFavorite(songId: number): Promise<boolean> {
  const db = await loadDb();
  if (db) {
    const rows = await db.select<{ c: number }>("SELECT COUNT(*) AS c FROM favorites WHERE song_id = ?", [songId]);
    return Number(rows[0]?.c ?? 0) > 0;
  }
  const list = await getFavorites();
  return list.some((s) => s.songId === songId);
}

/* ---------------- 通用收藏（歌单 / 歌手 / 用户 / 专辑） ---------------- */

interface FavItemRow {
  type: string;
  item_id: number;
  name: string;
  subtitle: string | null;
  pic_url: string | null;
  added_at: number;
}

function favItemRowToItem(r: FavItemRow): FavoriteItem {
  return {
    type: r.type as FavoriteType,
    id: r.item_id,
    name: r.name,
    subtitle: r.subtitle ?? "",
    picUrl: r.pic_url ?? "",
    addedAt: r.added_at,
  };
}

export async function getFavoriteItems(): Promise<FavoriteItem[]> {
  const db = await loadDb();
  if (db) {
    const rows = await db.select<FavItemRow>(
      "SELECT type, item_id, name, subtitle, pic_url, added_at FROM favorite_items ORDER BY added_at DESC",
    );
    return rows.map(favItemRowToItem);
  }
  return readLocalJsonArray("aurora:fav_items") as unknown as FavoriteItem[];
}

export async function addFavoriteItem(item: Omit<FavoriteItem, "addedAt">): Promise<void> {
  const now = Date.now();
  const db = await loadDb();
  if (db) {
    await db.execute(
      "INSERT OR REPLACE INTO favorite_items (type, item_id, name, subtitle, pic_url, added_at) VALUES (?, ?, ?, ?, ?, ?)",
      [item.type, item.id, item.name, item.subtitle, item.picUrl, now],
    );
    return;
  }
  const list = await getFavoriteItems();
  if (!list.some((f) => f.type === item.type && f.id === item.id)) {
    list.unshift({ ...item, addedAt: now });
    backupLocalRaw("aurora:fav_items");
    localStorage.setItem("aurora:fav_items", JSON.stringify(list));
  }
}

export async function removeFavoriteItem(type: FavoriteType, id: number): Promise<void> {
  const db = await loadDb();
  if (db) {
    await db.execute("DELETE FROM favorite_items WHERE type = ? AND item_id = ?", [type, id]);
    return;
  }
  const list = await getFavoriteItems();
  backupLocalRaw("aurora:fav_items");
  localStorage.setItem(
    "aurora:fav_items",
    JSON.stringify(list.filter((f) => !(f.type === type && f.id === id))),
  );
}

export async function isFavoriteItem(type: FavoriteType, id: number): Promise<boolean> {
  const db = await loadDb();
  if (db) {
    const rows = await db.select<{ c: number }>(
      "SELECT COUNT(*) AS c FROM favorite_items WHERE type = ? AND item_id = ?",
      [type, id],
    );
    return Number(rows[0]?.c ?? 0) > 0;
  }
  const list = await getFavoriteItems();
  return list.some((f) => f.type === type && f.id === id);
}

/* ---------------- 歌曲手动覆盖（纯音乐标记 / 手写歌词） ---------------- */

export type LyricFormat = "lrc" | "qrc" | "ttml";

/** 「跳过前 N 行」的取值上限（含） */
export const SKIP_LEADING_LINES_MAX = 50;
/** 「翻译偏移 N 行」的取值上限（含），负数 = 提前 */
export const TRANSLATION_SHIFT_MAX = 20;

/** 把任意输入夹进 [min, max] 的整数；非有限数一律当 fallback */
function clampInt(v: unknown, min: number, max: number, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export interface SongOverride {
  songId: number;
  name: string;
  artists: string;
  /** true = 纯音乐，false = 有歌词，null = 未标记（按歌词内容自动判定） */
  instrumental: boolean | null;
  lyricFormat: LyricFormat;
  /** 手动添加的歌词原文，空字符串表示未添加 */
  lyricText: string;
  /** 已替换的本地音频文件名（音频本体存在 IndexedDB），空字符串表示未替换 */
  audioName: string;
  /** 已替换音频的字节数 */
  audioSize: number;
  /**
   * 歌词显示设置一：**开头不显示的行数**（0..50，默认 0）。
   * 只影响"显示哪几行"，**不改动任何行的时间戳**。
   */
  skipLeadingLines: number;
  /**
   * 歌词显示设置二：**翻译整体偏移几行**（-20..20，默认 0）。
   * 第 i 行原文显示 `tlyric[i + shift]`：正数 = 翻译推迟，负数 = 提前；越界即没有翻译。
   */
  translationShift: number;
  updatedAt: number;
}

/** 内存缓存：歌词加载与渲染是同步路径，必须能同步取到覆盖信息 */
let overrideCache: SongOverride[] = [];

/**
 * 通知「歌曲设置已变化」。开启共享时由 lib/share.ts 监听并重新发布，
 * 用事件解耦，避免 storage 反向依赖 share 形成循环引用。
 * 事件名与 lib/share.ts 的 SONG_SETTINGS_CHANGED 保持一致。
 */
function notifySongSettingsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("aurora:song-settings-changed"));
}

interface OverrideRow {
  song_id: number;
  name: string;
  artists: string | null;
  instrumental: number | null;
  lyric_format: string | null;
  lyric_text: string | null;
  audio_name: string | null;
  audio_size: number | null;
  skip_leading_lines: number | null;
  translation_shift: number | null;
  updated_at: number;
}

function rowToOverride(r: OverrideRow): SongOverride {
  return {
    songId: r.song_id,
    name: r.name,
    artists: r.artists ?? "",
    instrumental:
      r.instrumental === null || r.instrumental === undefined
        ? null
        : Number(r.instrumental) === 1,
    lyricFormat: (r.lyric_format as LyricFormat) || "lrc",
    lyricText: r.lyric_text ?? "",
    audioName: r.audio_name ?? "",
    audioSize: r.audio_size ?? 0,
    // 旧记录没有这两列：null/undefined 一律当 0（= 不裁剪、不偏移）
    skipLeadingLines: clampInt(r.skip_leading_lines ?? 0, 0, SKIP_LEADING_LINES_MAX),
    translationShift: clampInt(r.translation_shift ?? 0, -TRANSLATION_SHIFT_MAX, TRANSLATION_SHIFT_MAX),
    updatedAt: r.updated_at,
  };
}

/**
 * 网页端（localStorage）记录的规范化。
 *
 * ── 这里曾经是一个**数据损坏**级别的坑，务必看清 ──────────────────────────
 * localStorage 里存的是**驼峰**字段（songId / lyricFormat / lyricText…），
 * 而 `rowToOverride` 读的是 SQLite 的**下划线**列名（song_id / lyric_format…）。
 * 曾经在 localStorage 分支里误用了 rowToOverride，于是每条记录都被读成
 * `{songId: undefined, name: undefined, …}` —— 界面上就是"旧数据全没了"，
 * 而再保存一次还会把这种垃圾记录写回数组。
 *
 * 所以：**两条存储的规范化函数必须分开**。这个函数只认驼峰字段、补齐缺省，
 * 不认识的字段原样保留（向前兼容），读不动的记录也不会被丢掉。
 */
function normalizeWebOverride(raw: unknown): SongOverride | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown> & { songId?: unknown };
  const songId = Number(o.songId);
  if (!Number.isFinite(songId)) {
    // 连 id 都没有：无法归位到某首歌。**保留原始数据**，只在内存里跳过。
    console.warn("[storage] 单曲设置里有一条记录缺少 songId，已跳过（原始数据未改动）：", o);
    return null;
  }
  return {
    ...(o as unknown as SongOverride),
    songId,
    name: typeof o.name === "string" ? o.name : "",
    artists: typeof o.artists === "string" ? o.artists : "",
    instrumental: o.instrumental === true ? true : o.instrumental === false ? false : null,
    lyricFormat: (o.lyricFormat as LyricFormat) || "lrc",
    lyricText: typeof o.lyricText === "string" ? o.lyricText : "",
    audioName: typeof o.audioName === "string" ? o.audioName : "",
    audioSize: Number.isFinite(Number(o.audioSize)) ? Number(o.audioSize) : 0,
    // 老记录没有这两个字段：补 0（= 不裁剪、不偏移），其它内容一个字都不动
    skipLeadingLines: clampInt(o.skipLeadingLines ?? 0, 0, SKIP_LEADING_LINES_MAX),
    translationShift: clampInt(
      o.translationShift ?? 0,
      -TRANSLATION_SHIFT_MAX,
      TRANSLATION_SHIFT_MAX,
    ),
    updatedAt: Number.isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : 0,
  };
}

/**
 * 读一个"JSON 数组"型的 localStorage 键。
 *
 * 解析失败时**绝不覆盖、绝不删除原始串**（那是用户唯一的一份数据），
 * 只告警并当空处理 —— 下一次写入才会读-改-写这个键。
 */
function readLocalJsonArray(key: string): unknown[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed;
    console.warn(`[storage] ${key} 不是数组，已按空处理（原始数据保留）：`, typeof parsed);
    return [];
  } catch (err) {
    console.warn(`[storage] ${key} 解析失败，已按空处理；原始字符串原样保留，未被清空：`, err);
    return [];
  }
}

/**
 * 覆盖写一个 localStorage 键之前，把**旧值**原样留一份到 `<key>:prev`。
 *
 * 永久保险：以后任何一次误写（时序、并发、代码 bug）都还能从上一版找回来。
 * 只留一份（每次覆盖前刷新），不会无限增长；旧值不存在时不写。
 */
function backupLocalRaw(key: string): void {
  try {
    const prev = localStorage.getItem(key);
    if (prev === null) return;
    localStorage.setItem(`${key}:prev`, prev);
  } catch (err) {
    console.warn(`[storage] 备份 ${key} 失败（不影响本次写入）：`, err);
  }
}

/** 某条原始记录是否属于这首歌（兼容驼峰与下划线两种字段名） */
function sameSong(raw: unknown, songId: number): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  const id = Number(o.songId ?? o.song_id);
  return Number.isFinite(id) && id === songId;
}

/* ---------------- 导入：校验 + 批量安全合并 ---------------- */

/** 合法的 songId：必须是**数字类型**的正整数（字符串 / 负数 / 小数一律判无效） */
function isValidSongId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * 把一条「导入来的」原始记录规范化。
 *
 * · `songId` 不合法 → 返回 null，调用方跳过并计数（**不抛异常**）；
 * · 未知字段**原样保留**（`...raw` 先铺开，再用规范化后的已知字段覆盖）——
 *   将来新增的字段不会在导入时被洗掉；
 * · 已知字段按现有规则处理：instrumental 三态、lyricFormat 非法回落 lrc、
 *   两个显示设置夹取、字符串字段类型不对就置空。
 */
export function normalizeImportedOverride(raw: unknown): SongOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isValidSongId(o.songId)) return null;
  const fmt = o.lyricFormat;
  return {
    ...(o as Partial<SongOverride>), // 未知字段（如 someFutureField）保留
    songId: o.songId,
    name: typeof o.name === "string" ? o.name : "",
    artists: typeof o.artists === "string" ? o.artists : "",
    instrumental: o.instrumental === true ? true : o.instrumental === false ? false : null,
    lyricFormat: fmt === "lrc" || fmt === "qrc" || fmt === "ttml" ? fmt : "lrc",
    lyricText: typeof o.lyricText === "string" ? o.lyricText : "",
    audioName: typeof o.audioName === "string" ? o.audioName : "",
    audioSize: Number.isFinite(Number(o.audioSize)) ? Math.max(0, Math.round(Number(o.audioSize))) : 0,
    skipLeadingLines: clampInt(o.skipLeadingLines ?? 0, 0, SKIP_LEADING_LINES_MAX),
    translationShift: clampInt(
      o.translationShift ?? 0,
      -TRANSLATION_SHIFT_MAX,
      TRANSLATION_SHIFT_MAX,
    ),
    updatedAt: Number.isFinite(Number(o.updatedAt)) ? Math.max(0, Number(o.updatedAt)) : 0,
  };
}

export interface OverrideMergeResult {
  /** 本机没有、这次新增的条数 */
  added: number;
  /** 本机有、且导入的记录更新，被覆盖的条数 */
  updated: number;
  /** 较旧 / 同新 / 重复而没写的条数（不含解析阶段判无效的） */
  skipped: number;
}

/**
 * **批量安全合并写**（导入歌曲设置用）。
 *
 * 合并规则（按 songId）：
 *   · 本机没有 → 新增；
 *   · 本机有 → 只有导入那条 `updatedAt` **更新**才覆盖；一样新（或更旧）就用本机。
 *
 * 为什么单独做一个批量函数：
 *   · 一次读 → 合并 → **一次写** → 更新缓存 → 通知，不会在循环里做 N 次全表写；
 *   · 写前照例把旧值存到 `aurora:song_overrides:prev`（网页端）；
 *   · 网页端以**存储里的最新内容**为准合并（不依赖内存缓存），并保留本机那些
 *     "连 songId 都没有"的原始脏记录 —— 绝不因为一次导入把它们抹掉。
 */
export async function saveSongOverridesBatch(
  incoming: SongOverride[],
): Promise<OverrideMergeResult> {
  const result: OverrideMergeResult = { added: 0, updated: 0, skipped: 0 };
  if (!incoming.length) return result;

  // 同一批里重复 songId：只留 updatedAt 较新的那条，其余计入 skipped
  const byId = new Map<number, SongOverride>();
  for (const rec of incoming) {
    const prev = byId.get(rec.songId);
    if (!prev) {
      byId.set(rec.songId, rec);
      continue;
    }
    if (rec.updatedAt > prev.updatedAt) byId.set(rec.songId, rec);
    result.skipped += 1;
  }
  const records = [...byId.values()];

  const db = await loadDb();
  if (db) {
    const rows = await db.select<OverrideRow>(
      "SELECT song_id, name, artists, instrumental, lyric_format, lyric_text, audio_name, audio_size, skip_leading_lines, translation_shift, updated_at FROM song_overrides",
    );
    const localById = new Map<number, SongOverride>();
    for (const r of rows) localById.set(r.song_id, rowToOverride(r));

    const apply: SongOverride[] = [];
    for (const rec of records) {
      const local = localById.get(rec.songId);
      if (!local) {
        result.added += 1;
        apply.push(rec);
      } else if (rec.updatedAt > local.updatedAt) {
        result.updated += 1;
        apply.push(rec);
      } else {
        result.skipped += 1;
      }
    }
    if (apply.length) {
      // 一条语句批量写入：原子，且只有一次"全表"级别的写
      const rowSql = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
      const sql =
        "INSERT OR REPLACE INTO song_overrides (song_id, name, artists, instrumental, lyric_format, lyric_text, audio_name, audio_size, skip_leading_lines, translation_shift, updated_at) " +
        `VALUES ${apply.map(() => rowSql).join(", ")}`;
      const params: (string | number | null)[] = [];
      for (const r of apply) {
        params.push(
          r.songId,
          r.name,
          r.artists,
          r.instrumental === null ? null : r.instrumental ? 1 : 0,
          r.lyricFormat,
          r.lyricText,
          r.audioName,
          r.audioSize,
          r.skipLeadingLines,
          r.translationShift,
          r.updatedAt,
        );
        localById.set(r.songId, r);
      }
      await db.execute(sql, params);
      overrideCache = [...localById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      notifySongSettingsChanged();
    }
    return result;
  }

  // 网页端：以存储里的最新内容为准
  const currentRaw = readLocalJsonArray("aurora:song_overrides");
  const localRawById = new Map<number, Record<string, unknown>>();
  /** 连 songId 都没有的本机脏记录：原样保留，绝不丢 */
  const unparseable: unknown[] = [];
  for (const raw of currentRaw) {
    if (!raw || typeof raw !== "object") {
      unparseable.push(raw);
      continue;
    }
    const o = raw as Record<string, unknown>;
    const id = Number(o.songId ?? o.song_id);
    if (!Number.isFinite(id)) {
      unparseable.push(raw);
      continue;
    }
    localRawById.set(id, o);
  }

  let dirty = false;
  for (const rec of records) {
    const local = localRawById.get(rec.songId);
    const localUpdatedAt = Number(local?.updatedAt ?? 0);
    if (!local) {
      result.added += 1;
      localRawById.set(rec.songId, rec as unknown as Record<string, unknown>);
      dirty = true;
    } else if (rec.updatedAt > localUpdatedAt) {
      result.updated += 1;
      localRawById.set(rec.songId, rec as unknown as Record<string, unknown>);
      dirty = true;
    } else {
      result.skipped += 1;
    }
  }

  if (dirty) {
    backupLocalRaw("aurora:song_overrides"); // 写前留旧值（导入前的内容在 :prev 里）
    const merged = [...unparseable, ...localRawById.values()].sort((a, b) => {
      const ua = Number((a as Record<string, unknown>)?.updatedAt ?? 0);
      const ub = Number((b as Record<string, unknown>)?.updatedAt ?? 0);
      return ub - ua;
    });
    localStorage.setItem("aurora:song_overrides", JSON.stringify(merged));
    overrideCache = merged
      .map(normalizeWebOverride)
      .filter((o): o is SongOverride => o !== null);
    notifySongSettingsChanged();
  }
  return result;
}

/**
 * 只同步「替换音频的元数据」（audioName / audioSize），其它字段与 `updatedAt` 保持不动。
 *
 * 导入 ZIP 时用：包里的音频解出来之后，实际文件名/字节数可能与 JSON 里记的不完全一样，
 * 这里按实际值校正。**不动 updatedAt** —— 否则一次导入会把所有歌的"更新时间"刷成现在，
 * 之后正常的"较新优先"合并就全乱了。
 */
export async function syncOverrideAudioMeta(
  entries: { songId: number; audioName: string; audioSize: number }[],
): Promise<void> {
  if (!entries.length) return;
  const byId = new Map(entries.map((e) => [e.songId, e]));

  const db = await loadDb();
  if (db) {
    const rows = await db.select<OverrideRow>(
      "SELECT song_id, name, artists, instrumental, lyric_format, lyric_text, audio_name, audio_size, skip_leading_lines, translation_shift, updated_at FROM song_overrides",
    );
    const changed: SongOverride[] = [];
    for (const r of rows) {
      const e = byId.get(r.song_id);
      if (!e) continue;
      if (r.audio_name === e.audioName && Number(r.audio_size ?? 0) === e.audioSize) continue;
      changed.push({ ...rowToOverride(r), audioName: e.audioName, audioSize: e.audioSize });
    }
    if (changed.length) {
      const rowSql = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
      const sql =
        "INSERT OR REPLACE INTO song_overrides (song_id, name, artists, instrumental, lyric_format, lyric_text, audio_name, audio_size, skip_leading_lines, translation_shift, updated_at) " +
        `VALUES ${changed.map(() => rowSql).join(", ")}`;
      const params: (string | number | null)[] = [];
      for (const r of changed) {
        params.push(
          r.songId, r.name, r.artists,
          r.instrumental === null ? null : r.instrumental ? 1 : 0,
          r.lyricFormat, r.lyricText, r.audioName, r.audioSize,
          r.skipLeadingLines, r.translationShift, r.updatedAt,
        );
      }
      await db.execute(sql, params);
      overrideCache = overrideCache.map((o) => byId.has(o.songId)
        ? { ...o, audioName: byId.get(o.songId)!.audioName, audioSize: byId.get(o.songId)!.audioSize }
        : o);
      notifySongSettingsChanged();
    }
    return;
  }

  // 网页端：一次读 → 改这几个字段 → 一次写
  const current = readLocalJsonArray("aurora:song_overrides");
  let changed = 0;
  const next = current.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const o = raw as Record<string, unknown>;
    const id = Number(o.songId ?? o.song_id);
    const e = Number.isFinite(id) ? byId.get(id) : undefined;
    if (!e) return raw;
    if (o.audioName === e.audioName && Number(o.audioSize ?? 0) === e.audioSize) return raw;
    changed += 1;
    return { ...o, audioName: e.audioName, audioSize: e.audioSize }; // updatedAt 原样保留
  });
  if (!changed) return;
  backupLocalRaw("aurora:song_overrides");
  localStorage.setItem("aurora:song_overrides", JSON.stringify(next));
  overrideCache = next
    .map(normalizeWebOverride)
    .filter((o): o is SongOverride => o !== null);
  notifySongSettingsChanged();
}

/** 载入全部覆盖记录到内存缓存（启动时调用一次） */
export async function loadSongOverrides(): Promise<SongOverride[]> {
  const db = await loadDb();
  if (db) {
    const rows = await db.select<OverrideRow>(
      "SELECT song_id, name, artists, instrumental, lyric_format, lyric_text, audio_name, audio_size, skip_leading_lines, translation_shift, updated_at FROM song_overrides ORDER BY updated_at DESC",
    );
    overrideCache = rows.map(rowToOverride);
    return overrideCache;
  }
  // 网页端：驼峰字段，逐条补齐缺省（**不能**走 rowToOverride，见上面的说明）
  overrideCache = readLocalJsonArray("aurora:song_overrides")
    .map(normalizeWebOverride)
    .filter((o): o is SongOverride => o !== null);
  return overrideCache;
}

/** 同步读取某首歌的覆盖记录 */
export function getSongOverride(songId: number): SongOverride | undefined {
  return overrideCache.find((o) => o.songId === songId);
}

/** 同步读取全部覆盖记录（最近更新在前） */
export function getSongOverrides(): SongOverride[] {
  return overrideCache;
}

export async function saveSongOverride(o: Omit<SongOverride, "updatedAt">): Promise<void> {
  const record: SongOverride = {
    ...o,
    // 统一夹取，UI 之外（共享导入、脚本）传进来的值也不会越界
    skipLeadingLines: clampInt(o.skipLeadingLines ?? 0, 0, SKIP_LEADING_LINES_MAX),
    translationShift: clampInt(o.translationShift ?? 0, -TRANSLATION_SHIFT_MAX, TRANSLATION_SHIFT_MAX),
    updatedAt: Date.now(),
  };
  const db = await loadDb();
  if (db) {
    await db.execute(
      "INSERT OR REPLACE INTO song_overrides (song_id, name, artists, instrumental, lyric_format, lyric_text, audio_name, audio_size, skip_leading_lines, translation_shift, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        record.songId,
        record.name,
        record.artists,
        record.instrumental === null ? null : record.instrumental ? 1 : 0,
        record.lyricFormat,
        record.lyricText,
        record.audioName,
        record.audioSize,
        record.skipLeadingLines,
        record.translationShift,
        record.updatedAt,
      ],
    );
  } else {
    /*
     * 网页端：**从存储里重新读一份再合并**，绝不依赖"调用前已经 load 过"。
     *
     * 之前的写法是 `overrideCache.filter(...)` 算"其余记录"，于是只要有人
     * 在 `loadSongOverrides()` 完成之前保存（新增的编辑器非常容易造成这种时序），
     * overrideCache 就是空数组 → 其余记录全没了 → **整张表被这一条替换**。
     * 这就是"旧数据没了"的根因，写路径必须自给自足。
     */
    const current = readLocalJsonArray("aurora:song_overrides");
    backupLocalRaw("aurora:song_overrides");
    const merged = [record, ...current.filter((x) => !sameSong(x, record.songId))];
    localStorage.setItem("aurora:song_overrides", JSON.stringify(merged));
    overrideCache = merged.map(normalizeWebOverride).filter((o): o is SongOverride => o !== null);
    notifySongSettingsChanged();
    return;
  }
  overrideCache = [record, ...overrideCache.filter((x) => x.songId !== record.songId)];
  notifySongSettingsChanged();
}

export async function deleteSongOverride(songId: number): Promise<void> {
  const db = await loadDb();
  if (db) {
    await db.execute("DELETE FROM song_overrides WHERE song_id = ?", [songId]);
  } else {
    // 同样：以存储里的最新内容为准，而不是内存缓存
    const current = readLocalJsonArray("aurora:song_overrides");
    backupLocalRaw("aurora:song_overrides");
    const kept = current.filter((x) => !sameSong(x, songId));
    localStorage.setItem("aurora:song_overrides", JSON.stringify(kept));
    overrideCache = kept.map(normalizeWebOverride).filter((o): o is SongOverride => o !== null);
    notifySongSettingsChanged();
    return;
  }
  overrideCache = overrideCache.filter((x) => x.songId !== songId);
  notifySongSettingsChanged();
}

/* ---------------- 播放历史 ---------------- */

export async function addHistory(track: Track): Promise<void> {
  const now = Date.now();
  const db = await loadDb();
  if (db) {
    await db.execute(
      "INSERT INTO play_history (song_id, name, artists, album, pic_url, duration, played_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [track.id, track.name, track.artists, track.album, track.picUrl, track.duration, now],
    );
    // 只保留最近 500 条
    await db.execute(
      "DELETE FROM play_history WHERE played_at NOT IN (SELECT played_at FROM play_history ORDER BY played_at DESC LIMIT 500)",
    );
    return;
  }
  const list = readLocalJsonArray("aurora:history") as unknown as SavedSong[];
  list.unshift({ songId: track.id, name: track.name, artists: track.artists, album: track.album, picUrl: track.picUrl, duration: track.duration, playedAt: now });
  backupLocalRaw("aurora:history");
  localStorage.setItem("aurora:history", JSON.stringify(list.slice(0, 500)));
}

export async function getHistory(limit = 100): Promise<SavedSong[]> {
  const db = await loadDb();
  if (db) {
    const rows = await db.select<HistRow>(
      "SELECT song_id, name, artists, album, pic_url, duration, played_at FROM play_history ORDER BY played_at DESC LIMIT ?",
      [limit],
    );
    return rows.map(histRowToSong);
  }
  const list = readLocalJsonArray("aurora:history") as unknown as SavedSong[];
  return list.slice(0, limit);
}

export async function clearHistory(): Promise<void> {
  const db = await loadDb();
  if (db) {
    await db.execute("DELETE FROM play_history");
    return;
  }
  localStorage.removeItem("aurora:history");
}

/* ---------------- 通用键值 / 设置 / 播放器状态 ---------------- */

async function kvGet(key: string): Promise<string | null> {
  const db = await loadDb();
  if (db) {
    const rows = await db.select<{ value: string }>(
      "SELECT value FROM kv_store WHERE key = ?",
      [key],
    );
    return rows[0]?.value ?? null;
  }
  return localStorage.getItem(`aurora:kv:${key}`);
}

async function kvSet(key: string, value: string): Promise<void> {
  const db = await loadDb();
  if (db) {
    await db.execute("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)", [key, value]);
    return;
  }
  localStorage.setItem(`aurora:kv:${key}`, value);
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const raw = await kvGet("settings");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function saveSettings(settings: Record<string, unknown>): Promise<void> {
  await kvSet("settings", JSON.stringify(settings));
}

/* ---------------- 设备状态分档设置（触屏/鼠标 × 横屏/竖屏） ---------------- */

export async function getScopedSettings(scope: string): Promise<Record<string, unknown>> {
  const raw = await kvGet(`settings_${scope}`);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // 只告警、不删除：下一次写入会覆盖它，但在那之前原始串仍然可读/可人工抢救
    console.warn(`[storage] settings_${scope} 解析失败，已按空处理（原始值保留）：`, err);
    return {};
  }
}

export async function saveScopedSettings(
  scope: string,
  data: Record<string, unknown>,
): Promise<void> {
  await kvSet(`settings_${scope}`, JSON.stringify(data));
}

export interface PlayerStateSnapshot {
  queue: Track[];
  currentIndex: number;
  current: Track | null;
  volume: number;
}

export async function getPlayerState(): Promise<PlayerStateSnapshot | null> {
  const raw = await kvGet("player_state");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PlayerStateSnapshot;
  } catch (err) {
    console.warn("[storage] player_state 解析失败，已按空处理（原始值保留）：", err);
    return null;
  }
}

export async function savePlayerState(state: PlayerStateSnapshot): Promise<void> {
  await kvSet("player_state", JSON.stringify(state));
}
