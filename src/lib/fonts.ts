/** 「系统默认字体」的取值：等于不覆盖，交给系统/浏览器决定 */
export const SYSTEM_FONT = "system-ui";

export interface FontOption {
  family: string;
  label: string;
}

/** 无法枚举系统字体时的兜底候选（覆盖中英文常见字体，中英文名都可搜） */
const FALLBACK_FAMILIES = [
  "PingFang SC",
  "苹方-简",
  "Hiragino Sans GB",
  "冬青黑体简体中文",
  "Heiti SC",
  "Songti SC",
  "STHeiti",
  "STSong",
  "Microsoft YaHei",
  "微软雅黑",
  "Microsoft JhengHei",
  "微軟正黑體",
  "SimSun",
  "宋体",
  "SimHei",
  "黑体",
  "KaiTi",
  "楷体",
  "FangSong",
  "仿宋",
  "Noto Sans SC",
  "Noto Serif SC",
  "Source Han Sans SC",
  "思源黑体",
  "Source Han Serif SC",
  "思源宋体",
  "WenQuanYi Micro Hei",
  "文泉驿微米黑",
  "Segoe UI",
  "Arial",
  "Helvetica Neue",
  "Times New Roman",
  "Georgia",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Courier New",
  "Consolas",
  "Menlo",
  "Monaco",
  "Inter",
  "Roboto",
  "Ubuntu",
  "Cantarell",
  "DejaVu Sans",
];

let cached: FontOption[] | null = null;
let pending: Promise<FontOption[]> | null = null;

export function getCachedFonts(): FontOption[] {
  return cached ?? [];
}

/**
 * 读取系统全局字体。
 * 优先用 Local Font Access API（Chromium 系支持：Web / WebView2）；
 * 浏览器不支持或用户拒绝授权时，退回内置候选列表。
 */
export async function loadSystemFonts(): Promise<FontOption[]> {
  if (cached) return cached;
  if (pending) return pending;
  pending = (async () => {
    let families: string[] = [];
    try {
      const w = window as unknown as {
        queryLocalFonts?: () => Promise<Array<{ family: string }>>;
      };
      if (typeof w.queryLocalFonts === "function") {
        const list = await w.queryLocalFonts();
        families = [...new Set(list.map((f) => f.family).filter(Boolean))];
      }
    } catch {
      families = [];
    }
    if (families.length === 0) families = [...FALLBACK_FAMILIES];
    families.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    cached = families.map((family) => ({ family, label: family }));
    return cached;
  })();
  return pending;
}

/** 字体族名可能含空格/中文，需要加引号 */
export function quoteFontFamily(family: string): string {
  if (!family) return "";
  if (/^[a-zA-Z-]+$/.test(family)) return family;
  return `"${family.replace(/"/g, '\\"')}"`;
}

/** 生成可直接用于 CSS font-family 的值（带兜底字体） */
export function fontStack(family: string): string {
  const FALLBACK =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  if (!family || family === SYSTEM_FONT) return FALLBACK;
  return `${quoteFontFamily(family)}, ${FALLBACK}`;
}

/** 把「软件字体」应用到全局（设置 CSS 变量，index.css 里消费） */
export function applyAppFont(family: string): void {
  const root = document.documentElement;
  if (!family || family === SYSTEM_FONT) {
    root.style.removeProperty("--app-font");
  } else {
    root.style.setProperty("--app-font", fontStack(family));
  }
}
