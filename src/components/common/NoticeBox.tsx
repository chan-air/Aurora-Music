import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { popModal, pushModal } from "@/lib/modal";

interface NoticeBoxProps {
  open: boolean;
  /** 标题（参考系统弹窗：粗体一行，靠左上） */
  title?: string;
  /** 正文文案（居中） */
  message: string;
  /** 按钮文案，默认「知道了」 */
  actionLabel?: string;
  onAction: () => void;
}

/** 大矩形跟随指针的比例（按钮是它的子元素，会一起动，不再有额外位移） */
const BOX_FOLLOW = 0.045;
/** 按钮外框与大矩形外框之间的间距（四周一致），同时决定按钮圆角以实现同心 */
const KERNING = 12;
const BOX_RADIUS = 34;
/** 同心圆角：外圆角半径 - 间距 */
const BTN_RADIUS = BOX_RADIUS - KERNING;

/**
 * 提示框（全局统一的信息提示）：
 * - 屏幕正中央；标题靠左上、正文居中、按钮整宽
 * - 一整块半透明圆角矩形，指针移上去（鼠标悬浮 / 触屏长按拖动）时有很淡的跟随高光，
 *   并整体轻微位移；按钮作为子元素跟着一起动，不额外位移
 * - 按钮与大矩形四周等距、圆角同心
 *
 * 布局比例参考系统弹窗：标题略大且位于左上角，正文居中，按钮整宽、高度略大于一行文字。
 */
export default function NoticeBox({
  open,
  title,
  message,
  actionLabel = "知道了",
  onAction,
}: NoticeBoxProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  /** 指针相对盒子中心的位移 → 驱动盒子（按钮继承）位移 */
  const [rel, setRel] = useState({ x: 0, y: 0 });
  /** 高光中心（相对盒子左上角） */
  const [gloss, setGloss] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);
  const [pressed, setPressed] = useState(false);
  /** 入场动画进行中：结束后必须摘掉，否则动画的 transform 会一直压住位移 */
  const [entering, setEntering] = useState(true);

  /** 基准（建立时盒子 transform 还是 0，量到的是布局位置） */
  const baseRef = useRef<{ left: number; top: number; cx: number; cy: number } | null>(null);

  const reset = () => {
    setRel({ x: 0, y: 0 });
    setActive(false);
    setPressed(false);
    baseRef.current = null;
  };

  useEffect(() => {
    if (!open) reset();
    else setEntering(true);
  }, [open]);

  // 弹窗打开期间给全局监听上闸：下方元素不响应鼠标
  useEffect(() => {
    if (!open) return;
    pushModal();
    return () => popModal();
  }, [open]);

  if (!open) return null;

  /** 建立基准（若已存在则复用） */
  const ensureBase = () => {
    if (baseRef.current) return baseRef.current;
    const box = boxRef.current;
    if (!box) return null;
    const r = box.getBoundingClientRect();
    const base = {
      left: r.left,
      top: r.top,
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
    };
    baseRef.current = base;
    setActive(true);
    return base;
  };

  /** 统一的跟随计算：鼠标移动与触屏拖动共用 */
  const follow = (clientX: number, clientY: number) => {
    const base = ensureBase();
    if (!base) return;
    setRel({ x: clientX - base.cx, y: clientY - base.cy });
    setGloss({ x: clientX - base.left, y: clientY - base.top });
  };

  const boxTx = rel.x * BOX_FOLLOW;
  const boxTy = rel.y * BOX_FOLLOW;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/35 px-6 backdrop-blur-[3px]">
      {/* 大圆角矩形本体 */}
      <div
        ref={boxRef}
        onMouseEnter={() => ensureBase()}
        onMouseMove={(e) => follow(e.clientX, e.clientY)}
        onMouseLeave={reset}
        // 触屏：长按拖动与鼠标悬浮同效（位置 + 高光）
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") return;
          follow(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.pointerType === "mouse") return;
          follow(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          if (e.pointerType !== "mouse") reset();
        }}
        onPointerCancel={(e) => {
          if (e.pointerType !== "mouse") reset();
        }}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget && e.animationName === "notice-in") setEntering(false);
        }}
        className={cn(
          "relative w-full max-w-[26rem] select-none overflow-hidden bg-foreground/[0.07]",
          "shadow-[0_24px_70px_-20px_rgba(0,0,0,0.75)] ring-1 ring-inset ring-foreground/15",
          "backdrop-blur-2xl",
        )}
        style={{
          borderRadius: BOX_RADIUS,
          padding: KERNING,
          transform: `translate(${boxTx.toFixed(2)}px, ${boxTy.toFixed(2)}px)`,
          transition: active
            ? "transform 0.18s cubic-bezier(0.22, 1, 0.36, 1)"
            : "transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)",
          animation: entering ? "notice-in 0.34s cubic-bezier(0.22, 1, 0.36, 1) both" : undefined,
        }}
      >
        {/* 跟随指针的高光：很淡，只在边缘透出一点 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            borderRadius: BOX_RADIUS,
            background: `radial-gradient(170px circle at ${gloss.x.toFixed(0)}px ${gloss.y.toFixed(0)}px, rgba(255,255,255,0.035), transparent 62%)`,
            opacity: active ? 1 : 0,
            transition: "opacity 0.4s ease",
          }}
        />
        {/* 顶部一道细高光，强化玻璃边缘 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-foreground/25 to-transparent"
        />

        {/* 标题：左上角；正文：居中 */}
        <div className="relative px-6 pb-2 pt-2">
          {title && (
            <div className="text-left text-[19px] font-semibold leading-tight text-foreground/85">
              {title}
            </div>
          )}
          {/* 正文：居中 */}
          <p
            className={cn(
              "text-center text-[16px] leading-relaxed text-foreground/65",
              title && "mt-1.5",
            )}
          >
            {message}
          </p>
        </div>

        {/* 按钮：整宽，与大矩形四周等距、圆角同心；作为子元素随大矩形一起移动 */}
        <button
          type="button"
          onClick={onAction}
          onPointerDown={() => setPressed(true)}
          onPointerUp={() => setPressed(false)}
          onPointerCancel={() => setPressed(false)}
          className={cn(
            "relative mt-4 flex w-full items-center justify-center py-4",
            "bg-foreground/[0.07] text-[18px] font-medium text-foreground/85",
            "shadow-[0_10px_30px_-12px_rgba(0,0,0,0.7)] ring-1 ring-inset ring-foreground/15",
            "backdrop-blur-2xl transition-[background-color,transform] duration-200",
            "hover:bg-foreground/[0.12] focus-visible:outline-none",
          )}
          style={{
            borderRadius: BTN_RADIUS,
            transform: `scale(${pressed ? 0.985 : 1})`,
            transition:
              "transform 0.14s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.2s ease",
          }}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
