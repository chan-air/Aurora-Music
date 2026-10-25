import { create } from "zustand";
import {
  DEFAULT_SETTINGS,
  pickScoped,
  pickShared,
  type AppSettings,
  type DeviceMode,
  type OrientationScope,
  type ScopedSettings,
  type SettingsProfileKey,
} from "@/lib/settings";
import { getScopedSettings, getSettings, saveScopedSettings, saveSettings } from "@/lib/storage";
import { clampGlassTransparency } from "@/lib/glassTone";
import { clampDockCollapseDistance } from "@/lib/settings";

/**
 * 读入 / 写入设置时统一矫正「玻璃透明度」。
 *
 * 滑块区间是 80..94。老版本存的是 72（乃至手改的 99），落在区间外：
 *  · 界面会显示一个滑块拖不到的值；
 *  · CSS 会算出范围外的模糊 / 饱和度（95 → -0.07px 模糊）。
 * 所以在**入口**（load / update）就钳住，别让它进内存。
 * 只碰这一个字段，其余设置原样透传。
 */
function withGlassClamp<T extends Partial<AppSettings>>(patch: T): T {
  if (!("glassTransparency" in patch)) return patch;
  return { ...patch, glassTransparency: clampGlassTransparency(patch.glassTransparency) };
}

/**
 * 同理矫正「收起触发距离」（dockCollapseDistance）：区间 20..400。
 * 老数据里没有这个键时不动（缺键会由 DEFAULT_SETTINGS 的默认值 28 兜底），
 * 手改越界 / NaN 的值在这里钳回区间。
 */
function withDockClamp<T extends Partial<AppSettings>>(patch: T): T {
  if (!("dockCollapseDistance" in patch)) return patch;
  return { ...patch, dockCollapseDistance: clampDockCollapseDistance(patch.dockCollapseDistance) };
}

/** 所有需要「入口矫正」的字段合成一步，load / update 都走它 */
function withSettingClamps<T extends Partial<AppSettings>>(patch: T): T {
  return withDockClamp(withGlassClamp(patch));
}

interface SettingsState extends AppSettings {
  loaded: boolean;
  /** 当前设备是否为触屏（iOS / 安卓 / 粗指针且支持多点触控） */
  touch: boolean;
  /** 当前是否横屏（陀螺仪 + 屏幕尺寸） */
  orientation: OrientationScope;
  /** 当前生效的设置档位 */
  profileKey: SettingsProfileKey;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => void;
  reset: () => void;
}

/**
 * 设置存储结构（同一台设备最多 4 档，只有少数**与设备形态无关**的项共用，
 * 完整清单见 lib/settings.ts 的 SHARED_SETTING_KEYS）：
 *  - settings                  → 共用：网易云主页链接 / 双击行为 / 预加载 /
 *                                歌曲设置共享 / 锁屏兼容两项 / 沉浸歌词跟随全屏
 *  - settings_touch_landscape  ┐
 *  - settings_touch_portrait   │ 其余全部设置按设备状态分档保存
 *  - settings_mouse_landscape  │
 *  - settings_mouse_portrait   ┘
 * 设备状态（触屏 / 横竖屏）一变就自动切换到对应档，互不覆盖。
 */

/* ---------------- 设备状态检测 ---------------- */

/** 是否触屏设备：识别 iOS / 安卓等移动端，其余按鼠标模式 */
function detectTouch(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Windows Phone|HarmonyOS|Mobile/i.test(ua)) return true;
  // iPadOS 13+ 用桌面级 UA（Macintosh），靠多点触控区分
  if (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return true;
  // 兜底：粗指针且支持多点触控（例如某些安卓平板 / 车机）
  try {
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches &&
      (navigator.maxTouchPoints ?? 0) > 0
    ) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 是否横屏。
 * 先看「视口比例」——它与页面布局一致（iframe / 桌面窄窗口也正确）；
 * 再退到屏幕尺寸；最后才用 Screen Orientation（陀螺仪 / 物理屏幕）。
 */
function detectOrientation(): OrientationScope {
  if (typeof window === "undefined") return "landscape";
  try {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia("(orientation: landscape)").matches ? "landscape" : "portrait";
    }
  } catch {
    /* ignore */
  }
  if (window.innerWidth && window.innerHeight && window.innerWidth !== window.innerHeight) {
    return window.innerWidth > window.innerHeight ? "landscape" : "portrait";
  }
  try {
    const type = (screen as unknown as { orientation?: { type?: string } })?.orientation?.type;
    if (type) return type.startsWith("landscape") ? "landscape" : "portrait";
  } catch {
    /* ignore */
  }
  return "landscape";
}

function toProfileKey(touch: boolean, orientation: OrientationScope): SettingsProfileKey {
  const mode: DeviceMode = touch ? "touch" : "mouse";
  return `${mode}_${orientation}`;
}

const ALL_PROFILE_KEYS: SettingsProfileKey[] = [
  "touch_landscape",
  "touch_portrait",
  "mouse_landscape",
  "mouse_portrait",
];

/* ---------------- 4 档内存副本 ---------------- */

const profiles = new Map<SettingsProfileKey, Partial<ScopedSettings>>();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let listenerBound = false;

/** 把当前状态里「分档」的键写回当前档 */
function syncCurrentProfile() {
  const s = useSettingsStore.getState();
  profiles.set(s.profileKey, pickScoped(s));
}

async function persistNow() {
  const s = useSettingsStore.getState();
  syncCurrentProfile();
  await saveSettings(pickShared(s) as unknown as Record<string, unknown>);
  await Promise.all(
    ALL_PROFILE_KEYS.map((k) =>
      saveScopedSettings(k, (profiles.get(k) ?? {}) as Record<string, unknown>),
    ),
  );
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistNow();
  }, 300);
}

/** 设备状态变化：先存当前档，再套用目标档；立即落盘，避免旋转/切换后马上关闭丢设置 */
function applyDeviceState(touch: boolean, orientation: OrientationScope) {
  const nextKey = toProfileKey(touch, orientation);
  const s = useSettingsStore.getState();
  if (s.touch === touch && s.orientation === orientation && s.profileKey === nextKey) return;

  syncCurrentProfile();
  const nextProfile = profiles.get(nextKey) ?? {};
  useSettingsStore.setState({
    touch,
    orientation,
    profileKey: nextKey,
    ...nextProfile,
  });

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  void persistNow();
}

function ensureDeviceListeners() {
  if (listenerBound || typeof window === "undefined") return;
  listenerBound = true;

  const onAnyChange = () => applyDeviceState(detectTouch(), detectOrientation());

  window.addEventListener("resize", onAnyChange);
  window.addEventListener("orientationchange", onAnyChange);
  try {
    screen.orientation?.addEventListener?.("change", onAnyChange);
  } catch {
    /* ignore */
  }
  try {
    window.matchMedia("(orientation: landscape)").addEventListener("change", onAnyChange);
  } catch {
    /* ignore */
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  touch: detectTouch(),
  orientation: detectOrientation(),
  profileKey: toProfileKey(detectTouch(), detectOrientation()),

  load: async () => {
    const touch = detectTouch();
    const orientation = detectOrientation();
    const profileKey = toProfileKey(touch, orientation);

    const [shared, ...scopedList] = await Promise.all([
      getSettings(),
      ...ALL_PROFILE_KEYS.map((k) => getScopedSettings(k)),
    ]);
    console.log("[DBG load]", JSON.stringify({
      profileKey,
      touch,
      orientation,
      sharedKeys: Object.keys(shared as object),
      scoped: ALL_PROFILE_KEYS.map((k, i) => [k, Object.keys((scopedList[i] as object) ?? {})]),
      storedKeys: typeof localStorage !== "undefined" ? Object.keys(localStorage) : null,
      raw: typeof localStorage !== "undefined" ? localStorage.getItem("aurora:kv:settings_touch_portrait") : null,
    }));

    // 兼容旧版本数据：
    //  1) 更早的版本把设置平铺在 settings 里
    //  2) 上一版按横竖屏分了两档（settings_portrait / settings_landscape）
    const legacyFlat = pickScoped(shared as Partial<AppSettings>);
    const legacyByOrientation: Record<OrientationScope, Record<string, unknown>> = {
      portrait: {},
      landscape: {},
    };
    try {
      legacyByOrientation.portrait = await getScopedSettings("portrait");
      legacyByOrientation.landscape = await getScopedSettings("landscape");
    } catch {
      /* ignore */
    }
    const fallbackFor = (key: SettingsProfileKey): Partial<ScopedSettings> => {
      const orientationPart: OrientationScope = key.endsWith("portrait") ? "portrait" : "landscape";
      const legacy = legacyByOrientation[orientationPart];
      if (legacy && Object.keys(legacy).length) return legacy as Partial<ScopedSettings>;
      return legacyFlat;
    };

    ALL_PROFILE_KEYS.forEach((k, i) => {
      const raw = scopedList[i] as Record<string, unknown> | undefined;
      profiles.set(k, raw && Object.keys(raw).length ? (raw as Partial<ScopedSettings>) : fallbackFor(k));
    });

    for (const k of ALL_PROFILE_KEYS) {
      const p = profiles.get(k);
      if (!p) continue;
      let next = p as Partial<AppSettings>;
      if ("glassTransparency" in next) next = withGlassClamp(next);
      if ("dockCollapseDistance" in next) next = withDockClamp(next);
      if (next !== (p as Partial<AppSettings>)) profiles.set(k, next as Partial<ScopedSettings>);
    }

    set(withSettingClamps({
      ...DEFAULT_SETTINGS,
      ...(shared as Partial<AppSettings>),
      ...(profiles.get(profileKey) ?? {}),
      touch,
      orientation,
      profileKey,
      loaded: true,
    }));
    console.log("[DBG loaded]", JSON.stringify({
      profileKey,
      touch,
      orientation,
      fromProfile: Object.keys(profiles.get(profileKey) ?? {}).length,
      returnSpeed: useSettingsStore.getState().glassReturnSpeed,
      raw: typeof localStorage !== "undefined" ? localStorage.getItem("aurora:kv:settings_touch_portrait") : null,
      all: typeof localStorage !== "undefined" ? Object.keys(localStorage) : null,
    }));
    ensureDeviceListeners();
  },

  update: (patch) => {
    set(withSettingClamps(patch));
    scheduleSave();
  },

  reset: () => {
    profiles.clear();
    set({ ...DEFAULT_SETTINGS, loaded: true });
    scheduleSave();
  },
}));
