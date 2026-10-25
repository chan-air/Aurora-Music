import { API_BASE } from "./env";

/**
 * 玻璃色调自适应：**玻璃背后是大面积浅色时，把玻璃上的文字 / 图标转成深色。**
 *
 * ── 为什么不能直接读背后的像素 ──────────────────────────────────────────
 * 玻璃（.liquid-glass）只有 backdrop-filter，没有「读背后像素」的接口：
 *  canvas 也读不到 —— 只能自己去命中测试 + 查样式。而最容易出现「大面积白」的
 * 恰恰是列表里的**浅色封面图**，网易云图床是跨域资源，画进 canvas 会污染画布、
 * getImageData() 直接抛错。所以封面亮度走一条单独的通道：
 * 本机代理 server/index.js 的 `GET /img?u=` 把图片原样转发并带上 CORS 头，
 * 前端用 crossOrigin="anonymous" 的 <img> 画进 canvas 就能读到像素了。
 * 只对**真的滚到玻璃背后**的那几张封面付出代价，结果按 URL 缓存。
 *
 * ── 判定流程（每次采样） ────────────────────────────────────────────────
 *  1) 找出覆盖层里**当前可见**的玻璃盒子（.liquid-glass，排除淡出那一层）；
 *  2) 在每个盒子上取约 5 个点（横向均分、纵向略错开），用 document.elementsFromPoint
 *     做命中测试，**跳过玻璃自身及其子孙**，拿到最上层的「背景元素」；
 *  3) 那个元素若是 <img> → 用按 URL 缓存的封面平均亮度；
 *     否则沿父链往上找第一个有背景色的节点（渐变取各色标平均），
 *     按标准 over 合成把半透明背景逐层叠起来，得到近似亮度；
 *  4) 取所有有效点的平均亮度，用**双阈值滞回**决定色调：
 *       ≥ 0.62 → dark（转深色文字）
 *       ≤ 0.52 → light（回浅色文字）
 *       中间   → 保持现状（避免在临界处反复闪）
 *
 * 采样由 scroll / resize / 内容变化 / 兜底轮询触发，rAF 合并 + 最短间隔节流。
 */

/** 判为「浅色背景」的平均亮度阈值 */
const LIGHT_ON = 0.62;
/** 判回「深色背景」的阈值（滞回下沿） */
const LIGHT_OFF = 0.52;
/** 每个玻璃盒子的采样点数 */
const SAMPLES_PER_BOX = 5;
/** 两次采样之间的最短间隔（ms）：滚动时也不会每帧都做命中测试 */
const MIN_INTERVAL_MS = 120;
/** 兜底轮询间隔（ms）：图片加载完成、异步内容变化不一定有 scroll/resize */
const POLL_MS = 1200;
/** 封面亮度缓存条数上限 */
const LUMA_CACHE_MAX = 300;
/**
 * 同时最多取几张封面。
 *
 * 为什么需要限制：封面取图走的是本机代理 `GET /img?u=`，和**歌词 / 歌曲地址等接口
 * 共用同一个源**（都指向 :3000）。浏览器对同一个源只给 6 条并发连接，一旦快速滚动
 * 让十几张封面同时开始取图，接口请求就会被排在图片后面 —— 表现成"歌词变慢"。
 * 这里把取图限制成小并发队列（默认 2），保证接口请求永远有连接可用；
 * 取图本身只是自适应色调的输入，慢一点无所谓，采样器会在算好后重采样一次。
 */
const IMG_CONCURRENCY = 2;

export type GlassTone = "light" | "dark";

/* ------------------------------------------------------------------
 * 「玻璃透明度」滑块的映射（唯一出处）
 *
 * ── 口径（用户已明确，别改回去）────────────────────────────────────
 * 滑块上的数字**就是底栏那枚大胶囊的透明度数值**，不是"感知上的通透程度"，
 * 也不用另立概念。设 t 为滑块值（区间 80..94），则
 *
 *     a = (100 - t) / 100      ← 大胶囊的透明度数值本身
 *       t = 80 → a = 0.20（半透明玻璃）
 *       t = 94 → a = 0.06（几乎完全不可见）
 *
 * 大胶囊**自身的全部涂装都乘 a**（同一个系数，保持它们彼此的相对关系）：
 *   · 本体两层色标（上沿另乘 0.71 只是明暗配比，整体仍等于 a）；
 *   · 描边 --glass-stroke 的每一段；
 *   · 顶部高光 / 内阴影 / .liquid-glass-sheen 那道光泽。
 * 于是 80% → 完整涂装，94% → 几乎只剩一层极淡的色、边缘几乎不可见。
 *
 * ── 真正的毛病（这就是"调了没用"的根因）────────────────────────────
 * 以前**只有本体底色在变**：描边、顶部高光、sheen 都不动，背后的磨砂
 * （backdrop-filter）也固定 18px → 数字变了，那层玻璃外观照旧。
 * 所以现在：涂装一起按 a 缩放，**背后的磨砂也跟着同一条轴走**：
 *   模糊：80% → 18px（就是 CSS 里今天那个值）→ 94% → 0px；
 *   饱和：80% → 180% → 94% → 100%。
 *
 * ── 文字与图标绝不跟着淡 ────────────────────────────────────────────
 * 导航项、歌名、图标必须始终清晰可读。所以 a 只作用在玻璃的**涂装**上
 * （背景图 / 描边 / 阴影 / ::after 光泽），绝不把 opacity 加到含内容的容器上。
 * 浅色背景下文字转深色由既有的玻璃色调自适应负责（见本文件下半部分）。
 *
 * 变量由 App.tsx 写进 :root，组件上挂 .liquid-glass--tone 才会读到
 * （见 index.css）：触屏竖屏那颗药丸 + 设置页预览条，
 * 歌曲栏 / 合一态那几块玻璃沿用固定材质，观感一行都没变。
 * ------------------------------------------------------------------ */

/** 滑块下界（最实） */
export const GLASS_TRANSPARENCY_MIN = 80;
/** 滑块上界（几乎完全不可见） */
export const GLASS_TRANSPARENCY_MAX = 94;
/** 默认值：落在区间下界，即「最实的那一端」 */
export const GLASS_TRANSPARENCY_DEFAULT = GLASS_TRANSPARENCY_MIN;

/**
 * 把任意来源的透明度值钳到 80..94。
 *
 * 为什么必须在**读取时**也钳：老版本存的是 72（乃至手改的 99），落在区间外。
 * 不钳的话界面会显示一个滑块拖不到的值，CSS 还会算出范围外的模糊 / 饱和度
 * （例如 95 会得到负的模糊）。设置页、App 的 CSS 变量都走这一个函数，口径唯一。
 */
export function clampGlassTransparency(v: number | undefined | null): number {
  const n = Number.isFinite(v) ? (v as number) : GLASS_TRANSPARENCY_DEFAULT;
  return Math.min(GLASS_TRANSPARENCY_MAX, Math.max(GLASS_TRANSPARENCY_MIN, n));
}

/** 大胶囊的透明度数值 a = (100-t)/100：80% → 0.20，94% → 0.06 */
export function glassBodyOpacity(v: number): number {
  return (100 - clampGlassTransparency(v)) / 100;
}

/** 上沿 / 下沿的明暗比（只是玻璃"上薄下厚"的配比，两层都按 a 缩放） */
export const GLASS_BODY_TOP_RATIO = 0.71;

/** 背后的磨砂半径（px）：80% → 18px（今天的固定值），94% → 0px */
export function glassBlurPx(v: number): number {
  return 18 - kOf(clampGlassTransparency(v)) * 18;
}

/** 背后的饱和度（%）：80% → 180%（今天的固定值），94% → 100% */
export function glassSaturatePct(v: number): number {
  return 180 - kOf(clampGlassTransparency(v)) * 80;
}

/**
 * 涂装（描边 / 高光 / 内阴影 / 光泽）的缩放系数 = a / 0.20。
 * 即 80% → 1（今天的强度），94% → 0.30（几乎不可见）。
 *
 * 用它而不是直接用 a 的原因：这些"涂装"的基础 alpha 本来就比本体低得多
 * （描边 0.13、高光 0.055…），直接乘 a 会在 80% 时就把它们压掉一半，
 * 那会改变今天的观感。按 a 的相对比例缩放，既满足"涂装与数字同步淡出"，
 * 又保证 80%（默认值）与改动前完全一致。
 *
 * 注意：本体色标用 a 本身，**涂装**用这个系数 —— 涂装的绝对数值本来就小，
 * 用相对比例才能既"跟着数字走"、又不在默认值上改变观感。
 */
export function glassEdgeAlphaScale(v: number): number {
  return glassBodyOpacity(v) / glassBodyOpacity(GLASS_TRANSPARENCY_MIN);
}

/**
 * 表面光泽（.liquid-glass-sheen）的 alpha 缩放。
 *
 * 那道 ::after 的渐变是**写死在 CSS 里的几个 alpha**（0.035 / 0.014 / 0.01），
 * 不经过 var()，所以只改 opacity 会得到「* 透明度数值」而不是「* 涂装系数」：
 * 94% 时只剩 0.3 倍 opacity、叠加本身 0.035 的色 → 看起来几乎没变。
 * 这里直接算成 alpha 缩放系数，交给 CSS 用 calc() 乘进每一个色标，
 * 保证 94% 时整整淡到 0.30 倍，与描边 / 高光同一条曲线。
 */
export function glassSheenAlphaScale(v: number): number {
  return glassEdgeAlphaScale(v);
}

/** k = (t-80)/14：80% → 0，94% → 1 */
function kOf(t: number): number {
  return (t - GLASS_TRANSPARENCY_MIN) / (GLASS_TRANSPARENCY_MAX - GLASS_TRANSPARENCY_MIN);
}

/* ---------------- 封面平均亮度 / 平均色（按 URL 缓存） ---------------- */

/** 一张封面的平均色与平均亮度（0..255 / 0..1） */
export interface CoverColor {
  r: number;
  g: number;
  b: number;
  luma: number;
  /** 占比最高的颜色（主色） */
  dominant: { r: number; g: number; b: number; h: number; s: number; l: number };
  /** 占比第二高的颜色（次色）；单色封面时等于 dominant */
  secondary: { r: number; g: number; b: number; h: number; s: number; l: number };
  /** 颜色均差：12×12 取样内每个像素到 dominant 的归一化 RGB 欧氏距离均值（0..1） */
  variance: number;
  /** 前 6 个量化颜色 + 占比，便于调试 / 扩展 */
  palette: { r: number; g: number; b: number; ratio: number }[];
}

const lumaCache = new Map<string, number>();
const colorCache = new Map<string, CoverColor>();
/** 取图失败（永久 / 本次会话）的 URL：不反复重试，避免刷接口 */
const coverFailed = new Set<string>();
/** 正在取的图：同一个 URL 并发调用只取一次 */
const colorPending = new Map<string, Promise<CoverColor | null>>();
/** 亮度算好后通知采样器重算一次（此时的判定才有封面数据） */
let onLumaReady: (() => void) | null = null;

function luminanceOf(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** RGB(0..255) → HSL(0..1)，h 用 0..1 的环，s/l 也是 0..1 */
function hslOf(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h /= 6;
  return { h, s, l };
}

/**
 * 取图次数统计（只读）。给「性能排查」用：可以从控制台看
 * `__AURORA_GLASS_STATS__.attempted` 来判断当前页面到底取过几张封面 ——
 * 0 就说明这一页的玻璃背后根本没有命中过封面图，取图不可能成为瓶颈。
 * 挂在 window 上只是读一个计数，不参与任何业务逻辑。
 */
const coverFetchStats = { attempted: 0, done: 0 };
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__AURORA_GLASS_STATS__ = coverFetchStats;
}

/**
 * 取封面平均色（异步，带缓存与去重）。
 *
 * 这是**给「歌曲探索」用的公开入口**：布局算法需要把封面主色当作特征，
 * 而取色本身必须异步。调用方应当先把所有需要的颜色取完、组成一张颜色表，
 * 再一次性传给 buildExploreLayout —— 不要一边取一边排，否则顺序会受网络时序影响。
 *
 * 取图走的是同一个本机代理与同一条小并发队列（IMG_CONCURRENCY），
 * 因此不会把接口连接抢光；结果按 URL 缓存，同一张封面只取一次。
 * 取不到时返回 null（调用方把它当颜色 0 处理，仍然保持确定性）。
 */
export function coverColorAsync(url: string): Promise<CoverColor | null> {
  if (!url) return Promise.resolve(null);
  const cached = colorCache.get(url);
  if (cached) return Promise.resolve(cached);
  if (coverFailed.has(url)) return Promise.resolve(null);
  const pending = colorPending.get(url);
  if (pending) return pending;

  const job = scheduleCoverFetch(() => computeCoverColor(url))
    .then((color) => {
      if (!color) {
        coverFailed.add(url);
        return null;
      }
      if (colorCache.size >= LUMA_CACHE_MAX) {
        const oldest = colorCache.keys().next().value;
        if (oldest !== undefined) {
          colorCache.delete(oldest);
          lumaCache.delete(oldest);
        }
      }
      colorCache.set(url, color);
      lumaCache.set(url, color.luma);
      coverFetchStats.done++;
      onLumaReady?.();
      return color;
    })
    .catch(() => {
      coverFailed.add(url);
      return null;
    })
    .finally(() => {
      colorPending.delete(url);
    });
  colorPending.set(url, job);
  return job;
}

/**
 * 同步查询已缓存的亮度；未知则返回 null，并在后台取一次（算好会重采样）。
 * 玻璃色调自适应每帧都会问一次，所以这里不能返回 Promise。
 */
function coverLuminance(url: string): number | null {
  if (!url) return null;
  const cached = lumaCache.get(url);
  if (cached !== undefined) return cached;
  if (coverFailed.has(url)) return null;
  if (!colorPending.has(url)) void coverColorAsync(url);
  return null;
}

/** 经本机代理取图 → 缩到 12×12 画进 canvas → 求平均色与平均亮度 */
async function computeCoverColor(url: string): Promise<CoverColor | null> {
  coverFetchStats.attempted++;
  const proxied = `${API_BASE}/img?u=${encodeURIComponent(url)}`;
  const img = new Image();
  // 代理带了 Access-Control-Allow-Origin，加了这个属性画布才不会被污染
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = proxied;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const N = 12;
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, N, N);
  try {
    const data = ctx.getImageData(0, 0, N, N).data;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sumLuma = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] <= 5) continue; // 全透明像素不计
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
      sumLuma += luminanceOf(data[i], data[i + 1], data[i + 2]);
      n++;
    }
    if (!n) return null;
    /*
     * 颜色量化 + 主/次色 + 均差：
     *  - 每像素量化到 5bit/通道（32×32×32 桶），桶内做 RGB 平均；
     *  - 按像素数降序取前 6 个桶作为 palette（占比 = 像素数 / n）；
     *  - dominant / secondary 是前两名；纯色封面两者相同；
     *  - variance = 每个像素到 dominant 的 RGB 欧氏距离 / (√3·255) 的均值（0..1）。
     * 12×12 最近邻取样共 144 像素，透明像素跳过；同一封面结果确定。
     */
    const bins = new Map<number, { r: number; g: number; b: number; count: number }>();
    const pixels: { r: number; g: number; b: number }[] = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] <= 5) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      pixels.push({ r, g, b });
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bin = bins.get(key);
      if (bin) {
        bin.r += r;
        bin.g += g;
        bin.b += b;
        bin.count++;
      } else {
        bins.set(key, { r, g, b, count: 1 });
      }
    }
    const sorted = [...bins.values()]
      .map((bin) => ({
        r: bin.r / bin.count,
        g: bin.g / bin.count,
        b: bin.b / bin.count,
        count: bin.count,
      }))
      .sort((x, y) => y.count - x.count || x.r - y.r || x.g - y.g || x.b - y.b);
    const dominantRgb = sorted[0] ?? { r: sr / n, g: sg / n, b: sb / n, count: n };
    // 次色：单色封面时与主色相同
    const secondaryRgb = sorted[1] ?? dominantRgb;
    let deviation = 0;
    for (const pixel of pixels) {
      const dr = pixel.r - dominantRgb.r;
      const dg = pixel.g - dominantRgb.g;
      const db = pixel.b - dominantRgb.b;
      deviation += Math.sqrt(dr * dr + dg * dg + db * db) / (Math.sqrt(3) * 255);
    }
    const variance = n > 0 ? deviation / n : 0;
    const domHsl = hslOf(dominantRgb.r, dominantRgb.g, dominantRgb.b);
    const secHsl = hslOf(secondaryRgb.r, secondaryRgb.g, secondaryRgb.b);
    return {
      r: sr / n,
      g: sg / n,
      b: sb / n,
      luma: sumLuma / n,
      dominant: { r: dominantRgb.r, g: dominantRgb.g, b: dominantRgb.b, h: domHsl.h, s: domHsl.s, l: domHsl.l },
      secondary: { r: secondaryRgb.r, g: secondaryRgb.g, b: secondaryRgb.b, h: secHsl.h, s: secHsl.s, l: secHsl.l },
      variance,
      palette: sorted.slice(0, 6).map((bin) => ({
        r: bin.r,
        g: bin.g,
        b: bin.b,
        ratio: bin.count / n,
      })),
    };
  } catch {
    // 画布被污染（理论上不会发生：代理已带 CORS 头）——当作算不出来
    return null;
  }
}

/* ---------------- 取图小并发队列 ---------------- */

let imgActive = 0;
const imgQueue: (() => void)[] = [];
/** 队列里还有活就继续放行，直到满并发 */
function pumpImgQueue(): void {
  while (imgActive < IMG_CONCURRENCY && imgQueue.length > 0) {
    imgActive++;
    const job = imgQueue.shift();
    if (!job) break;
    job();
  }
}

/**
 * 把一次取图排进小并发队列。
 *
 * 用 try/finally 释放名额：任务抛错（decode 失败、canvas 被污染…）也绝不会
 * 把名额漏掉 —— 漏一个就少一条并发，漏两个整个取图通道就永远堵死。
 */
function scheduleCoverFetch<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    imgQueue.push(() => {
      task().then(resolve, reject).finally(() => {
        imgActive = Math.max(0, imgActive - 1);
        pumpImgQueue();
      });
    });
    pumpImgQueue();
  });
}

/**
 * 排查用：把一次取图排进队列并等待结果（生产代码不调用它，
 * 打包时会被 tree-shaking 掉；开发时可在控制台验证"并发是否真的被压到 N"）。
 */
export function __debugScheduleCoverFetch<T>(task: () => Promise<T>): Promise<T> {
  return scheduleCoverFetch(task);
}

/* ---------------- 背景亮度 ---------------- */

type Rgba = { r: number; g: number; b: number; a: number };

/** 解析 CSS 颜色字符串（rgb/rgba/hex）；解析不了返回 null */
function parseColor(text: string): Rgba | null {
  const t = text.trim().toLowerCase();
  const m = /^rgba?\(([^)]+)\)$/.exec(t);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((v) => Number.isFinite(v))) {
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1 };
    }
    return null;
  }
  const hex = /^#([0-9a-f]{3,8})$/.exec(t);
  if (hex) {
    const h = hex[1];
    const to = (s: string) => Number.parseInt(s, 16);
    if (h.length === 3 || h.length === 4) {
      return { r: to(h[0] + h[0]), g: to(h[1] + h[1]), b: to(h[2] + h[2]), a: h.length === 4 ? to(h[3] + h[3]) / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: to(h.slice(0, 2)),
        g: to(h.slice(2, 4)),
        b: to(h.slice(4, 6)),
        a: h.length === 8 ? to(h.slice(6, 8)) / 255 : 1,
      };
    }
  }
  if (t === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (t === "black") return { r: 0, g: 0, b: 0, a: 1 };
  if (t === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

/** 从一段 CSS 文本里抓出所有颜色（渐变取色标平均） */
function averageColorsIn(text: string): Rgba | null {
  const found: Rgba[] = [];
  const re = /rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const c = parseColor(m[0]);
    if (c) found.push(c);
  }
  if (!found.length) return null;
  const n = found.length;
  return {
    r: found.reduce((s, c) => s + c.r, 0) / n,
    g: found.reduce((s, c) => s + c.g, 0) / n,
    b: found.reduce((s, c) => s + c.b, 0) / n,
    a: found.reduce((s, c) => s + c.a, 0) / n,
  };
}

/** 某个节点自己画的背景（渐变优先，其次背景色）；什么都没画返回 null */
function ownBackground(el: Element): Rgba | null {
  const cs = getComputedStyle(el);
  const image = cs.backgroundImage;
  if (image && image !== "none") {
    const c = averageColorsIn(image);
    if (c && c.a > 0.02) return c;
  }
  const c = parseColor(cs.backgroundColor);
  if (c && c.a > 0.02) return c;
  return null;
}

/**
 * 从背景元素出发，沿父链做近似 over 合成，得到它**看起来**的亮度。
 * 遇到 <img> 就直接用那张图的缓存亮度（图片也是「背景」的一种）。
 */
function backdropLuminance(start: Element): number | null {
  let node: Element | null = start;
  let acc: Rgba | null = null;
  while (node) {
    if (node.tagName === "IMG") {
      const src = (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src;
      const luma = src ? coverLuminance(src) : null;
      if (luma !== null) {
        if (!acc) return luma;
        // 上层还有半透明底色：把它叠在这张图的亮度上（近似：先转灰度再合成）
        return acc.a * luminanceOf(acc.r, acc.g, acc.b) + (1 - acc.a) * luma;
      }
    }
    const bg = ownBackground(node);
    if (bg) {
      if (!acc) acc = { ...bg };
      else {
        // acc 在上、bg 在下：标准 source-over
        const outA: number = acc.a + bg.a * (1 - acc.a);
        if (outA > 0) {
          acc = {
            r: (acc.r * acc.a + bg.r * bg.a * (1 - acc.a)) / outA,
            g: (acc.g * acc.a + bg.g * bg.a * (1 - acc.a)) / outA,
            b: (acc.b * acc.a + bg.b * bg.a * (1 - acc.a)) / outA,
            a: outA,
          };
        }
      }
      if (acc.a >= 0.98) break;
    }
    node = node.parentElement;
  }
  if (!acc || acc.a <= 0.02) return null;
  // 底下还有没画满的部分按黑底补（应用的根背景就是深色）
  return acc.a * luminanceOf(acc.r, acc.g, acc.b);
}

/* ---------------- 可见性 ---------------- */

/** 元素是否真的看得见（自身与所有祖先都不透明度≈0 / display:none / aria-hidden） */
function isVisible(el: HTMLElement): boolean {
  let node: HTMLElement | null = el;
  let opacity = 1;
  while (node) {
    if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return false;
    const cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const o = Number.parseFloat(cs.opacity);
    if (Number.isFinite(o)) opacity *= o;
    if (opacity < 0.15) return false;
    node = node.parentElement;
  }
  return true;
}

/* ---------------- 采样器 ---------------- */

/**
 * 在 root（底部覆盖层）内持续维护每个玻璃盒子的 `data-glass-tone`。
 * 返回解除函数。
 */
export function installGlassTone(root: HTMLElement): () => void {
  let stopped = false;
  let raf = 0;
  let lastAt = 0;
  const tones = new WeakMap<HTMLElement, GlassTone>();

  const sample = () => {
    const boxes = Array.from(root.querySelectorAll<HTMLElement>(".liquid-glass")).filter(isVisible);
    for (const box of boxes) {
      const rect = box.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < SAMPLES_PER_BOX; i++) {
        const px = rect.left + (rect.width * (i + 0.5)) / SAMPLES_PER_BOX;
        // 纵向在 1/3 与 1/2 之间交替：一行采样点全落在同一条直线上容易误判
        const py = rect.top + rect.height * (i % 2 === 0 ? 0.5 : 0.34);
        const stack = document.elementsFromPoint(px, py);
        const backdrop = stack.find((el) => el !== box && !root.contains(el));
        if (!backdrop) continue;
        const luma = backdropLuminance(backdrop);
        if (luma === null) continue;
        sum += luma;
        count++;
      }
      if (!count) continue;
      const avg = sum / count;
      const prev = tones.get(box);
      let next: GlassTone | null = null;
      if (avg >= LIGHT_ON) next = "dark";
      else if (avg <= LIGHT_OFF) next = "light";
      if (next && next !== prev) {
        tones.set(box, next);
        box.setAttribute("data-glass-tone", next);
      }
    }
  };

  const schedule = () => {
    if (stopped || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const now = performance.now();
      if (now - lastAt < MIN_INTERVAL_MS) {
        schedule(); // 还没到最短间隔：下一帧再看
        return;
      }
      lastAt = now;
      sample();
    });
  };

  onLumaReady = schedule;
  sample(); // 首帧先判一次

  // 滚动 / 尺寸变化 / 内容变化都重算；滚动事件不冒泡，用捕获阶段听
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  let mo: MutationObserver | null = null;
  if (typeof MutationObserver !== "undefined") {
    mo = new MutationObserver(schedule);
    // 只看结构变化：AMLL 那种每帧改行内样式的页面不会把采样器刷爆
    mo.observe(document.body, { childList: true, subtree: true });
  }
  const poll = window.setInterval(schedule, POLL_MS);

  return () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    if (onLumaReady === schedule) onLumaReady = null;
    window.removeEventListener("scroll", schedule, { capture: true } as EventListenerOptions);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    mo?.disconnect();
    window.clearInterval(poll);
  };
}
