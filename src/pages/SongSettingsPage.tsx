import { useEffect, useRef, useState } from "react";
import { Check, Download, FileText, Loader2, Plus, RotateCcw, Search, Trash2, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePlayerStore } from "@/stores/playerStore";
import { clearPreloadedAudio } from "@/stores/playerStore";
import { netease } from "@/lib/netease";
import { mapSongToTrack, type Track } from "@/lib/mappers";
import { deleteLocalAudio, getLocalAudio, invalidateLocalAudioUrl, putLocalAudio, putLocalAudioBlob } from "@/lib/audioStore";
import {
  deleteSongOverride,
  getSongOverride,
  getSongOverrides,
  normalizeImportedOverride,
  saveSongOverride,
  saveSongOverridesBatch,
  syncOverrideAudioMeta,
  SKIP_LEADING_LINES_MAX,
  TRANSLATION_SHIFT_MAX,
  type LyricFormat,
  type SongOverride,
} from "@/lib/storage";
import { LYRIC_DISPLAY_CHANGED_EVENT } from "@/lib/lyrics";
import { joinArtistChips, splitArtistChips } from "@/lib/artistOverrides";
import { buildStoreZip, looksLikeZip, readZip, type ZipEntryInput } from "@/lib/zip";
import { useAppStore } from "@/stores/appStore";

/* ---------------- 导出歌曲设置 ---------------- */

/**
 * 导出用的单条记录。
 *
 * **字段与顺序都对齐 `song-settings-backup.json`**（将来要能被导入路径识别）：
 * songId / name / artists / instrumental / lyricFormat / lyricText /
 * audioName / audioSize / skipLeadingLines / translationShift / updatedAt。
 *
 * 注意：`audioName` / `audioSize` 只是**元数据**，音频字节本身在 IndexedDB 里，
 * 这里不导出（体积大，也不该塞进一个 JSON）。
 */
function overrideToExportRecord(o: SongOverride) {
  return {
    songId: o.songId,
    name: o.name,
    artists: o.artists,
    instrumental: o.instrumental,
    lyricFormat: o.lyricFormat,
    lyricText: o.lyricText,
    audioName: o.audioName ?? "",
    audioSize: o.audioSize ?? 0,
    skipLeadingLines: o.skipLeadingLines ?? 0,
    translationShift: o.translationShift ?? 0,
    updatedAt: o.updatedAt,
  };
}

/**
 * 本地日期时间（不是 UTC）：导出文件名用。
 *
 * - 用**本地**时间，跨时区时不会差一天；
 * - 精确到**秒**（`YYYY-MM-DD_HH-mm-ss`）：同一天里连着导出几次不会互相覆盖，
 *   按文件名排序也等于按导出先后排序；
 * - 时间部分用 `-` 而不是 `:` —— Windows 文件名不允许冒号。
 */
function localDateTimeStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${date}_${time}`;
}

/** 从 audioName 里取扩展名（ZIP 内 `audio/<songId>.<ext>` 用）；取不到用 bin */
function audioExtFromName(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec((name || "").trim());
  return m ? m[1].toLowerCase() : "bin";
}

/** 通知正在打开的歌词页刷新（覆盖信息变了） */
function notifyChanged() {
  window.dispatchEvent(new Event("song-overrides-changed"));
}

/**
 * 只通知「歌词显示设置变了」。
 *
 * 与 notifyChanged 分开是有意的：那个表示"歌词正文变了"，会触发重新拉取 + 重新解析；
 * 而跳过前 N 行 / 翻译偏移只是**显示**层面的后处理，手里的歌词原样可用 ——
 * 所以只派发这个轻量事件，沉浸页立刻重画，不重新请求、不重置播放位置。
 */
function notifyDisplayChanged() {
  window.dispatchEvent(new Event(LYRIC_DISPLAY_CHANGED_EVENT));
}

/** 数字步进器：自带上下限、可直接输入、"归零"按钮 */
function NumberStepper({
  value,
  min,
  max,
  onChange,
  step = 1,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  const btn =
    "h-7 w-7 shrink-0 rounded-md border text-sm leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40";
  return (
    <div className="flex items-center gap-1">
      <button type="button" className={btn} disabled={value <= min} onClick={() => onChange(clamp(value - step))} aria-label="减小">
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(clamp(v));
        }}
        onBlur={(e) => {
          const v = Number(e.target.value);
          onChange(clamp(Number.isFinite(v) ? v : 0));
        }}
        className="h-7 w-14 rounded-md border border-input bg-transparent px-1 text-center text-xs tabular-nums shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <button type="button" className={btn} disabled={value >= max} onClick={() => onChange(clamp(value + step))} aria-label="增大">
        ＋
      </button>
      <button
        type="button"
        className={cn(btn, "w-auto px-2 text-xs")}
        disabled={value === 0}
        onClick={() => onChange(0)}
        title="恢复默认（0）"
      >
        归零
      </button>
    </div>
  );
}

const INSTRUMENTAL_OPTIONS: { value: boolean | null; label: string }[] = [
  { value: null, label: "自动" },
  { value: true, label: "纯音乐" },
  { value: false, label: "有歌词" },
];

/**
 * 歌手 chip 输入框。
 *
 * 交互（按需求逐条对）：
 *  · 输入文字按 **回车** → 变成一枚 chip（右侧 ×，点 × 删除该枚）；
 *  · 空输入回车不添加；重复名字去重（只在末尾提示一下，不弹 toast）；
 *  · **中文输入法**：`.isComposing` / composition 期间的 Enter 是"选词确认"，
 *    不能被当成提交（`keyCode === 229` 也一并挡掉，覆盖旧浏览器）；
 *  · **退格**：输入框为空时按一次 → **直接删掉最后一枚 chip**（不是先选中再删）；
 *    输入框有文字时退格只删文字（交给浏览器默认行为，不 preventDefault）。
 */
function ArtistsEditor({
  songId,
  value,
  onSave,
}: {
  songId: number;
  /** 存储里的歌手字符串（"A / B"），空串表示不自定义 */
  value: string;
  onSave: (next: string) => void;
}) {
  const [chips, setChips] = useState<string[]>(() => splitArtistChips(value));
  const [draft, setDraft] = useState("");
  /** 输入法正在组字（compositionstart ~ compositionend） */
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 外部值变了（刷新 / 其它设备共享导入 / 删除标记）时同步
  useEffect(() => {
    setChips(splitArtistChips(value));
  }, [value]);

  const commit = (next: string[]) => {
    setChips(next);
    onSave(joinArtistChips(next));
  };

  const addDraft = () => {
    const text = draft.trim();
    setDraft("");
    if (!text) return; // 空输入回车不添加
    if (chips.includes(text)) return; // 去重：已经有了就只清空输入
    commit([...chips, text]);
  };

  const removeChip = (chip: string) => {
    commit(chips.filter((c) => c !== chip));
  };

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 shadow-sm",
        "focus-within:ring-1 focus-within:ring-ring",
      )}
      // 点空白处也能聚焦到输入框
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      {chips.map((chip) => (
        <span
          key={chip}
          className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground"
        >
          <span className="truncate" title={chip}>
            {chip}
          </span>
          <button
            type="button"
            onClick={() => removeChip(chip)}
            className="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`删除歌手 ${chip}`}
            title={`删除 ${chip}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        data-artists-input={songId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(e) => {
          // 组字期间（含部分浏览器的 keyCode 229）一律不处理，交给输入法
          if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            addDraft();
            return;
          }
          if (e.key === "Backspace" && draft === "" && chips.length > 0) {
            // 输入框为空：第一次退格直接删掉最后一枚 chip
            e.preventDefault();
            commit(chips.slice(0, -1));
            return;
          }
          if (e.key === "Escape") {
            setDraft("");
          }
        }}
        placeholder={chips.length ? "" : "输入歌手后按回车"}
        className="h-6 min-w-[8rem] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

const FORMAT_OPTIONS: { value: LyricFormat; label: string }[] = [
  { value: "lrc", label: "LRC" },
  { value: "qrc", label: "QRC" },
  { value: "ttml", label: "TTML" },
];

interface EditState {
  songId: number;
  name: string;
  artists: string;
  format: LyricFormat;
  text: string;
}

/** 覆盖记录 → 可写回的对象（去掉 updatedAt） */
function toRecord(o: SongOverride): Omit<SongOverride, "updatedAt"> {
  return {
    songId: o.songId,
    name: o.name,
    artists: o.artists,
    instrumental: o.instrumental,
    lyricFormat: o.lyricFormat,
    lyricText: o.lyricText,
    audioName: o.audioName,
    audioSize: o.audioSize,
    skipLeadingLines: o.skipLeadingLines ?? 0,
    translationShift: o.translationShift ?? 0,
  };
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function SongSettingsPage() {
  const current = usePlayerStore((s) => s.current);

  const [items, setItems] = useState<SongOverride[]>(() => [...getSongOverrides()]);
  const [keyword, setKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Track[]>([]);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [notice, setNotice] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const pendingAudioRef = useRef<number | null>(null);
  /** 导入歌曲设置用的隐藏文件选择器 */
  const importFileRef = useRef<HTMLInputElement>(null);

  const refresh = () => setItems([...getSongOverrides()]);

  // 页面挂载时确保缓存已就绪
  useEffect(() => {
    refresh();
  }, []);

  // 启动时覆盖信息是异步载入的，直接进入本页会先渲染空列表；
  // 监听就绪 / 变化事件重新读取
  useEffect(() => {
    const onChanged = () => refresh();
    window.addEventListener("song-overrides-changed", onChanged);
    return () => window.removeEventListener("song-overrides-changed", onChanged);
  }, []);

  /** 新增或更新某首歌的覆盖记录（未提供的字段沿用旧值） */
  const upsert = async (
    songId: number,
    name: string,
    artists: string,
    patch: Partial<
      Pick<
        SongOverride,
        "instrumental" | "lyricFormat" | "lyricText" | "skipLeadingLines" | "translationShift"
      >
    > = {},
    /** 只改了"显示设置"时传 true：不触发重新拉取歌词，只让沉浸页重画 */
    displayOnly = false,
  ) => {
    const prev = getSongOverride(songId);
    await saveSongOverride({
      songId,
      name,
      artists,
      instrumental: patch.instrumental !== undefined ? patch.instrumental : (prev?.instrumental ?? null),
      lyricFormat: patch.lyricFormat ?? prev?.lyricFormat ?? "lrc",
      lyricText: patch.lyricText ?? prev?.lyricText ?? "",
      audioName: prev?.audioName ?? "",
      audioSize: prev?.audioSize ?? 0,
      skipLeadingLines: patch.skipLeadingLines ?? prev?.skipLeadingLines ?? 0,
      translationShift: patch.translationShift ?? prev?.translationShift ?? 0,
    });
    refresh();
    if (displayOnly) notifyDisplayChanged();
    else notifyChanged();
  };

  /** 若这首歌正在播放，替换后立刻换成新音频重载 */
  const reloadIfCurrent = (songId: number) => {
    const st = usePlayerStore.getState();
    if (st.current?.id === songId) st.reload();
  };

  const pickAudio = (songId: number) => {
    pendingAudioRef.current = songId;
    fileRef.current?.click();
  };

  const onAudioChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const songId = pendingAudioRef.current;
    e.target.value = ""; // 允许重复选同一个文件
    pendingAudioRef.current = null;
    if (!file || songId === null) return;

    const result = await putLocalAudio(songId, file);
    invalidateLocalAudioUrl(songId);
    clearPreloadedAudio(songId);
    setNotice(
      result === "session"
        ? "当前环境无法持久化本地音频（IndexedDB 不可用）：本次会话内可以正常播放，刷新页面后会回到在线音源。"
        : "",
    );

    const prev = getSongOverride(songId);
    await saveSongOverride({
      songId,
      name: prev?.name ?? file.name,
      artists: prev?.artists ?? "",
      instrumental: prev?.instrumental ?? null,
      lyricFormat: prev?.lyricFormat ?? "lrc",
      lyricText: prev?.lyricText ?? "",
      audioName: file.name,
      audioSize: file.size,
      skipLeadingLines: prev?.skipLeadingLines ?? 0,
      translationShift: prev?.translationShift ?? 0,
    });
    refresh();
    notifyChanged();
    reloadIfCurrent(songId);
  };

  const restoreAudio = async (songId: number) => {
    await deleteLocalAudio(songId);
    invalidateLocalAudioUrl(songId);
    clearPreloadedAudio(songId);
    const prev = getSongOverride(songId);
    if (!prev) return;
    await saveSongOverride({ ...toRecord(prev), audioName: "", audioSize: 0 });
    refresh();
    notifyChanged();
    reloadIfCurrent(songId);
  };

  const remove = async (songId: number) => {
    await deleteSongOverride(songId);
    refresh();
    notifyChanged();
  };

  /**
   * 一键导出：一个 **ZIP** 包，里面是
   *   · `song-settings.json`（11 字段数组，与旧版纯 JSON 完全一致）
   *   · `audio/<songId>.<扩展名>`（每首有替换音频的歌一个文件）
   *
   * ZIP 用本地最小 STORE 打包器（`lib/zip.ts`）：不压缩（音频本身已压缩），
   * 正确写 CRC32 / 本地头 / 中央目录 / EOCD，且用 `BlobPart[]` 拼装避免内存翻倍。
   * 取不到音频字节的（IndexedDB 里没有）跳过并计数。
   */
  const exportSettings = async () => {
    const toast = (msg: string) => useAppStore.getState().showToast(msg);
    const list = getSongOverrides();
    if (list.length === 0) {
      toast("本机还没有任何歌曲设置，先添加几首再导出");
      return;
    }
    const rows = [...list].sort((a, b) => a.songId - b.songId).map(overrideToExportRecord);

    const entries: ZipEntryInput[] = [
      {
        name: "song-settings.json",
        data: new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }),
      },
    ];
    let audioPacked = 0;
    let audioMissing = 0;
    for (const r of rows) {
      if (!r.audioName) continue;
      const rec = await getLocalAudio(r.songId).catch(() => null);
      if (!rec?.blob || rec.blob.size === 0) {
        audioMissing += 1;
        continue;
      }
      entries.push({ name: `audio/${r.songId}.${audioExtFromName(r.audioName)}`, data: rec.blob });
      audioPacked += 1;
    }

    let zip: Blob;
    try {
      zip = await buildStoreZip(entries);
    } catch (err) {
      console.warn("[song-settings] 打包 ZIP 失败", err);
      toast("打包失败，请重试");
      return;
    }

    const url = URL.createObjectURL(zip);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aurora-song-settings-${localDateTimeStamp()}.zip`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 在部分浏览器上会让下载还没开始读就失效，延后一点更稳
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(
      `已导出 ${rows.length} 首歌曲的设置（含 ${audioPacked} 个音频文件` +
        (audioMissing ? `；${audioMissing} 个音频缺失已跳过` : "") +
        "）",
    );
  };

  /**
   * 导入：接受 **ZIP**（新格式）与旧版纯 **JSON**（兼容）。
   *
   * 失败路径一律"零写入"：
   *   · 读不出文件 / 不是 ZIP 也不是 JSON / ZIP 损坏（含 CRC 不符）/ 缺 song-settings.json
   *     / 顶层不是数组 / 空数组 —— 都只提示，不碰本机数据；
   *   · 单条坏数据只跳过并计数，绝不中止整次导入。
   *
   * 合并规则见 `saveSongOverridesBatch`（较新优先、一次读→一次写、写前 `:prev`）。
   * 音频属于"文件"，不参与较新优先：包里有就恢复进 IndexedDB，并把 audioName/audioSize
   * 校正为实际值（不改 updatedAt）。
   */
  const importSettingsFromFile = async (file: File) => {
    const toast = (msg: string) => useAppStore.getState().showToast(msg);

    const isZip = await looksLikeZip(file).catch(() => false);
    let jsonText: string | null = null;
    const audioEntries: { songId: number; name: string; blob: Blob }[] = [];
    const packagedAudioIds = new Set<number>();

    if (isZip) {
      const parsed = await readZip(file);
      if (!parsed.ok) {
        toast(`无法读取这个 ZIP：${parsed.message}`);
        return;
      }
      // 任何一条解压/CRC 不通过都当成"坏包"：零写入
      const bad = parsed.entries.find((e) => !e.ok);
      if (bad) {
        toast(`ZIP 包已损坏（${bad.name}：${bad.error ?? "校验失败"}），未导入任何数据`);
        return;
      }
      const jsonEntry = parsed.entries.find(
        (e) => e.name === "song-settings.json" || e.name.endsWith("/song-settings.json"),
      );
      if (!jsonEntry) {
        toast("这个 ZIP 里没有 song-settings.json，未导入任何数据");
        return;
      }
      jsonText = await jsonEntry.data.text();
      for (const e of parsed.entries) {
        const m = /^audio\/(\d+)\.([A-Za-z0-9]+)$/.exec(e.name);
        if (!m) continue;
        const id = Number(m[1]);
        if (!Number.isInteger(id) || id <= 0) continue;
        audioEntries.push({ songId: id, name: `${id}.${m[2]}`, blob: e.data });
        packagedAudioIds.add(id);
      }
    } else {
      try {
        jsonText = await file.text();
      } catch {
        toast("读不出这个文件，请重新选择");
        return;
      }
    }

    let data: unknown;
    try {
      data = JSON.parse(jsonText ?? "");
    } catch {
      // 解析失败：零写入
      toast(isZip ? "ZIP 里的 song-settings.json 不是有效 JSON" : "这个文件不是有效的歌曲设置 JSON");
      return;
    }
    if (!Array.isArray(data)) {
      toast("歌曲设置的顶层不是数组，无法导入");
      return;
    }
    if (data.length === 0) {
      toast("这个文件里没有可导入的记录");
      return;
    }

    // 逐条校验：无效的跳过并计数（songId 必须是正整数）
    const parsedRecords: SongOverride[] = [];
    let invalid = 0;
    for (const raw of data) {
      const rec = normalizeImportedOverride(raw);
      if (rec) parsedRecords.push(rec);
      else invalid += 1;
    }
    if (parsedRecords.length === 0) {
      toast(`没有可导入的记录（${invalid} 条无效）`);
      return;
    }

    // ① 批量安全合并设置（一次读 → 合并 → 一次写 → 刷新缓存 → 通知；写前留 :prev）
    const { added, updated, skipped } = await saveSongOverridesBatch(parsedRecords);

    // ② 恢复音频字节（独立于"较新优先"）
    /*
     * ZIP 里的条目名是 `audio/<songId>.<ext>`（不含原始文件名），所以恢复后要写回的
     * `audioName` 不能直接用条目名：优先用"最终合并后那条记录"的 audioName
     *（本机更新时沿用本机的，否则用导入 JSON 里的），再退到条目名。
     */
    const importedNameById = new Map(parsedRecords.map((r) => [r.songId, r.audioName]));
    let audioRestored = 0;
    let audioSessionOnly = 0;
    let audioFailed = 0;
    const metaFix: { songId: number; audioName: string; audioSize: number }[] = [];
    for (const a of audioEntries) {
      try {
        const storedName =
          getSongOverride(a.songId)?.audioName?.trim() ||
          importedNameById.get(a.songId)?.trim() ||
          a.name;
        const res = await putLocalAudioBlob(a.songId, a.blob, storedName, a.blob.type);
        invalidateLocalAudioUrl(a.songId);
        clearPreloadedAudio(a.songId);
        if (res === "session") audioSessionOnly += 1;
        else audioRestored += 1;
        metaFix.push({ songId: a.songId, audioName: storedName, audioSize: a.blob.size });
      } catch {
        audioFailed += 1;
      }
    }
    if (metaFix.length) await syncOverrideAudioMeta(metaFix);

    // ③ 记录"You 标了替换音频、但包里没有这个音频文件"的条数（**保留记录**，只提示）
    const missingAudio = parsedRecords.filter(
      (r) => r.audioName && !packagedAudioIds.has(r.songId),
    ).length;

    refresh();
    // 覆盖信息变了：让歌词页 / 锁屏 / 歌手显示等重新读取
    notifyChanged();
    notifyDisplayChanged();

    const skippedTotal = skipped + invalid;
    toast(
      `新增 ${added} 首 / 更新 ${updated} 首 / 跳过 ${skippedTotal} 首 / 音频 ${
        audioRestored + audioSessionOnly
      } 个`,
    );
    const bits: string[] = [];
    if (audioFailed) bits.push(`${audioFailed} 个音频写入失败`);
    if (audioSessionOnly) bits.push(`${audioSessionOnly} 个音频仅本次会话有效（存储不可用）`);
    if (missingAudio) bits.push(`${missingAudio} 首缺少音频文件（记录已保留，需要重新选择音频）`);
    setNotice(
      `导入完成：新增 ${added} 首 / 更新 ${updated} 首 / 跳过 ${skippedTotal} 首 / 音频 ${
        audioRestored + audioSessionOnly
      } 个。` +
        (bits.length ? ` ${bits.join("；")}。` : "") +
        "（下次启动只会清掉「指向不存在文件」的音频标记，其余设置保留。）",
    );
  };

  const doSearch = async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    try {
      const res = await netease.searchSongs(kw, 20, 0);
      setResults((res.result?.songs ?? []).map(mapSongToTrack));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const saveEditing = async () => {
    if (!editing) return;
    await upsert(editing.songId, editing.name, editing.artists, {
      lyricFormat: editing.format,
      lyricText: editing.text,
    });
    setEditing(null);
  };

  /** 编辑弹窗里改显示设置：立即保存 + 立即生效，不关弹窗 */
  const patchDisplay = async (songId: number, patch: { skipLeadingLines?: number; translationShift?: number }) => {
    const o = getSongOverride(songId);
    if (!o) return;
    await upsert(o.songId, o.name, o.artists, patch, true);
  };

  /**
   * 保存某首歌的歌手（chip 编辑器回调）。
   *
   * 走 `upsert` → `saveSongOverride`（读-改-写，写前留 `:prev`），不绕过安全写路径。
   * `displayOnly=true`：歌手只是显示信息，**不需要重新拉歌词**；
   * 但 `saveSongOverride` 仍会派发 `aurora:song-settings-changed`，
   * 显示层（歌曲条 / 锁屏 / 探索页）靠它自动重渲染。
   */
  const saveArtists = async (songId: number, nextArtists: string) => {
    const o = getSongOverride(songId);
    if (!o) return;
    await upsert(o.songId, o.name, nextArtists, {}, true);
  };

  const editingOverride = editing ? getSongOverride(editing.songId) : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">歌曲设置</h1>
        {notice && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            {notice}
          </div>
        )}

        <p className="mt-1 text-sm text-muted-foreground">
          手动标记歌曲是否为纯音乐、为某首歌补充 LRC / QRC / TTML 歌词，
          <br />
          或<span className="text-foreground">用本地音频文件替换在线音源</span>（替换后播放这首歌会用你的文件）。
          <br />
          <span className="text-muted-foreground/80">
            未标记的歌曲按歌词内容自动判定（出现「纯音乐，请欣赏」即视为纯音乐）。
          </span>
        </p>
      </div>

      {/* 添加歌曲 */}
      <Card>
        <CardHeader>
          <CardTitle>添加歌曲</CardTitle>
          <CardDescription>搜索歌曲加入手动标记列表</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doSearch();
              }}
              placeholder="搜索歌曲名 / 歌手…"
              className="min-w-[200px] flex-1"
            />
            <Button onClick={() => void doSearch()} disabled={searching}>
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              <span className="ml-1.5">搜索</span>
            </Button>
            {current && (
              <Button
                variant="secondary"
                onClick={() =>
                  void upsert(current.id, current.name, current.artists).then(() => setResults([]))
                }
              >
                <Plus className="h-4 w-4" />
                <span className="ml-1.5">当前播放</span>
              </Button>
            )}
          </div>

          {results.length > 0 && (
            <div className="max-h-64 divide-y overflow-y-auto rounded-md border">
              {results.map((t) => {
                const marked = !!getSongOverride(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      void upsert(t.id, t.name, t.artists);
                      setResults([]);
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent"
                  >
                    {t.picUrl ? (
                      <img src={t.picUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="h-8 w-8 shrink-0 rounded bg-muted" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {t.name}
                      <span className="text-muted-foreground"> — {t.artists}</span>
                    </span>
                    {marked ? (
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <Plus className="h-4 w-4 shrink-0 opacity-60" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 已标记列表 */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="min-w-0 space-y-1.5">
            <CardTitle>已标记的歌曲（{items.length}）</CardTitle>
            <CardDescription>「自动」表示按歌词内容自动判定</CardDescription>
          </div>
          {/*
            备份按钮放在卡片标题右侧 —— 不挤进每首歌那一排的编辑按钮中间。
            下面把"包里有什么 / 合并规则"直接写清楚。
          */}
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void exportSettings()}
                title="导出本机全部歌曲设置为 ZIP（含替换音频）"
              >
                <Download className="h-4 w-4" />
                <span>导出歌曲设置</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => importFileRef.current?.click()}
                title="从 ZIP（或旧的 JSON）导入并合并"
              >
                <Upload className="h-4 w-4" />
                <span>导入歌曲设置</span>
              </Button>
            </div>
            <p className="max-w-[17rem] text-right text-[11px] leading-tight text-muted-foreground">
              导出 ZIP：song-settings.json（歌手 / 歌词 / 纯音乐标记 / 歌词显示设置）
              + audio/ 下的替换音频文件。
              <br />
              导入支持 ZIP 与旧的 JSON；按 songId 合并，较新的记录优先，不会用旧数据覆盖新数据。
            </p>
            <input
              ref={importFileRef}
              type="file"
              accept=".zip,application/zip,.json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ""; // 允许重复选同一个文件
                if (f) void importSettingsFromFile(f);
              }}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              还没有手动标记的歌曲，全部按歌词内容自动判定。
            </p>
          )}

          {items.map((o) => (
            <div key={o.songId} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
              <div className="flex min-w-[160px] flex-1 flex-col">
                <span className="truncate text-sm font-medium">{o.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {o.artists || "（使用原歌手）"}
                  {o.lyricText.trim() ? ` · 已手动添加 ${o.lyricFormat.toUpperCase()} 歌词` : ""}
                  {o.skipLeadingLines ? ` · 跳过前 ${o.skipLeadingLines} 行` : ""}
                  {o.translationShift ? ` · 翻译偏移 ${o.translationShift > 0 ? "+" : ""}${o.translationShift}` : ""}
                </span>
                {o.audioName && (
                  <span className="truncate text-xs text-primary/90">
                    已替换音频：{o.audioName}
                    {o.audioSize ? `（${formatSize(o.audioSize)}）` : ""}
                  </span>
                )}
              </div>

              <div className="flex gap-1 rounded-lg bg-muted p-1">
                {INSTRUMENTAL_OPTIONS.map((opt) => (
                  <button
                    key={String(opt.value)}
                    onClick={() => void upsert(o.songId, o.name, o.artists, { instrumental: opt.value })}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs transition-colors",
                      o.instrumental === opt.value
                        ? "bg-background text-foreground shadow"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <Button
                variant="ghost"
                size="icon"
                title="替换音频文件"
                onClick={() => pickAudio(o.songId)}
              >
                <Upload className="h-4 w-4" />
              </Button>
              {o.audioName && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="还原为在线音频"
                  onClick={() => void restoreAudio(o.songId)}
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                title="编辑歌词"
                onClick={() =>
                  setEditing({
                    songId: o.songId,
                    name: o.name,
                    artists: o.artists,
                    format: o.lyricFormat,
                    text: o.lyricText,
                  })
                }
              >
                <FileText className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="删除标记"
                onClick={() => void remove(o.songId)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>

              {/*
                歌手编辑：chip 输入（回车成框、× 删除、空输入退格删最后一枚）。
                保存走既有的 saveSongOverride（读-改-写 + :prev 备份）；
                这里只是"显示信息"，不需要重新拉歌词。
              */}
              <div className="w-full space-y-1 border-t pt-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">歌手</span>
                  <span className="text-[11px] text-muted-foreground/70">
                    回车添加一个；输入框为空时退格删除最后一个；删光表示沿用原歌手
                  </span>
                </div>
                <ArtistsEditor
                  songId={o.songId}
                  value={o.artists ?? ""}
                  onSave={(next) => void saveArtists(o.songId, next)}
                />
              </div>

              {/*
                歌词显示设置：直接改、立即生效。
                改动只走"显示设置变了"那条轻量通路（不重新拉歌词），
                所以正在播放的歌不用切歌、不用刷新就能看到变化。
              */}
              <div className="flex w-full flex-col gap-2 border-t pt-2 sm:flex-row sm:gap-6">
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">开头不显示的行数</div>
                  <NumberStepper
                    value={o.skipLeadingLines ?? 0}
                    min={0}
                    max={SKIP_LEADING_LINES_MAX}
                    onChange={(v) => void upsert(o.songId, o.name, o.artists, { skipLeadingLines: v }, true)}
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    把翻译整体推迟/提前几行（正=推迟）
                  </div>
                  <NumberStepper
                    value={o.translationShift ?? 0}
                    min={-TRANSLATION_SHIFT_MAX}
                    max={TRANSLATION_SHIFT_MAX}
                    onChange={(v) => void upsert(o.songId, o.name, o.artists, { translationShift: v }, true)}
                  />
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 替换音频用的隐藏文件选择器 */}
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.flac,.m4a,.wav,.ogg,.aac,.opus,.wma"
        className="hidden"
        onChange={(e) => void onAudioChosen(e)}
      />

      {/* 歌词编辑弹窗 */}
      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>编辑歌词</DialogTitle>
            <DialogDescription>
              {editing?.name}
              {editing?.artists ? ` — ${editing.artists}` : ""}
              。保存后这首歌会优先使用这里的歌词（不再走自动获取）。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>歌词格式</Label>
              <div className="flex gap-1 rounded-lg bg-muted p-1">
                {FORMAT_OPTIONS.map((f) => (
                  <button
                    key={f.value}
                    onClick={() => setEditing((p) => (p ? { ...p, format: f.value } : p))}
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-sm transition-colors",
                      editing?.format === f.value
                        ? "bg-background text-foreground shadow"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>歌词原文</Label>
              <textarea
                value={editing?.text ?? ""}
                onChange={(e) => setEditing((p) => (p ? { ...p, text: e.target.value } : p))}
                rows={12}
                spellCheck={false}
                placeholder="把 LRC / QRC / TTML 原文粘贴到这里…"
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>

            {/*
              歌词显示设置（保存即生效，不需要点"保存"）：
              两项都是对**最终歌词行**的后处理 —— 无论当前用的是 TTML / LRC / 手动歌词，
              也无论是先 LRC 后 TTML 的替换过程，最终都会经过它们。
            */}
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <div className="text-sm font-medium">显示设置（立即生效）</div>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Label className="w-40 shrink-0 text-xs">开头不显示的行数</Label>
                  <NumberStepper
                    value={editingOverride?.skipLeadingLines ?? 0}
                    min={0}
                    max={SKIP_LEADING_LINES_MAX}
                    onChange={(v) => void patchDisplay(editing!.songId, { skipLeadingLines: v })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  从第一行开始不显示几行（0~{SKIP_LEADING_LINES_MAX}）。后面的行**时间不变**。
                </p>
              </div>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Label className="w-40 shrink-0 text-xs">翻译偏移（行）</Label>
                  <NumberStepper
                    value={editingOverride?.translationShift ?? 0}
                    min={-TRANSLATION_SHIFT_MAX}
                    max={TRANSLATION_SHIFT_MAX}
                    onChange={(v) => void patchDisplay(editing!.songId, { translationShift: v })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  把翻译整体推迟/提前几行（正=推迟，范围 −{TRANSLATION_SHIFT_MAX}~{TRANSLATION_SHIFT_MAX}）。
                  第 i 行原文显示第 i+偏移 行的翻译，越界的行就没有翻译。
                </p>
              </div>
            </div>
          </div>

          <Separator />

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setEditing((p) => (p ? { ...p, text: "" } : p))}
            >
              清空
            </Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button onClick={() => void saveEditing()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
