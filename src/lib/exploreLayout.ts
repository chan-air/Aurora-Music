/**
 * 歌曲探索 · 确定性排列算法（纯函数模块）
 *
 * 这个文件**不碰 React、不碰 DOM、不用 Math.random / Date.now / 网络**。
 * 只要传入的 (songs, colors) 一样，输出就逐字节一样。
 *
 * ── 种子只来自「歌集合」，与歌单 id / 歌单名无关 ─────────────────────
 * 种子 = FNV-1a(排序后的 songId 列表)。同一组歌放进不同歌单、且**输入顺序相同**，
 * 排出来的「歌曲 id 序列」完全一致；playlistId 参数只为兼容调用方保留。
 *
 * 相关性里包含「原列表位置」项，因此**同一组歌但原始顺序不同**时允许布局不同；
 * 只要输入顺序相同，输出仍逐字节一致（不依赖时间 / 随机 / 网络）。
 *
 * ── 相关性优先级（越近越相关）──────────────────────────────────────
 *   1) 同一张专辑：**硬分隔**。专辑不同就 +1.0，比其余四项加起来还大，
 *      因此同专辑的歌一定比跨专辑的歌更近（除非整组歌都没有专辑信息）。
 *   2) 同一 / 相近艺人：档内权重 0.34（艺人字符串规范化；多艺人做 token 重叠）。
 *   3) 原列表位置邻近：档内权重 0.24（|indexA-indexB| / (n-1)）。
 *   4) 封面主色：档内权重 0.20（色相环形距离 × 饱和度 + 明度差）。
 *   5) 时长：档内权重 0.12（只做弱 tie-breaker）。
 *   档内四项合计 0.90 < 1.0，保证「同专辑」严格优于「跨专辑」。
 *
 * 位置项让同一张歌单的原始顺序参与相关性；因此**同一组歌但原始顺序不同**时
 * 允许布局不同。只要输入顺序也相同，输出仍逐字节一致（见确定性测试）。
 *
 * 数据里没有流派 / 风格字段，所以**用艺人 + 专辑作为风格代理**：
 * 同一艺人 / 同一张专辑通常就是相近风格；汇报里也按这个口径说明，不假装有流派。
 *
 * ── 颜色取不到怎么办 ─────────────────────────────────────────────
 * 颜色是**显式输入**：页面先取完色，再把颜色表传进来；缺失项在特征里记 [0,0,0]。
 * 因此不会出现「一边取色一边排、网络快慢改变顺序」；同一颜色表 → 同一顺序。
 */

/** 参与布局的歌曲信息（页面把 Track 映射成这个结构再传进来） */
export interface ExploreSong {
  id: number;
  /** 时长（秒）；0 / 非法值按 0 处理 */
  duration: number;
  /** 完整艺人串（通常用 " / " 连接多个艺人）；缺失 = 未知 */
  artists?: string;
  /** 专辑名；缺失 = 未知 */
  album?: string;
  /** 专辑 id；>0 时优先用它判断「同一张专辑」 */
  albumId?: number;
}

/** 封面平均色 / 主色 / 次色（0..255），由 lib/glassTone 的取色管线产出 */
export interface ExploreColorRgb {
  r: number;
  g: number;
  b: number;
}

export interface ExploreHsl {
  /** 0..1 的环 */
  h: number;
  s: number;
  l: number;
}

export interface ExploreColor extends ExploreColorRgb {
  /** 占比最高的颜色（旧版颜色表没有这三项时按平均色回退） */
  dominant?: ExploreColorRgb & ExploreHsl;
  /** 占比第二高的颜色；单色封面等于 dominant */
  secondary?: ExploreColorRgb & ExploreHsl;
  /** 颜色均差 0..1（见 coverColor 取样定义） */
  variance?: number;
  palette?: { r: number; g: number; b: number; ratio: number }[];
}

/** 以歌曲 id 为键的封面颜色表；null / 缺失都表示取不到 */
export type ExploreColorMap = Record<string, ExploreColor | null | undefined>;

/** 归一化后的歌曲特征，供调试与测试读取 */
export interface ExploreFeature {
  /** 原歌曲数组下标 */
  songIndex: number;
  songId: number;
  /** 0..1，整个歌单内 min-max 归一化 */
  duration: number;
  /** 0..1 的 RGB，缺失时为 [0,0,0] */
  color: [number, number, number];
  hasColor: boolean;
  /** 主色 HSL（0..1） */
  dominantHue: number;
  dominantSaturation: number;
  dominantLightness: number;
  /** 次色 HSL（0..1）；没有次色时等于主色 */
  secondaryHue: number;
  secondarySaturation: number;
  secondaryLightness: number;
  /** 颜色均差 0..1 */
  colorVariance: number;
  /** 0..1 的色相（×360 得角度）、饱和度、明度 */
  hue: number;
  saturation: number;
  lightness: number;
  /** >0 时优先用它判断同一张专辑 */
  albumId: number;
  /** 规范化后的专辑名（空串 = 未知） */
  albumName: string;
  /** 规范化后的艺人串（多个艺人用 " / " 连接；空串 = 未知） */
  artist: string;
  /** 艺人 token（已去重、去空格），用于「艺人相近」 */
  artistTokens: string[];
  /**
   * 原列表位置，0..1（songIndex / (n-1)）。
   * 它让「原歌单里相邻」成为相关性的一部分；同一输入顺序下完全确定。
   */
  position: number;
}

/** 一首歌在单位格网格里的位置 */
export interface ExplorePlacement {
  /** 原歌曲数组下标 */
  songIndex: number;
  /** 探索顺序下标（0 开始，与 ExploreLayout.order 同序） */
  orderIndex: number;
  col: number;
  row: number;
  /** 只允许 1 或 2：1×1 或 2×2 */
  span: 1 | 2;
}

/** 算法输出 */
export interface ExploreLayout {
  /** 标准化后的歌曲集合标识（升序 songId 逗号拼接，可用来验证"同歌不同歌单"） */
  songSetId: string;
  /** 原数组下标组成的探索顺序 */
  order: number[];
  /** 与 order 同序的歌曲 id —— 跨歌单比较时看这个最直接 */
  orderSongIds: number[];
  /** 与 order 同序的格位 */
  placements: ExplorePlacement[];
  /** 网格宽（单位格） */
  cols: number;
  /** 网格高（单位格） */
  rows: number;
  /** 默认选中：原数组下标 */
  selectedIndex: number;
  /** 默认选中：探索顺序下标 */
  selectedOrder: number;
  /** 默认选中：歌曲 id（同歌不同歌单时保持一致） */
  selectedSongId: number | null;
  /** 实际使用的特征（按原歌曲数组顺序），方便测试 / 性能面板核对 */
  features: ExploreFeature[];
}

/** 高度分布（3D 用）：selected 为 1，越远越接近 FLOOR，连续无台阶 */
export interface ExploreHeight {
  orderIndex: number;
  /** 与选中块中心在单位格上的欧氏距离 */
  distance: number;
  /** 0.055..1，选中项恒为 1 */
  height: number;
}

/**
 * 专辑「硬分隔」：专辑不同加 1.0。
 * 档内四项合计 0.90 < 1.0，因此同专辑永远比跨专辑近。
 */
export const EXPLORE_ALBUM_DIFF = 1;
/** 档内：同一 / 相近艺人的权重（强） */
export const EXPLORE_ARTIST_WEIGHT = 0.34;
/** 档内：原列表位置邻近度的权重（较强；同歌单顺序参与布局） */
export const EXPLORE_POSITION_WEIGHT = 0.24;
/** 档内：封面主色（色相 + 明度）的权重（中） */
export const EXPLORE_COLOR_WEIGHT = 0.2;
/** 档内：时长的权重（弱，只做 tie-breaker） */
export const EXPLORE_DURATION_WEIGHT = 0.12;

/** 2×2 的目标占比：约 8%（1×1:2×2 ≈ 11.5:1）；只分配给常听/收藏候选 */
const BIG_RATIO = 0.08;
/** 3D 高度下限（离得很远的块仍保留一点厚度，不会变成纸片） */
const HEIGHT_FLOOR = 0.055;
/** mapper 在艺人缺失时写的占位串 */
const UNKNOWN_ARTIST = "未知歌手";

export interface ExploreLayoutOptions {
  /**
   * 允许使用 2×2 的歌曲 id（来自播放历史/收藏）。
   * 缺省为空：所有块 1×1；算法本身不读 localStorage/网络。
   */
  preferredSongIds?: ReadonlySet<number>;
}

/**
 * FNV-1a 32 位字符串哈希。实现写死在这里，不依赖 runtime 的 crypto
 * （不同浏览器 / Node 对 crypto 的可用性不同，写死才能保证跨端一致）。
 */
export function hashExploreSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 歌集合标识：songId 去重后升序拼接。
 * 它只由「有哪些歌」决定，与歌单 id、歌单名、歌曲在歌单里的先后顺序都无关。
 */
export function exploreSongSetId(songs: readonly { id: number }[]): string {
  const ids = Array.from(
    new Set(
      songs.map((song) => {
        const id = Number(song.id);
        return String(Number.isFinite(id) ? Math.trunc(id) : 0);
      }),
    ),
  );
  ids.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  return ids.join(",");
}

/** mulberry32：小巧、确定、跨端一致的 PRNG，仅用来做「由种子决定」的选择 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用同一个歌集合种子派生出互不干扰的子种子（起点 / 尺寸 / 选中 / 2-opt） */
function mixSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul((salt + 0x9e3779b9) | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/* ---------------- 特征归一化 ---------------- */

function normalizeArtistToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[「」『』"'“”‘’()（）[\]【】]/g, "")
    .trim();
}

/** 多艺人串拆分：支持 / , ， 、 & ; ； + ft. feat. with；token 去掉空格与括号 */
const ARTIST_SPLITTER = /\s*(?:\/|,|，|、|&|＆|;|；|\+|＋|\bft\.?|\bfeat\.?|\bwith\b)\s*/i;

function splitArtists(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  const unknown = normalizeArtistToken(UNKNOWN_ARTIST);
  const tokens = text
    .split(ARTIST_SPLITTER)
    .map(normalizeArtistToken)
    .filter(Boolean)
    .filter((token) => token !== unknown);
  return Array.from(new Set(tokens));
}

/** 专辑名规范化：只统一大小写与空白，保留括号等能区分版本的信息 */
function normalizeAlbumName(raw: string | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[\s\u3000]+/g, " ").trim();
}

/** RGB(0..1) -> HSL，h/s/l 都落在 0..1（h 是 0..1 的色相圈） */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

/** 把歌曲映射成归一化特征；颜色缺失一律补 0，保持确定性 */
function buildFeatures(
  songs: readonly ExploreSong[],
  colors: ExploreColorMap,
  originalIndexes: readonly number[],
): ExploreFeature[] {
  const rawDurations = songs.map((song) => {
    const d = Number(song.duration);
    return Number.isFinite(d) && d > 0 ? d : 0;
  });
  let minDuration = rawDurations.length ? rawDurations[0] : 0;
  let maxDuration = minDuration;
  for (const d of rawDurations) {
    if (d < minDuration) minDuration = d;
    if (d > maxDuration) maxDuration = d;
  }
  const durationSpan = maxDuration - minDuration;

  return songs.map((song, i) => {
    const raw = colors[String(song.id)];
    const valid =
      !!raw && Number.isFinite(raw.r) && Number.isFinite(raw.g) && Number.isFinite(raw.b);
    const color: [number, number, number] = valid
      ? [
          clamp01(Number(raw.r) / 255),
          clamp01(Number(raw.g) / 255),
          clamp01(Number(raw.b) / 255),
        ]
      : [0, 0, 0];
    const [hue, saturation, lightness] = rgbToHsl(color[0], color[1], color[2]);
    const dominant = valid ? raw.dominant : undefined;
    const secondary = valid ? raw.secondary : undefined;
    const [dominantHue, dominantSaturation, dominantLightness] = dominant
      ? [dominant.h, dominant.s, dominant.l]
      : [hue, saturation, lightness];
    const [secondaryHue, secondarySaturation, secondaryLightness] = secondary
      ? [secondary.h, secondary.s, secondary.l]
      : [dominantHue, dominantSaturation, dominantLightness];
    const colorVariance = valid
      ? clamp01(Number(raw.variance) || 0)
      : 0;
    const duration =
      durationSpan > 0 ? (rawDurations[i] - minDuration) / durationSpan : 0;
    const artistTokens = splitArtists(song.artists);
    const albumId = Number(song.albumId);
    return {
      songIndex: originalIndexes[i] ?? i,
      songId: Number(song.id),
      duration,
      color,
      hasColor: valid,
      hue,
      saturation,
      lightness,
      dominantHue,
      dominantSaturation,
      dominantLightness,
      secondaryHue,
      secondarySaturation,
      secondaryLightness,
      colorVariance,
      albumId: Number.isFinite(albumId) && albumId > 0 ? albumId : 0,
      albumName: normalizeAlbumName(song.album),
      artist: artistTokens.join(" / "),
      artistTokens,
      position: songs.length > 1 ? (originalIndexes[i] ?? i) / (songs.length - 1) : 0,
    };
  });
}

/** 是否同一张专辑：优先 albumId；拿不到 id 时退回规范化后的专辑名 */
export function exploreIsSameAlbum(a: ExploreFeature, b: ExploreFeature): boolean {
  if (a.albumId > 0 && b.albumId > 0) return a.albumId === b.albumId;
  if (a.albumName && b.albumName) return a.albumName === b.albumName;
  return false;
}

/** 艺人距离：0 = 完全相同，1 = 毫无重叠；未知艺人用中性值，避免被硬凑成一组 */
export function exploreArtistDistance(a: ExploreFeature, b: ExploreFeature): number {
  const left = a.artistTokens;
  const right = b.artistTokens;
  if (left.length === 0 && right.length === 0) return 0.5;
  if (left.length === 0 || right.length === 0) return 0.75;
  if (a.artist === b.artist) return 0;
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of left) {
    if (rightSet.has(token)) intersection++;
  }
  const union = left.length + right.length - intersection;
  return union > 0 ? 1 - intersection / union : 1;
}

/**
 * 封面颜色距离（0..1）：
 *   主色 0.55 + 次色 0.25 + 颜色均差 0.20。
 *   HSL 距离 = 0.55 色相环形差（乘两边的较小饱和度）+ 0.45 明度差；
 *   均差直接取 |variance 差|。没有主/次色的旧颜色表回退为平均色、均差 0。
 */
export function exploreColorDistance(a: ExploreFeature, b: ExploreFeature): number {
  const hslDistance = (
    h1: number,
    s1: number,
    l1: number,
    h2: number,
    s2: number,
    l2: number,
  ): number => {
    let hueDelta = Math.abs(h1 - h2);
    if (hueDelta > 0.5) hueDelta = 1 - hueDelta;
    const hueDistance = hueDelta * 2;
    const chroma = Math.min(s1, s2);
    const lightnessDelta = Math.abs(l1 - l2);
    return clamp01(0.55 * hueDistance * chroma + 0.45 * lightnessDelta);
  };
  const dominant = hslDistance(
    a.dominantHue,
    a.dominantSaturation,
    a.dominantLightness,
    b.dominantHue,
    b.dominantSaturation,
    b.dominantLightness,
  );
  const secondary = hslDistance(
    a.secondaryHue,
    a.secondarySaturation,
    a.secondaryLightness,
    b.secondaryHue,
    b.secondarySaturation,
    b.secondaryLightness,
  );
  const variance = Math.abs(a.colorVariance - b.colorVariance);
  return clamp01(0.55 * dominant + 0.25 * secondary + 0.2 * variance);
}

/**
 * 两首歌曲的相关性距离（0 = 最相关）。测试 / 调试可直接调用。
 *
 *   专辑不同 +1.0，同专辑 +0；
 *   档内：艺人 0.34 + 原列表位置 0.24 + 颜色 0.20 + 时长 0.12
 *   （合计 0.90 < 1.0）。
 *
 * 因此「同专辑但艺人不同」仍然比「跨专辑但艺人相同」更近 —— 用户要求综合，
 * 同时保留专辑作为强分组；位置项让原歌单相邻的歌更容易排在探索顺序的相邻位置。
 */
export function exploreFeatureDistance(a: ExploreFeature, b: ExploreFeature): number {
  const album = exploreIsSameAlbum(a, b) ? 0 : EXPLORE_ALBUM_DIFF;
  const artist = exploreArtistDistance(a, b);
  const color = exploreColorDistance(a, b);
  const duration = Math.abs(a.duration - b.duration);
  const position = Math.abs(a.position - b.position);
  return (
    album +
    EXPLORE_ARTIST_WEIGHT * artist +
    EXPLORE_POSITION_WEIGHT * position +
    EXPLORE_COLOR_WEIGHT * color +
    EXPLORE_DURATION_WEIGHT * duration
  );
}

/* ---------------- 排序 ---------------- */

/** 最近邻链：起点由歌集合种子决定，之后贪心挑最近的未访问项 */
function nearestNeighborChain(features: ExploreFeature[], start: number): number[] {
  const n = features.length;
  const visited = new Uint8Array(n);
  const chain: number[] = [];
  let current = start;
  visited[current] = 1;
  chain.push(current);

  for (let step = 1; step < n; step++) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      const d = exploreFeatureDistance(features[current], features[j]);
      // 并列时固定取较小的规范化下标，避免依赖遍历中的浮点误差
      if (
        d < bestDistance - 1e-12 ||
        (Math.abs(d - bestDistance) <= 1e-12 && (best < 0 || j < best))
      ) {
        bestDistance = d;
        best = j;
      }
    }
    if (best < 0) break;
    visited[best] = 1;
    chain.push(best);
    current = best;
  }
  return chain;
}

/**
 * 2-opt 精修（确定性）：
 *   · 候选边 (i, j) 的检查顺序由歌集合种子打乱——不同歌集合会走到不同的局部最优；
 *     同一歌集合无论歌单 id 是什么都走同一条路径；
 *   · 只接受让总距离严格变小的反转，因此只会让相邻相关性更好；
 *   · 固定末端，避免把链条尾巴翻来翻去造成无意义的变动。
 */
function refineWithTwoOpt(
  order: number[],
  features: ExploreFeature[],
  rand: () => number,
): number[] {
  const n = order.length;
  if (n < 4) return order;

  const pairs: number[] = [];
  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 2; j <= n - 2; j++) pairs.push(i * n + j);
  }
  shuffleInPlace(pairs, rand);

  const maxPasses = n > 500 ? 2 : n > 200 ? 3 : n > 80 ? 4 : 8;
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (const code of pairs) {
      const i = Math.floor(code / n);
      const j = code % n;
      const a = order[i];
      const b = order[i + 1];
      const c = order[j];
      const d = order[j + 1];
      const before =
        exploreFeatureDistance(features[a], features[b]) +
        exploreFeatureDistance(features[c], features[d]);
      const after =
        exploreFeatureDistance(features[a], features[c]) +
        exploreFeatureDistance(features[b], features[d]);
      if (after < before - 1e-12) {
        let lo = i + 1;
        let hi = j;
        while (lo < hi) {
          const tmp = order[lo];
          order[lo] = order[hi];
          order[hi] = tmp;
          lo++;
          hi--;
        }
        improved = true;
      }
    }
    if (!improved) break;
  }
  return order;
}

/* ---------------- 放置 ---------------- */

/** 网格宽度只由歌数推导：大致方形，最多 8 列（手机屏幕再宽也放得下） */
function gridWidthFor(n: number): number {
  if (n <= 4) return 2;
  const raw = Math.sqrt(n * 1.35);
  return Math.max(3, Math.min(8, Math.round(raw)));
}

function placementsOverlap(
  a: { col: number; row: number; span: number },
  b: { col: number; row: number; span: number },
): boolean {
  return (
    a.col < b.col + b.span &&
    b.col < a.col + a.span &&
    a.row < b.row + b.span &&
    b.row < a.row + a.span
  );
}

/**
 * 按顺序依次放置：扫描到第一个空格；标了 2×2 的格子如果右边 / 下边放不下，
 * 就降级成 1×1（绝不留到后面回头补，保证同一顺序得到同一结果）。
 */
function placeBlocks(
  order: number[],
  bigSongs: Set<number>,
  cols: number,
): ExplorePlacement[] {
  const occupied: boolean[][] = [];
  const ensureRow = (row: number) => {
    while (occupied.length <= row) occupied.push(new Array<boolean>(cols).fill(false));
  };
  const isFree = (row: number, col: number): boolean => {
    ensureRow(row);
    return !occupied[row][col];
  };

  const placements: ExplorePlacement[] = [];
  let cursor = 0;

  for (let orderIndex = 0; orderIndex < order.length; orderIndex++) {
    const songIndex = order[orderIndex];
    // 找到从 cursor 起第一个空格
    for (;;) {
      const row = Math.floor(cursor / cols);
      const col = cursor % cols;
      if (isFree(row, col)) break;
      cursor++;
    }
    const row = Math.floor(cursor / cols);
    const col = cursor % cols;

    let span: 1 | 2 = 1;
    const wantBig = bigSongs.has(songIndex);
    if (wantBig && col + 1 < cols) {
      ensureRow(row + 1);
      const canBig =
        isFree(row, col + 1) && isFree(row + 1, col) && isFree(row + 1, col + 1);
      if (canBig) span = 2;
    }

    ensureRow(row + span - 1);
    for (let dr = 0; dr < span; dr++) {
      for (let dc = 0; dc < span; dc++) {
        occupied[row + dr][col + dc] = true;
      }
    }

    placements.push({ songIndex, orderIndex, col, row, span });
    cursor++;
  }

  return placements;
}

/**
 * 主入口：构建一个歌单的探索布局。
 *
 * 注意：**playlistId 不参与任何计算**（只为保持调用签名）。种子只来自歌曲集合，
 * 但距离函数包含原列表位置项，所以同一组歌不同原始顺序允许得到不同布局；
 * 同一输入顺序（同样的歌单）仍逐字节一致。
 *
 * @param playlistId 歌单 id（仅兼容调用方，不参与种子）
 * @param songs      歌曲数组（顺序即原歌单顺序，并参与位置邻近度）
 * @param colors     可选的封面颜色表（键为歌曲 id 字符串）；缺失项按 0 处理
 * @param options    preferredSongIds：允许 2×2 的常听/收藏歌曲；缺省全部 1×1
 */
export function buildExploreLayout(
  playlistId: string | number,
  songs: readonly ExploreSong[],
  colors: ExploreColorMap = {},
  options: ExploreLayoutOptions = {},
): ExploreLayout {
  void playlistId;
  const n = songs.length;

  if (n === 0) {
    return {
      songSetId: "",
      order: [],
      orderSongIds: [],
      placements: [],
      cols: 0,
      rows: 0,
      selectedIndex: -1,
      selectedOrder: -1,
      selectedSongId: null,
      features: [],
    };
  }

  const songSetId = exploreSongSetId(songs);
  const seed = hashExploreSeed(`aurora-explore|songs|${songSetId}`);

  /*
   * 先按 songId 升序做一次规范化。这样「同一组歌、不同歌单、不同原始顺序」
   * 会进入完全相同的计算分支；最后再映射回原数组下标给页面用。
   */
  const entries = songs.map((song, originalIndex) => ({ song, originalIndex }));
  entries.sort((a, b) => {
    const idA = Number(a.song.id);
    const idB = Number(b.song.id);
    if (idA !== idB) return idA - idB;
    return a.originalIndex - b.originalIndex;
  });

  const canonicalFeatures = buildFeatures(
    entries.map((entry) => entry.song),
    colors,
    entries.map((entry) => entry.originalIndex),
  );

  // 1) 起点由「歌集合」种子决定，再走最近邻链
  const startRand = mulberry32(mixSeed(seed, 1));
  const start = Math.floor(startRand() * n) % n;
  const chain = nearestNeighborChain(canonicalFeatures, start);

  // 2) 2-opt 精修（候选顺序也由歌集合种子决定）
  const twoOptRand = mulberry32(mixSeed(seed, 2));
  const canonicalOrder = refineWithTwoOpt(chain, canonicalFeatures, twoOptRand);

  // 3) 「不机械」兜底：最终映射回原数组后，绝不能等于原歌单顺序（除非只有 1 首）
  if (n > 1) {
    let identity = true;
    for (let i = 0; i < n; i++) {
      if (entries[canonicalOrder[i]].originalIndex !== i) {
        identity = false;
        break;
      }
    }
    if (identity) {
      const tmp = canonicalOrder[0];
      canonicalOrder[0] = canonicalOrder[1];
      canonicalOrder[1] = tmp;
    }
  }

  // 4) 尺寸分配：只在常听/收藏候选里，按种子顺序取约 8% 标为 2×2
  const sizeRand = mulberry32(mixSeed(seed, 3));
  const rank = Array.from({ length: n }, (_, i) => i);
  shuffleInPlace(rank, sizeRand);
  const preferred = options.preferredSongIds ?? new Set<number>();
  const preferredIds = new Set<number>();
  for (const id of preferred) {
    const numeric = Number(id);
    if (Number.isFinite(numeric)) preferredIds.add(numeric);
  }
  const candidateOrder = rank
    .map((i) => canonicalOrder[i])
    .filter((ci) => preferredIds.has(Number(entries[ci].song.id)));
  const targetBig = Math.max(1, Math.round(n * BIG_RATIO));
  const bigCount = Math.min(candidateOrder.length, targetBig);
  const bigSongs = new Set<number>();
  for (let i = 0; i < bigCount; i++) bigSongs.add(candidateOrder[i]);

  const cols = gridWidthFor(n);
  const canonicalPlacements = placeBlocks(canonicalOrder, bigSongs, cols);
  let rows = 0;
  for (const p of canonicalPlacements) rows = Math.max(rows, p.row + p.span);

  // 5) 默认选中：先取「格位中心离网格中心最近」的一小撮，再由种子从中挑一个；
  //    这一小撮里若有 2×2，优先选 2×2 —— 选中块更大，3D 的高亮更醒目。
  const centerX = cols / 2;
  const centerY = rows / 2;
  const ranked = canonicalPlacements
    .map((p) => {
      const dx = p.col + p.span / 2 - centerX;
      const dy = p.row + p.span / 2 - centerY;
      return { p, distance: dx * dx + dy * dy };
    })
    .sort((a, b) => a.distance - b.distance || a.p.orderIndex - b.p.orderIndex);

  const poolSize = Math.max(1, Math.min(n, Math.max(2, Math.ceil(n * 0.18)), 8));
  const pool = ranked.slice(0, poolSize);
  const bigPool = pool.filter((x) => x.p.span === 2);
  const chosenPool = bigPool.length ? bigPool : pool;
  const pickRand = mulberry32(mixSeed(seed, 4));
  const chosen =
    chosenPool[Math.floor(pickRand() * chosenPool.length) % chosenPool.length];

  // 6) 把规范化下标映射回调用方传进来的原数组下标
  const order = canonicalOrder.map((ci) => entries[ci].originalIndex);
  const orderSongIds = canonicalOrder.map((ci) => Number(entries[ci].song.id));
  const placements = canonicalPlacements.map((p) => ({
    ...p,
    songIndex: entries[p.songIndex].originalIndex,
  }));
  const selectedIndex = entries[chosen.p.songIndex].originalIndex;
  const selectedSongId = Number(entries[chosen.p.songIndex].song.id);

  const byOriginalIndex = new Map<number, ExploreFeature>();
  for (const feature of canonicalFeatures) byOriginalIndex.set(feature.songIndex, feature);
  const features: ExploreFeature[] = songs.map(
    (_, i) => byOriginalIndex.get(i) as ExploreFeature,
  );

  return {
    songSetId,
    order,
    orderSongIds,
    placements,
    cols,
    rows,
    selectedIndex,
    selectedOrder: chosen.p.orderIndex,
    selectedSongId,
    features,
  };
}

/**
 * 3D 高度分布（纯函数）：
 *   height = FLOOR + (1-FLOOR) × exp(-d² / 2σ²)
 * d 是「块中心到选中块中心」的单位格距离。指数衰减连续且严格随距离减小，
 * 不会出现「隔一格突然掉一档」的台阶；σ 随网格对角线放大，大歌单远处也不会全贴地。
 */
export function buildExploreHeights(
  layout: ExploreLayout,
  selectedOrder: number = layout.selectedOrder,
): ExploreHeight[] {
  const { placements, cols, rows } = layout;
  if (!placements.length) return [];
  const anchor =
    placements.find((p) => p.orderIndex === selectedOrder) ?? placements[0];
  const ax = anchor.col + anchor.span / 2;
  const ay = anchor.row + anchor.span / 2;
  const sigma = Math.max(2.4, Math.min(5, 0.25 * Math.hypot(cols, rows)));
  const twoSigmaSq = 2 * sigma * sigma;

  return placements.map((p) => {
    const dx = p.col + p.span / 2 - ax;
    const dy = p.row + p.span / 2 - ay;
    const distance = Math.hypot(dx, dy);
    const falloff = Math.exp(-(distance * distance) / twoSigmaSq);
    const height = HEIGHT_FLOOR + (1 - HEIGHT_FLOOR) * falloff;
    return { orderIndex: p.orderIndex, distance, height };
  });
}

/** 调试 / 测试用：检查两个格位是否重叠（正常布局里应当恒为 false） */
export function explorePlacementsOverlap(
  a: ExplorePlacement,
  b: ExplorePlacement,
): boolean {
  return placementsOverlap(a, b);
}
