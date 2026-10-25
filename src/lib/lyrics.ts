import {
  parseLrc,
  parseYrc,
  parseQrc,
  parseTTML,
  decryptQrcHex,
} from "@applemusic-like-lyrics/lyric";
import type { LyricLine } from "@applemusic-like-lyrics/core";
import type { LyricResponse } from "@/types/netease";
import { getSongOverride, type LyricFormat } from "@/lib/storage";

/** AMLL TTML 歌词源（镜像站），[NCM_ID] 会替换为网易云歌曲 ID */
const TTML_SOURCE_URL = "https://amlldb.bikonoo.com/ncm-lyrics/{id}.ttml";

/** 网易云歌词顶部常见的元数据行角色关键词（作词 / 作曲 / 编曲…） */
const META_ROLES = new Set([
  "作词", "作曲", "编曲", "制作人", "制作", "混音", "录音", "母带",
  "和声", "监制", "出品", "发行", "吉他", "贝斯", "鼓", "键盘", "弦乐",
  "钢琴", "词曲", "原唱", "翻唱", "演唱", "词", "曲", "作词人", "作曲人",
  "编曲人", "混音师", "录音师", "和声编写", "录音棚", "演奏", "编配",
  "配唱", "企划", "统筹", "封面", "设计", "文案", "翻译", "校对",
  "监制人", "出品人", "发行人",
]);

/** 复合角色词前缀（版权 / 出品 / 录音作品 等），用于识别 YRC 中的版权/制作信息行 */
const META_PREFIXES = [
  "词版权", "曲版权", "版权", "录音作品", "联合出品", "出品", "发行",
  "监制", "制作", "混音", "母带", "编曲", "作曲", "作词", "和声", "配唱",
  "企划", "统筹", "封面", "设计", "文案", "翻译", "校对", "人声", "吉他",
  "贝斯", "鼓", "键盘", "弦乐", "钢琴", "原唱", "翻唱", "演唱", "词曲",
  "演奏", "编配", "乐器", "指挥", "合唱",
];

function lineText(ln: LyricLine): string {
  return ln.words.map((w) => w.word).join("").trim();
}

/** 判断是否为「作词：xxx / 作曲：xxx」这类元数据行 */
function isMetaLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 取第一个分隔符（冒号 / 斜杠 / 空白）前的角色词
  const role = t.split(/[:：/／\s]/, 1)[0].trim();
  if (!role) return false;
  if (META_ROLES.has(role)) return true;
  // 前缀匹配（覆盖「词版权管理方 / 录音作品及MV版权」等复合角色词）
  return META_PREFIXES.some((p) => role.startsWith(p));
}

/** 过滤掉元数据行，避免翻译按行号合并时错位 */
function filterMetaLines(lines: LyricLine[]): LyricLine[] {
  return lines.filter((ln) => !isMetaLine(lineText(ln)));
}

/*
 * 注意：这里**不做任何行尾收束**。
 *
 * 之前为「上一句播完了还整行高亮」加过一套把行尾提前 220ms 的逻辑，
 * 但那是错的方向 —— 需求是「间隔小到放不下间奏三点时，上一句播完后取消高亮、
 * 恢复正常模糊，而高亮行的**位置**仍留在这一句直到下一句开始」，
 * 也就是**视觉状态**问题，不是时间轴问题。提前结束行反而会让高亮提前消失、扫词被截断。
 * 所以时间轴一律保持解析器给的原样，只做下面的合法性清洗。
 */

/**
 * 歌词时间戳清洗：AMLL 对 lines / words / word.ruby 逐项校验，
 * 任一时间戳非有限数、为负、或 startTime > endTime 都会直接抛错崩页面。
 * 歌词来源五花八门（网易 YRC、用户手贴），这里统一兜住，保证交给播放器的数据合法。
 */
function sanitizeLines(lines: LyricLine[]): LyricLine[] {
  const fixTime = (v: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const fixRange = <T extends { startTime: number; endTime: number }>(o: T): T => {
    const start = fixTime(o.startTime);
    const end = fixTime(o.endTime);
    if (start === o.startTime && end === o.endTime && end >= start) return o;
    return { ...o, startTime: start, endTime: Math.max(start, end) };
  };
  return lines.map((ln) => {
    const line = fixRange(ln);
    const words = line.words?.length
      ? line.words.map((w) => {
          const word = fixRange(w);
          const ruby = (w as { ruby?: { startTime: number; endTime: number }[] }).ruby;
          if (Array.isArray(ruby)) {
            (word as { ruby?: unknown }).ruby = ruby.map((r) => fixRange(r));
          }
          return word;
        })
      : line.words;
    return words === line.words ? line : { ...line, words };
  });
}

/** 从新版 /lyric/new 的 yrc 中提取纯 YRC 文本（跳过以 { 开头的 JSON 元数据行） */
function extractYrcText(yrc: string): string {
  return yrc
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("["))
    .join("\n");
}

/** 解析手动添加的歌词文本（LRC / QRC / TTML） */
export function parseManualLyric(text: string, format: LyricFormat): LyricLine[] {
  const t = text.trim();
  if (!t) return [];
  try {
    if (format === "ttml") {
      // 时间轴保持解析器原样（TTML 的 amll:connect-next 语义由解析器自己表达），只过滤元数据 + 清洗
      const parsed = parseTTML(t).lines as unknown as LyricLine[];
      return sanitizeLines(filterMetaLines(parsed));
    }
    if (format === "qrc") {
      // QQ 音乐下载的 QRC 常为十六进制加密串，先按明文解析，失败再解密
      let lines = filterMetaLines(parseQrc(t) as unknown as LyricLine[]);
      if (!lines.length) {
        lines = filterMetaLines(parseQrc(decryptQrcHex(t)) as unknown as LyricLine[]);
      }
      return sanitizeLines(lines);
    }
    // LRC 不动时间轴，交给 AMLL 自己的语义
    return sanitizeLines(filterMetaLines(parseLrc(t) as unknown as LyricLine[]));
  } catch {
    return [];
  }
}

/**
 * 加载歌词，优先级：
 *  0. 用户在「歌曲设置」里手动添加的歌词
 *  1. TTML 镜像源（含逐字与翻译，Apple Music 同款格式）
 *  2. 网易云 YRC（逐字，即 QRC 对应的逐字歌词）+ 翻译
 *  3. 网易云 LRC（行级）+ 翻译
 * 各路径都会过滤「作词 / 作曲」等元数据行。
 *
 * ── 为什么两条源要**并行**取（性能回归的根因在这里） ─────────────────────
 * 之前的写法是 `await fetch(TTML)` 之后才 `await fetchNeteaseLyric()`，也就是
 * **串行**。实测 TTML 镜像（amlldb.bikonoo.com）经常要 1.5~8s 才失败/超时，
 * 于是网易云那条本来 130ms 就能返回的 `/lyric/new` 被硬生生推迟到 TTML 之后 ——
 * 用户看到的就是"点一首歌，歌词要等好几秒"。
 *
 * 现在两条源同时发出，各算各的：
 *   · 谁先给出**可用**结果就先用谁渲染，绝不互相等待（手感不变、不白屏）；
 *   · 若 TTML 先到就用 TTML（质量最高的源），之后网易云的结果**不会**把它换掉；
 *   · 若网易云（YRC/LRC）先到，就先渲染它；**TTML 一旦到达且可用，立刻替换**成 TTML
 *     —— 这是用户要的"升级"语义，替换只换歌词内容，不重置播放位置、不重挂载歌词页。
 *
 * ── 界面怎么知道"该替换了" ──────────────────────────────────────────────
 * 复用项目里既有的通路：`onLyricLinesUpdated` 订阅 + LyricsSheet 的 `setLines`。
 * 只要歌词内容变了，`lines` 就会变，既有的 `[lines]` 副作用会把逐行样式重新同步一遍
 * —— 那条通路本来就是"手动改歌词后重新生效"用的，这里不新造轮子、也不加轮询。
 *
 * ── 失败记账（"整首停在 LRC"的根因） ─────────────────────────────────────
 * TTML 取不到分两种，必须分开记：
 *   · **确定没有**（404/410）→ 负缓存，之后不再打接口；
 *   · **这次没取到**（超时 / 断网 / 5xx / 200 但内容不对）→ 只记一个 12s 短抑制，
 *     绝不写负缓存；而且**正式加载**（这首歌成了当前曲目）会用 force **绕过抑制**，
 *     保证用户真正要看的那首歌永远会再试一次 —— 预加载的失败不该把这首歌钉死在 LRC。
 */

/**
 * 歌词显示设置变化事件。
 *
 * 只调「跳过前 N 行 / 翻译偏移」这两个**显示**设置时派发。与既有的
 * `song-overrides-changed` 区分开：那个表示"歌词正文变了"，会触发重新拉取；
 * 这个只要求"把手里这份歌词重新过一遍显示设置"，不重新请求、不重新解析。
 * 事件名与 SongSettingsPage 里派发的一致。
 */
export const LYRIC_DISPLAY_CHANGED_EVENT = "aurora:lyric-display-changed";

/**
 * 把「单曲显示设置」施加到歌词行上，得到**真正要显示的行**。
 *
 * 它是整条歌词管线最后一道后处理：无论歌词来自 TTML 还是网易云 YRC/LRC、
 * 无论之后有没有被 TTML 替换、有没有被手动编辑，最终都要过这一道
 * （沉浸页 / 锁屏上行 / 其它读歌词的地方都调它）。
 *
 * 两项设置：
 *  - `skipLeadingLines`：开头 N 行不显示。**只丢行，不动任何时间戳** ——
 *    留下那几行的 startTime/endTime 与原来逐字不差，所以"后续行的时机不变"。
 *    边界：取 `min(N, 总行数-1)`，也就是**至少保留一行**（全裁成空会让歌词页
 *    变成"纯黑 + 无内容"，比留着最后一行更难解释）；本来就没有行时返回空。
 *  - `translationShift`：第 i 行原文显示 `tlyric[i + shift]`。正数 = 翻译推迟，
 *    负数 = 提前；越界的那几行**没有翻译**（不回绕）。
 *
 * 该函数是纯的：只可能新建行对象，不会就地改写入参里的行。
 */
export function applyLyricDisplaySettings(songId: number, lines: LyricLine[]): LyricLine[] {
  if (lines.length === 0) return lines;
  const o = getSongOverride(songId);
  const rawSkip = typeof o?.skipLeadingLines === "number" ? o.skipLeadingLines : 0;
  const rawShift = typeof o?.translationShift === "number" ? o.translationShift : 0;
  const skip = Math.min(Math.max(0, Math.round(rawSkip) || 0), Math.max(0, lines.length - 1));
  const shift = Math.round(rawShift) || 0;

  // 翻译偏移：先按当前顺序收集原文对应的翻译文本（保持"原文第 i 行"，与渲染端的行序无关）
  let shifted: (string | undefined)[] | null = null;
  if (shift !== 0) {
    const old = lines.map((ln) =>
      typeof ln.translatedLyric === "string" && ln.translatedLyric.length > 0
        ? ln.translatedLyric
        : undefined,
    );
    shifted = lines.map((_, i) => {
      const src = i + shift;
      return src >= 0 && src < old.length ? old[src] : undefined;
    });
  }

  const visible = skip > 0 ? lines.slice(skip) : lines;
  if (!shifted) return visible;
  const out: LyricLine[] = new Array(visible.length) as LyricLine[];
  for (let i = 0; i < visible.length; i++) {
    const t = shifted[skip + i];
    out[i] = t === undefined ? visible[i] : { ...visible[i], translatedLyric: t };
  }
  return out;
}

/** TTML 结果缓存（**只放"确定的答案"**）：
 *   · 有内容 → 解析好的行
 *   · 服务器明确说没有（404/410）→ null
 * 暂时性失败 / 超时 **绝不写这里**，否则一次网络抖动就会被永久记成"这首歌没有 TTML"，
 * 表现为"概率性加载不出、甚至整首停在 LRC"。
 */
const ttmlCache = new Map<number, LyricLine[] | null>();
/** 曾经成功拿到过 TTML 的 id（用来判断"当前这份是不是 TTML 版"） */
const ttmlUpgraded = new Set<number>();
/** 被判为"确定没有 TTML"（404/410）的 id */
const ttmlConfirmedAbsent = new Set<number>();
/** 同一个 id 的 TTML 请求只发一次（并发去重） */
const ttmlPending = new Map<number, Promise<LyricLine[] | null>>();
/**
 * 网络类失败后的**短抑制窗口**（ms）：窗口内不再重复打同一个 id，
 * 避免同一首歌短时间内疯狂重试；窗口一过就能重新尝试。
 * 注意它不是负缓存 —— 不会让"这首歌没有 TTML"这个结论留下来。
 */
const TTML_NET_SUPPRESS_MS = 12_000;
/** id -> 最近一次网络类失败的时刻 */
const ttmlNetFailedAt = new Map<number, number>();

/* ---------------- TTML 重试参数（写清楚，便于按站点稳定性调整） ---------------- */

/**
 * 单次请求超时（ms）。
 * 那个镜像站实测会拖 1.5~9.8 秒才失败，挂着等太久会把"拿到 TTML"这件事无限推迟，
 * 所以到点就掐掉、立刻进下一次重试。
 */
const TTML_TIMEOUT_MS = 7_000;
/** 最多尝试几次（首次 + 2 次重试） */
const TTML_MAX_ATTEMPTS = 3;
/** 各次重试前的退避（ms）：第 2 次前 400ms，第 3 次前 1000ms */
const TTML_RETRY_DELAYS_MS = [400, 1000];

/**
 * 一次 TTML 尝试的结果：
 *   ok        拿到内容
 *   absent    服务器**明确**回答没有（只有 404/410 算）→ 可以写负缓存
 *   transient 暂时性失败（5xx / 网络错误 / 超时 / 200 但内容不对）→ **绝不写负缓存**
 */
type TtmlAttempt =
  | { kind: "ok"; lines: LyricLine[] }
  | { kind: "absent" }
  | { kind: "transient"; reason: string };

/**
 * 尝试一次 TTML 请求（带超时）。
 *
 * 判定口径（"到底是这首歌没有，还是这次没取到"）：
 *   · **404 / 410 → absent**：这才是"确实没有 TTML"，可以写负缓存、不必重试；
 *   · 其余 4xx      → absent（请求本身有问题，重试也一样）；
 *   · 5xx / 网络错误 / 超时(AbortError) → transient（值得重试）；
 *   · 200 但解析不出任何行（镜像站不稳时会给错误页 / 半截内容）→ **transient**，
 *     绝不能当"这首歌没有 TTML"，否则一旦碰上就永久停在 LRC。
 */
async function attemptTtmlOnce(songId: number): Promise<TtmlAttempt> {
  const url = TTML_SOURCE_URL.replace("{id}", String(songId));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTML_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404 || res.status === 410) return { kind: "absent" };
    if (res.status >= 500) return { kind: "transient", reason: `HTTP ${res.status}` };
    if (!res.ok) return { kind: "absent" };
    const text = await res.text();
    const parsed = parseTTML(text).lines as unknown as LyricLine[];
    // 时间轴保持原样，只过滤元数据行并清洗
    const lines = sanitizeLines(filterMetaLines(parsed));
    if (lines.length === 0) {
      // 200 却没有内容：镜像站不稳时的含糊结果，按"暂时性"处理
      return { kind: "transient", reason: `HTTP 200 但无可解析歌词（${text.length} 字）` };
    }
    return { kind: "ok", lines };
  } catch (err) {
    // AbortError（超时）/ TypeError（断网、连接被断、CORS）都算暂时性失败
    const name = (err as { name?: string })?.name ?? "";
    const reason = name === "AbortError" ? `超时(>${TTML_TIMEOUT_MS}ms)` : name || String(err);
    return { kind: "transient", reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取 TTML 镜像源并解析。
 *
 * @param opts.force 正式加载（这首歌成了当前曲目）时为 true：
 *   **无视预加载留下的失败记账**，永远重新尝试一次。
 *   抑制窗口只该约束"后台反复预加载同一首"，不该拦住用户真正要看的这首歌。
 *
 * 失败语义（"有概率加载不出 TTML"的修复核心）：
 *   · 成功 → 进 ttmlCache；
 *   · 服务器**明确**说没有（404/410）→ 也进 ttmlCache（负缓存），后续不再打接口；
 *   · 暂时性失败（超时 / TypeError / 5xx / 200 但内容不对）→ **不写缓存**，
 *     只记一个 12s 的短抑制窗口，窗口过后（或 force）可以重新尝试。
 */
function fetchTtmlLines(songId: number, opts: { force?: boolean } = {}): Promise<LyricLine[] | null> {
  // 用 has() 判断"有没有确定的答案"：value 为 null 也是有效答案（= 这个 id 没有 TTML）
  if (ttmlCache.has(songId)) return Promise.resolve(ttmlCache.get(songId) ?? null);
  const running = ttmlPending.get(songId);
  if (running) return running;
  // 刚经历过暂时性失败：短窗口内不再重复打（正式加载用 force 绕过）
  const netFailedAt = ttmlNetFailedAt.get(songId);
  if (!opts.force && netFailedAt !== undefined && Date.now() - netFailedAt < TTML_NET_SUPPRESS_MS) {
    return Promise.resolve(null);
  }

  const task = (async (): Promise<LyricLine[] | null> => {
    for (let attempt = 1; attempt <= TTML_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const delay = TTML_RETRY_DELAYS_MS[attempt - 2] ?? 1000;
        console.info(`[lyrics] TTML 第 ${attempt} 次尝试，先退避 ${delay}ms（id=${songId}）`);
        await new Promise((r) => setTimeout(r, delay));
      }
      const result = await attemptTtmlOnce(songId);
      if (result.kind === "ok") {
        if (attempt > 1) {
          console.info(`[lyrics] TTML 第 ${attempt} 次尝试成功（id=${songId}，${result.lines.length} 行）`);
        }
        ttmlCache.set(songId, result.lines);
        ttmlUpgraded.add(songId);
        ttmlConfirmedAbsent.delete(songId);
        ttmlNetFailedAt.delete(songId);
        return result.lines;
      }
      if (result.kind === "absent") {
        // 服务器明确回答"没有"（404/410）：这才是负缓存，之后不再重试
        ttmlCache.set(songId, null);
        ttmlConfirmedAbsent.add(songId);
        ttmlNetFailedAt.delete(songId);
        return null;
      }
      // 暂时性失败：还有次数就继续，否则放弃（**不写负缓存**）
      console.warn(
        `[lyrics] TTML 第 ${attempt}/${TTML_MAX_ATTEMPTS} 次失败（id=${songId}，${result.reason}）`,
      );
    }
    // 三次都失败：只记短抑制，允许以后重新尝试（正式加载会 force 绕过）
    ttmlNetFailedAt.set(songId, Date.now());
    console.warn(
      `[lyrics] TTML 连续 ${TTML_MAX_ATTEMPTS} 次失败（id=${songId}），不写负缓存；` +
        `${TTML_NET_SUPPRESS_MS / 1000}s 内不再后台重试（正式加载会重新尝试）`,
    );
    return null;
  })()
    .catch(() => null)
    .finally(() => {
      ttmlPending.delete(songId);
    });

  ttmlPending.set(songId, task);
  return task;
}
/**
 * 同一个 songId 的整体加载只跑一次。
 * 之前「预加载」与「打开歌词页」会各自触发一条完整链路（两条 TTML + 两条网易云），
 * 既浪费带宽也把连接池占满，这里合并成一条。
 */
const lyricPending = new Map<number, Promise<LyricLine[]>>();
/** 之前失败过的 id：短时间内不再重试（避免 500ms 轮询把它变成每秒两次请求） */
const lyricFailedAt = new Map<number, number>();
/**
 * 「两边都明确没有歌词」的冷却时间（ms）。
 * 只用于**确定的空结果**（TTML 404 / 空壳 + 网易云也没给出行）——
 * 那时重试确实没意义，压久一点免得白打接口。
 */
const RETRY_COOLDOWN_MS = 60_000;
/** 网易云那条**网络失败**后的短抑制窗口（ms）：与 TTML 一样，不能记成"没有歌词" */
const NETEASE_NET_SUPPRESS_MS = 12_000;
/** id -> 最近一次网易云网络失败的时刻 */
const neteaseNetFailedAt = new Map<number, number>();

/**
 * 加载某首歌时顺带创建的「网易云」那条任务（两条源并行的另一半）。
 * 单独抽出来，是为了让"已有 LRC、只补 TTML"的后台重试路径能复用它。
 */
function madeNeteaseTask(fetchNeteaseLyric: () => Promise<LyricResponse>): {
  task: Promise<LyricLine[]>;
  state: { done: boolean; netFailed: boolean };
} {
  const state = { done: false, netFailed: false };
  const task = fetchNeteaseLyric()
    .then((data) => {
      state.done = true;
      return buildNeteaseLines(data);
    })
    .catch(() => {
      state.done = true;
      state.netFailed = true; // 网络类失败：绝不能当成"这首歌没有歌词"
      return [] as LyricLine[];
    });
  return { task, state };
}

/** 把"TTML 到了就替换上屏"的后置钩子挂上（不阻塞、不 await） */
function hookTtmlUpgrade(songId: number, ttmlTask: Promise<LyricLine[] | null>): void {
  void ttmlTask
    .then((ttmlLines) => {
      if (ttmlLines && ttmlLines.length > 0) emitTtmlUpgrade(songId, ttmlLines);
    })
    .catch(() => {});
}

/**
 * True when 这首歌当前**只有非 TTML** 的歌词（LRC / YRC / 手动），
 * 且 TTML 那条还**没有确定的答案**（没成功、也没被 404 明确否掉）。
 *
 * 这正是"整首停在 LRC"的判定：此时应当允许再给 TTML 一次机会。
 */
function ttmlStillUnresolved(songId: number): boolean {
  if (ttmlCache.has(songId)) return false;
  const settled = resolvedLyrics.get(songId);
  if (!settled || settled.length === 0) return false;
  if (ttmlUpgraded.has(songId)) return false;
  return !ttmlConfirmedAbsent.has(songId);
}

/* ---------------- "歌词被升级"的通路 ---------------- */
/**
 * 每首歌当前**已定稿**的歌词（正在界面/预加载里生效的那一份）。
 * 存在的意义：TTML 后到时，界面要能判断"这次替换是不是真有内容变化"。
 */
const resolvedLyrics = new Map<number, LyricLine[]>();
/** 已定稿歌词的条数上限，避免切歌久了无限增长 */
const RESOLVED_MAX = 200;

type LyricUpdateListener = (songId: number, lines: LyricLine[]) => void;
const lyricUpdateListeners = new Set<LyricUpdateListener>();

/**
 * 订阅"某首歌的歌词被换成了更好的版本"。
 *
 * 只在这几种情况触发：TTML 在网易云之后到达并成功解析出内容。
 * 不会因为同一份歌词重复触发（模块内有"已定稿"比对与一次性标记）。
 *
 * @returns 解除订阅的函数
 */
export function onLyricLinesUpdated(listener: LyricUpdateListener): () => void {
  lyricUpdateListeners.add(listener);
  return () => {
    lyricUpdateListeners.delete(listener);
  };
}

/** 取某首歌已定稿的歌词（没加载过返回 undefined） */
export function getResolvedLyrics(songId: number): LyricLine[] | undefined {
  return resolvedLyrics.get(songId);
}

/**
 * 丢掉某首歌已定稿的歌词（传 undefined 清空全部）。
 * 手动改歌词 / 换回默认时由 clearPreloadedLyrics 调用，避免下次直接命中旧内容。
 */
export function forgetResolvedLyrics(songId?: number): void {
  if (songId === undefined) resolvedLyrics.clear();
  else resolvedLyrics.delete(songId);
}

function rememberResolved(songId: number, lines: LyricLine[]): void {
  if (resolvedLyrics.size >= RESOLVED_MAX && !resolvedLyrics.has(songId)) {
    const oldest = resolvedLyrics.keys().next().value;
    if (oldest !== undefined) resolvedLyrics.delete(oldest);
  }
  resolvedLyrics.set(songId, lines);
}

/**
 * 把 TTML 结果作为"升级"推给界面。
 *
 * 守卫（缺一不可）：
 *  1. 必须真有内容（空结果不算升级，绝不能用空歌词把正在显示的 LRC 清掉）；
 *  2. 内容与当前已定稿的**不是同一份**（同一首歌只替换一次，不反复触发）；
 *  3. 这首歌**没有**用户手动填写的歌词 —— 手动歌词优先级最高，不允许被自动覆盖
 *     （用户可能在加载途中刚填好，所以这里每次都现查）。
 */
function emitTtmlUpgrade(songId: number, ttmlLines: LyricLine[]): void {
  if (ttmlLines.length === 0) return;                    // 空结果不算升级，绝不把正在显示的 LRC 清掉
  if (resolvedLyrics.get(songId) === ttmlLines) return;  // 同一份内容不重复广播（一首只替换一次）
  const override = getSongOverride(songId);
  if (override?.lyricText?.trim()) {
    // 用户手写了歌词：不替换、不广播 —— 手动歌词永远压过镜像源
    return;
  }
  rememberResolved(songId, ttmlLines);
  lyricUpdateListeners.forEach((fn) => {
    try {
      fn(songId, ttmlLines);
    } catch (err) {
      // 单个订阅者出错不能影响其它订阅者，但也别静默
      console.warn("[lyrics] 歌词升级订阅者出错：", err);
    }
  });
}

/**
 * 真正干活的加载流程（不做去重，只被 loadLyricLines 调一次）。
 *
 * @returns lines，以及"这个空结果是不是确定的"（决定要不要进长冷却）
 */
async function loadLyricLinesUncached(
  songId: number,
  fetchNeteaseLyric: () => Promise<LyricResponse>,
  opts: { force?: boolean } = {},
): Promise<{ lines: LyricLine[]; definitive: boolean }> {
  let neteaseNetFailed = false;
  // 两条源同时出发：谁先能用就用谁先渲染
  const ttmlTask = fetchTtmlLines(songId, opts);
  let neteaseDone = false;
  const neteaseTask = fetchNeteaseLyric()
    .then((data) => {
      neteaseDone = true;
      return buildNeteaseLines(data);
    })
    .catch(() => {
      neteaseDone = true;
      neteaseNetFailed = true; // 网络类失败：绝不能当成"这首歌没有歌词"
      return [] as LyricLine[];
    });

  // ① TTML 先回来 → 直接用它（此后网易云的结果不会把它换掉）
  const ttmlFirst = await Promise.race([
    ttmlTask.then((lines) => (lines ? lines : null)),
    neteaseTask.then(() => null),
  ]);
  if (ttmlFirst) {
    rememberResolved(songId, ttmlFirst);
    // 网易云那条仍在飞：让它自己落地即可，这里不再等（也不覆盖已定稿的 TTML）
    void neteaseTask.catch(() => []);
    return { lines: ttmlFirst, definitive: true };
  }

  // ② 网易云先回来 → 先用它渲染；同时**挂上"TTML 到了就升级"的监听**
  const neteaseLines = await neteaseTask;
  if (neteaseLines.length > 0) {
    rememberResolved(songId, neteaseLines);
    /*
     * 关键：不去 await 慢的 TTML，只挂一个后置钩子。
     * 这样"首屏有歌词"的速度不变（网易云 ~130ms），而 TTML 一到就立刻替换上屏。
     */
    void ttmlTask
      .then((ttmlLines) => {
        if (ttmlLines && ttmlLines.length > 0) emitTtmlUpgrade(songId, ttmlLines);
      })
      .catch(() => {});
    return { lines: neteaseLines, definitive: true };
  }

  // ③ 网易云没给出行（纯音乐 / 接口失败）：再给 TTML 一次机会
  if (!neteaseDone) {
    const ttmlAfter = await ttmlTask;
    if (ttmlAfter && ttmlAfter.length > 0) {
      rememberResolved(songId, ttmlAfter);
      return { lines: ttmlAfter, definitive: true };
    }
  }

  /*
   * 两边都没行。只有"服务器明确说没有"才算确定的空结果（可进长冷却）；
   * 网络失败只进短抑制窗口，允许稍后再试一次。
   */
  const ttmlAnswered = ttmlCache.has(songId); // 只有成功或"明确没有"才会进这张表
  const definitive = !neteaseNetFailed && ttmlAnswered;
  return { lines: [], definitive };
}

/**
 * @param opts.force 见 fetchTtmlLines 的说明：正式加载（这首歌成了当前曲目）时传 true，
 *   无视预加载留下的"暂时性失败"记账，永远重新尝试一次 TTML。
 */
export function loadLyricLines(
  songId: number,
  fetchNeteaseLyric: () => Promise<LyricResponse>,
  opts: { force?: boolean } = {},
): Promise<LyricLine[]> {
  // 0) 手动添加的歌词优先（同步读缓存，不参与去重）
  const override = getSongOverride(songId);
  if (override?.lyricText?.trim()) {
    const manual = parseManualLyric(override.lyricText, override.lyricFormat);
    if (manual.length) {
      rememberResolved(songId, manual);
      return Promise.resolve(manual);
    }
  }

  /*
   * 确定"没有歌词"的冷却期内：直接给空结果，不再重复打网络。
   * force（正式加载）时也绕过它 —— 用户切到这首歌，就该重新确认一次。
   */
  const failedAt = lyricFailedAt.get(songId);
  if (!opts.force && failedAt !== undefined && Date.now() - failedAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve([]);
  }
  // 网易云刚网络失败过：短窗口内不重复打（窗口一过就能重试）；已定稿的先给出去
  const ncFailedAt = neteaseNetFailedAt.get(songId);
  if (!opts.force && ncFailedAt !== undefined && Date.now() - ncFailedAt < NETEASE_NET_SUPPRESS_MS) {
    return Promise.resolve(resolvedLyrics.get(songId) ?? []);
  }

  const running = lyricPending.get(songId);
  if (running) return running;

  /*
   * 已经定稿过：把那一份给出去（不闪、不重新请求）。
   *
   * 但**正式加载**（force）时还要多做一件事：如果这份定稿只是 LRC，而 TTML 那条
   * 从来没有过确定答案（上一次可能超时/失败/被预加载的抑制窗口挡住），就**在后台
   * 再试一次 TTML**。这里照样立刻返回手里的 LRC（绝不空屏），拿到 TTML 后会通过
   * 升级广播替换上屏 —— 这就是"整首停在 LRC"的修复点。
   */
  const settled = resolvedLyrics.get(songId);
  if (settled) {
    if (opts.force && ttmlStillUnresolved(songId)) {
      hookTtmlUpgrade(songId, fetchTtmlLines(songId, { force: true }));
    }
    return Promise.resolve(settled);
  }

  const task = loadLyricLinesUncached(songId, fetchNeteaseLyric, opts)
    .then(({ lines, definitive }) => {
      /*
       * 只有"确定的空结果"才进长冷却；
       * 网络类失败（definitive=false）什么都不记，下次加载/预加载可以再试。
       */
      if (lines.length === 0 && definitive) lyricFailedAt.set(songId, Date.now());
      else if (lines.length > 0) lyricFailedAt.delete(songId);
      return lines;
    })
    .catch(() => {
      // 整条链路异常：只记短抑制窗口，允许稍后再试（绝不当成"没有歌词"）
      neteaseNetFailedAt.set(songId, Date.now());
      return [] as LyricLine[];
    })
    .finally(() => {
      lyricPending.delete(songId);
    });

  lyricPending.set(songId, task);
  return task;
}

/** 网易云歌词：优先 YRC（逐字），回退 LRC（行级），再合并翻译 */
function buildNeteaseLines(data: LyricResponse | null | undefined): LyricLine[] {
  const yrc = data?.yrc?.lyric?.trim();
  const lrc = data?.lrc?.lyric?.trim();

  let lines: LyricLine[];
  if (yrc) {
    // /lyric/new 的 yrc 是「JSON 元数据行 + YRC 文本行」混合，先提取纯 YRC 文本
    lines = filterMetaLines(parseYrc(extractYrcText(yrc)) as unknown as LyricLine[]);
  } else if (lrc) {
    lines = filterMetaLines(parseLrc(lrc) as unknown as LyricLine[]);
  } else {
    return [];
  }

  const tlyric = data?.tlyric?.lyric?.trim();
  if (tlyric) {
    const tl = filterMetaLines(parseLrc(tlyric) as unknown as LyricLine[]);
    for (let i = 0; i < lines.length; i++) {
      const t = tl[i];
      if (t && t.words.length) {
        lines[i].translatedLyric = lineText(t);
      }
    }
  }
  // LRC / YRC 不动时间轴（此前误加过行尾收束，已按需求移除），只做时间戳清洗
  return sanitizeLines(lines);
}

/** 判断歌词是否为空，或为「纯音乐，请欣赏」之类的占位文案 */
export function isLyricsEmpty(lines: LyricLine[]): boolean {
  if (!lines.length) return true;
  const text = lines.map(lineText).join(" ").trim();
  if (!text) return true;
  // 只要出现「纯音乐」（含「纯音乐，请欣赏」）就判定为纯音乐，不限行数
  if (/纯音乐/.test(text)) return true;
  // 其余占位文案仅在歌词极短时判定，避免误伤正常歌词
  if (lines.length <= 2 && /无歌词|敬请欣赏|纯演奏|instrumental/i.test(text)) return true;
  return false;
}

/**
 * 综合判断某首歌是否「没有歌词」：
 * 手动标记优先（标记为纯音乐 / 标记为有歌词），未标记的按歌词内容自动判定。
 */
export function resolveNoLyrics(songId: number, lines: LyricLine[]): boolean {
  const override = getSongOverride(songId);
  if (override) {
    if (override.instrumental === true) return true;
    if (override.instrumental === false) return false;
  }
  return isLyricsEmpty(lines);
}
