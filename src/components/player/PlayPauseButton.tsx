import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface PlayPauseButtonProps {
  playing: boolean;
  loading: boolean;
  onClick: () => void;
  className?: string;
}

// transform-origin 用的是百分比，钳制到 0-100
const clampPct = (v: number) => Math.max(0, Math.min(100, v));
// 图标渲染 56px 对应 viewBox 24 单位
const PX_TO_SVG = 24 / 56;

/**
 * 沉浸歌词页播放/暂停键：
 * - 无圆形底；图标为两根圆角竖矩形（暂停）或圆角正三角形（播放）
 * - 图标默认约 80% 透明，悬浮时内部出现跟随鼠标的淡光晕
 * - 快速点击：朝点击位置轻微缩小并变灰，松开弹性放大切换
 * - 长按：图标回正，并以长按起点为原点跟随鼠标轻微移动
 */
export default function PlayPauseButton({
  playing,
  loading,
  onClick,
  className,
}: PlayPauseButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [mx, setMx] = useState(0);
  const [my, setMy] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [longPress, setLongPress] = useState(false);
  const startRef = useRef({ x: 0, y: 0 });
  const timerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

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
  const tx = relX * 0.066;
  const ty = relY * 0.066;

  const scale = pressed && !longPress ? 0.85 : 1;
  // 以按钮正中央为基准，仅朝点击位置轻微偏移
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
      aria-label={playing ? "暂停" : "播放"}
      className={cn("relative grid h-16 w-16 place-items-center text-foreground outline-none", className)}
      style={{
        transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        transformOrigin: `${originX}% ${originY}%`,
        transition:
          pressed && !longPress
            ? "transform 0.12s ease"
            : "transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)",
        filter: pressed && !longPress ? "grayscale(0.6) brightness(0.8)" : "none",
      }}
    >
      {loading ? (
        <Loader2 className="h-6 w-6 animate-spin" />
      ) : playing ? (
        <PauseIcon className="pop-in h-14 w-14" gx={gx} gy={gy} hovered={hovered} />
      ) : (
        <PlayIcon className="pop-in h-14 w-14" gx={gx} gy={gy} hovered={hovered} />
      )}
    </button>
  );
}

function PauseIcon({
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
  const fill = hovered ? "url(#pp-glow-pause)" : "currentColor";
  return (
    <svg viewBox="0 0 24 24" className={className} opacity={hovered ? 1 : 0.8} aria-hidden>
      {hovered && (
        <defs>
          <radialGradient id="pp-glow-pause" gradientUnits="userSpaceOnUse" cx={gx} cy={gy} r="6">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.8" />
          </radialGradient>
        </defs>
      )}
      <rect x="5.2" y="4.5" width="5" height="15" rx="1.5" fill={fill} />
      <rect x="13.8" y="4.5" width="5" height="15" rx="1.5" fill={fill} />
    </svg>
  );
}

function PlayIcon({
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
  const paint = hovered ? "url(#pp-glow-play)" : "currentColor";
  return (
    <svg viewBox="0 0 24 24" className={className} opacity={hovered ? 1 : 0.8} aria-hidden>
      {hovered && (
        <defs>
          <radialGradient id="pp-glow-play" gradientUnits="userSpaceOnUse" cx={gx} cy={gy} r="6">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.8" />
          </radialGradient>
        </defs>
      )}
      {/* 视觉补偿：三角路径的墨迹横向占 5.86~17.65（viewBox 单位），中心 11.75，
          比正中（12）偏左 0.25；而右向三角形的视觉重心又比墨迹中心更偏左，
          所以整体右移 1.5 单位 —— 56px 渲染下墨迹中心落在按钮中线右侧约 2.9px
          （约为图标宽度的 5%），这才是"看起来居中"的位置。
          暂停的两根竖条墨迹 5.2~18.8、中心正好 12.0，本身对称，无需处理。 */}
      <path
        transform="translate(1.5 0)"
        d="M7.8 5.5c-.85-.52-1.95.1-1.95 1.02v10.96c0 .92 1.1 1.54 1.95 1.02l9.3-5.48c.74-.43.74-1.53 0-1.96L7.8 5.5z"
        fill={paint}
      />
    </svg>
  );
}
