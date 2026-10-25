import { useRef, type MouseEvent, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface GlowButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

/**
 * Apple Music 风格按钮：
 * - 默认透明背景
 * - 悬停时出现高亮光晕
 * - 轻微跟随鼠标移动（磁吸）
 * - 按下时缩放动画
 */
export default function GlowButton({ children, className, ...props }: GlowButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);

  const handleMove = (e: MouseEvent<HTMLButtonElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / r.width; // -0.5 ~ 0.5
    const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
    el.style.translate = `${(dx * 6).toFixed(2)}px ${(dy * 6).toFixed(2)}px`;
  };

  const handleLeave = () => {
    const el = ref.current;
    if (el) el.style.translate = "0px 0px";
  };

  return (
    <button
      ref={ref}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      className={cn(
        "group relative grid h-11 w-11 place-items-center rounded-full text-foreground/60",
        "transition-all duration-150 ease-out hover:text-foreground active:scale-90",
        className,
      )}
      {...props}
    >
      {/* 高亮光晕 */}
      <span className="pointer-events-none absolute inset-0 rounded-full bg-foreground/0 transition-all duration-200 group-hover:bg-foreground/10 group-hover:shadow-[0_0_22px_rgba(255,255,255,0.35)]" />
      <span className="relative">{children}</span>
    </button>
  );
}
