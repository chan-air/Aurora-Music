import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface SkipButtonProps {
  direction: "next" | "prev";
  onClick: () => void;
  className?: string;
}

const clampPct = (v: number) => Math.max(0, Math.min(100, v));
// 图标渲染 56px 对应 viewBox 24 单位
const PX_TO_SVG = 24 / 56;

/**
 * 正三角形（朝右，圆角），边长 12，底边 x=3.82(y 6→18)，尖端 (14.21,12)。
 * bbox 中心 (9.02, 12)。
 */
const TRI =
  "M5.62 7.04Q3.82 6 3.82 8.08V15.92Q3.82 18 5.62 16.96L12.41 13.04Q14.21 12 12.41 10.96L5.62 7.04Z";

// 小三角 = 大三角整体缩放 0.9 并右移 6.49
// （大三角 + 缝隙侵入小三角的宽度 ≈ 小三角宽度的 50%）
const SMALL_S = 0.9;
const SMALL_TX = 6.49;
const SMALL_T = `translate(${SMALL_TX}px, 0) scale(${SMALL_S})`;
// 遮罩外扩量：越大两三角交界缝隙越宽（也会让缝隙圆角更圆）
const GAP_STROKE = 2.6;

/**
 * 沉浸歌词页切歌键（双正三角，层叠）：
 * - 两个朝右的圆角正三角形，靠近中间的（左侧）更大
 * - 两三角约 1/2 宽度重叠；【大三角在前压住小三角】，交界处留缝隙
 * - 悬浮/长按：内部淡光晕跟随鼠标 + 轻微磁吸
 * - 点击：右侧小三角缩小右移消失，左侧大三角缩小右移补位，
 *   同时左侧弹性出现一个新的大三角
 */
export default function SkipButton({ direction, onClick, className }: SkipButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [mx, setMx] = useState(0);
  const [my, setMy] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [longPress, setLongPress] = useState(false);
  const [animKey, setAnimKey] = useState(0);
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
    setAnimKey((k) => k + 1);
  };

  // 磁吸：长按以起点为原点
  const relX = longPress ? mx - startRef.current.x : mx;
  const relY = longPress ? my - startRef.current.y : my;
  const tx = relX * 0.05;
  const ty = relY * 0.05;

  const scale = pressed && !longPress ? 0.86 : 1;
  const originX = clampPct(50 + mx * 0.3);
  const originY = clampPct(50 + my * 0.3);

  const gid = `skip-glow-${direction}`;
  const gapId = `skip-gap-${direction}`;
  const paint = hovered ? `url(#${gid})` : "currentColor";
  // prev 整体水平镜像，光晕中心同步取反
  const sign = direction === "prev" ? -1 : 1;
  const gx = 12 + sign * mx * PX_TO_SVG;
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
      aria-label={direction === "next" ? "下一首" : "上一首"}
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
      <svg
        key={animKey}
        viewBox="0 0 24 24"
        className={cn("h-14 w-14", animKey > 0 && "skip-anim")}
        style={{ transform: direction === "prev" ? "scaleX(-1)" : undefined }}
        aria-hidden
      >
        <defs>
          <radialGradient id={gid} gradientUnits="userSpaceOnUse" cx={gx} cy={gy} r="6">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.8" />
          </radialGradient>

          {/* 遮罩：按大三角轮廓（外扩出缝隙）挖空，使小三角被大三角遮挡 */}
          <mask id={gapId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <rect x="0" y="0" width="24" height="24" fill="#fff" />
            <path
              d={TRI}
              fill="#000"
              stroke="#000"
              strokeWidth={GAP_STROKE}
              strokeLinejoin="round"
            />
          </mask>
        </defs>

        <g opacity={hovered ? 1 : 0.8}>
          {/* 小三角（在后）：被前面的大三角遮挡。
              注意 mask 必须挂在「未加 transform 的外层 g」上：
              直接挂在被变换的元素上时，遮罩内容会跟着一起变换，导致小三角被整体挖空。 */}
          <g mask={`url(#${gapId})`}>
            <path className="skip-p skip-b" d={TRI} fill={paint} style={{ transform: SMALL_T }} />
          </g>
          {/* 大三角（在前）：点击时缩小右移补位 */}
          <path className="skip-p skip-a" d={TRI} fill={paint} />
          {/* 补位后的小三角（在后）：动画后半段显现 */}
          <g mask={`url(#${gapId})`}>
            <path className="skip-p skip-d" d={TRI} fill={paint} style={{ transform: SMALL_T }} />
          </g>
          {/* 新的大三角（在前）：点击时从左侧弹性进入 */}
          <path className="skip-p skip-c" d={TRI} fill={paint} />
        </g>
      </svg>
    </button>
  );
}
