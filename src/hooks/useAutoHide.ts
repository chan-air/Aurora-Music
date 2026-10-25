import { useEffect, useRef, useState, type RefObject } from "react";
import type { CloseButtonSensitivity } from "@/lib/settings";
import { isModalOpen } from "@/lib/modal";

export interface AutoHidePreset {
  /** 静止多久后隐藏（毫秒） */
  hideAfterMs: number;
  /** 隐藏后，鼠标离元素多近才重新显示（Infinity = 一动就显示） */
  revealRadius: number;
  /** 「保持显示」范围 */
  keepAliveRadius: number;
  /** 是否只在鼠标离开 keepAliveRadius 之后才开始隐藏倒计时 */
  hideOutsideOnly: boolean;
}

export const AUTO_HIDE_PRESETS: Record<CloseButtonSensitivity, AutoHidePreset> = {
  // 低：在元素周围区域内即使不动也不隐藏，离开该区域后再等 5s 才隐藏；
  //     但要显示必须凑得非常近
  low: { hideAfterMs: 5000, revealRadius: 40, keepAliveRadius: 120, hideOutsideOnly: true },
  // 中：不动 3s 就隐藏；移到稍大一圈的范围内才显示
  medium: { hideAfterMs: 3000, revealRadius: 120, keepAliveRadius: 0, hideOutsideOnly: false },
  // 高：不动 5s 才隐藏；只要鼠标一动就显示
  high: {
    hideAfterMs: 5000,
    revealRadius: Number.POSITIVE_INFINITY,
    keepAliveRadius: 0,
    hideOutsideOnly: false,
  },
};

/** 点到矩形的最短距离（在矩形内为 0） */
function distanceToRect(x: number, y: number, r: DOMRect): number {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

/**
 * 鼠标静止自动隐藏 / 靠近再出现。
 * 关闭键与竖屏底部控制栏共用同一套灵敏度档位。
 *
 * @param ref          要控制的元素
 * @param sensitivity  灵敏度档位
 * @param onRevealNear 重新显示时回调，参数表示指针是否已落在元素内部
 * @returns visible 当前是否可见；show 主动唤出并重新开始计时
 */
export function useAutoHide(
  ref: RefObject<HTMLElement | null>,
  sensitivity: CloseButtonSensitivity = "medium",
  onRevealNear?: (pointerInside: boolean) => void,
): { visible: boolean; show: () => void } {
  const [visible, setVisible] = useState(true);
  const cbRef = useRef(onRevealNear);
  useEffect(() => {
    cbRef.current = onRevealNear;
  }, [onRevealNear]);

  // 计时器与「当前是否显示」放在 ref 上，便于外部主动唤出
  const timerRef = useRef<number | null>(null);
  const presetRef = useRef(AUTO_HIDE_PRESETS[sensitivity] ?? AUTO_HIDE_PRESETS.medium);
  /**
   * 当前的显示状态（与 state 同步的 ref）。
   * 必须用 ref：arm() 定义在 effect 之外，闭包里读不到 state 的最新值，
   * 若只在超时回调里 setVisible(false)，onMove 里的判断就永远是「已显示」，
   * 隐藏后鼠标再动也不会唤回。
   */
  const shownRef = useRef(true);

  const clear = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const arm = () => {
    clear();
    timerRef.current = window.setTimeout(() => {
      shownRef.current = false;
      setVisible(false);
    }, presetRef.current.hideAfterMs);
  };

  /** 主动唤出：显示并重新开始隐藏倒计时 */
  const show = () => {
    shownRef.current = true;
    setVisible(true);
    arm();
  };

  useEffect(() => {
    presetRef.current = AUTO_HIDE_PRESETS[sensitivity] ?? AUTO_HIDE_PRESETS.medium;
  }, [sensitivity]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // 有模态弹窗（提示框）打开时，本监听挂在 window 上，遮罩拦不住 ——
      // 直接停摆，保证下层元素不会被鼠标唤动
      if (isModalOpen()) return;

      const preset = presetRef.current;
      const r = ref.current?.getBoundingClientRect();
      const dist = r ? distanceToRect(e.clientX, e.clientY, r) : Number.POSITIVE_INFINITY;

      if (!shownRef.current) {
        // 已隐藏：只有进入唤回半径内才显示（high 档半径为 Infinity，即一动就显示）
        if (dist > preset.revealRadius) return;
        shownRef.current = true;
        setVisible(true);
        cbRef.current?.(dist === 0);
        arm();
        return;
      }

      // 已显示
      if (preset.hideOutsideOnly) {
        // low 档：待在元素周围区域内不动也不隐藏，离开后才开始倒计时
        if (dist > preset.keepAliveRadius) arm();
        else clear();
      } else {
        arm();
      }
    };

    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);

  return { visible, show };
}
