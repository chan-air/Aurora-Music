import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useAutoHide } from "@/hooks/useAutoHide";
import type { CloseButtonSensitivity } from "@/lib/settings";

interface CloseButtonProps {
  onClick: () => void;
  className?: string;
  /** 灵敏度档位（设置项），默认 medium */
  sensitivity?: CloseButtonSensitivity;
}

// transform-origin 用的是百分比，钳制到 0-100
const clampPct = (v: number) => Math.max(0, Math.min(100, v));
// 图标渲染 36px（h-9）对应 viewBox 24 单位
const PX_TO_SVG = 24 / 36;
/** 关闭键比其他按钮更通透：默认 45%，悬浮 85% */
const IDLE_OPACITY = 0.45;
const HOVER_OPACITY = 0.85;

/**
 * 沉浸歌词页关闭键（水晶质感，与播放 / 切歌键同一套语言）：
 * - 两根细圆角横条交叉成 X，纯填充、无圆形底
 * - 比播放 / 切歌键更通透：默认 45% 不透明，悬浮升到 85%
 * - 悬浮时内部出现跟随鼠标的淡光晕，并轻微磁吸
 * - 点击时朝点击位置轻微缩小并变灰，松开弹性恢复
 * - 自动隐藏 / 唤回行为由 sensitivity 决定（见 PRESETS）
 *   （触屏设备不会收到 mousemove，因此保持常显）
 */
export default function CloseButton({
  onClick,
  className,
  sensitivity = "medium",
}: CloseButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [mx, setMx] = useState(0);
  const [my, setMy] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [longPress, setLongPress] = useState(false);
  const startRef = useRef({ x: 0, y: 0 });
  const timerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  // 自动隐藏 / 靠近唤回（与竖屏底部控制栏共用同一套灵敏度）
  const { visible } = useAutoHide(ref, sensitivity, (inside) => {
    // 唤醒那一刻指针若正好在按钮上，补一下悬浮态（否则要移出再移入才有光晕）
    if (inside) setHovered(true);
  });

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const onMove = (e: React.MouseEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setMx(e.clientX - (r.left + r.width / 2));
    setMy(e.clientY - (r.top + r.height / 2));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      startRef.current = {
        x: e.clientX - (r.left + r.width / 2),
        y: e.clientY - (r.top + r.height / 2),
      };
    }
    setPressed(true);
    setLongPress(false);
    suppressClickRef.current = false;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      setLongPress(true);
      suppressClickRef.current = true;
    }, 250);
  };

  const onPointerUp = () => {
    clearTimer();
    setPressed(false);
    setLongPress(false);
  };

  const onPointerCancel = () => {
    clearTimer();
    setPressed(false);
    setLongPress(false);
    suppressClickRef.current = false;
  };

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onClick();
  };

  // 磁吸：长按以「起点」为原点，普通悬浮以「按钮中心」为原点
  const relX = longPress ? mx - startRef.current.x : mx;
  const relY = longPress ? my - startRef.current.y : my;
  const tx = relX * 0.04;
  const ty = relY * 0.04;

  const scale = pressed && !longPress ? 0.85 : 1;
  const originX = clampPct(50 + mx * 0.3);
  const originY = clampPct(50 + my * 0.3);
  const gx = 12 + mx * PX_TO_SVG;
  const gy = 12 + my * PX_TO_SVG;

  return (
    <button
      ref={ref}
      onClick={handleClick}
      onMouseMove={onMove}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setMx(0);
        setMy(0);
      }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      aria-label="关闭歌词"
      className={cn(
        "relative grid h-10 w-10 place-items-center text-foreground outline-none",
        className,
      )}
      style={{
        transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        transformOrigin: `${originX}% ${originY}%`,
        transition:
          pressed && !longPress
            ? "transform 0.12s ease, opacity 0.4s ease"
            : "transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s ease",
        filter: pressed && !longPress ? "grayscale(0.6) brightness(0.8)" : "none",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <XIcon className="pop-in h-9 w-9" gx={gx} gy={gy} hovered={hovered} />
    </button>
  );
}

function XIcon({
  className,
  gx,
  gy,
  hovered,
}: {
  className?: string;
  gx: number;
  gy: number;
  hovered: boolean;
}) {
  const paint = hovered ? "url(#cb-glow)" : "currentColor";
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      opacity={hovered ? HOVER_OPACITY : IDLE_OPACITY}
      aria-hidden
    >
      {hovered && (
        <defs>
          <radialGradient id="cb-glow" gradientUnits="userSpaceOnUse" cx={gx} cy={gy} r="6">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.8" />
          </radialGradient>
        </defs>
      )}
      <g transform="rotate(45 12 12)">
        <rect x="4.5" y="10.8" width="15" height="2.4" rx="1.2" fill={paint} />
      </g>
      <g transform="rotate(-45 12 12)">
        <rect x="4.5" y="10.8" width="15" height="2.4" rx="1.2" fill={paint} />
      </g>
    </svg>
  );
}
