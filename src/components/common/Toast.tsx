import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, type ToastItem } from "@/stores/appStore";

/** 每条提示的默认展示时长 */
const TOAST_VISIBLE_MS = 2000;
/** 退场动画时长（与 index.css 的 .toast-rise 一致） */
const TOAST_EXIT_MS = 420;
/** 向上拖动超过这个距离即视为「想让它走」 */
const TOAST_DRAG_UP_PX = 24;
/**
 * 提示框尺寸的总体倍率。
 *
 * 目前是 1（即回到基础尺寸：先前试过 1.5，按反馈调回）。
 * 之所以仍保留这个常量与独立的「倍率层」：胶囊自身的 transform 已被进出场动画的
 * scale 占用，想整体放大只能在这一层做，留个旋钮便于再调。
 */
const STACK_BASE_SCALE = 1;
/** 被压到下方时按层级缩小：**每一层是上一层的 90%**（0.9 / 0.81） */
const STACK_SCALE_RATIO = 0.9;
/** 被压到下方时相对顶部的下移量 */
const STACK_OFFSET_PX = 6;

/**
 * 顶部提示框（toast）堆栈。
 *
 * 多条并存时的规则（按需求）：
 *  - 新的一条从顶部飞入，**旧的被压在它下面**，下面最多压 2 条（共 3 条，见 appStore.TOAST_MAX）；
 *  - 每条**按自己的 2 秒计时**退场，走「向上飞出」的退场动画；
 *  - 有谁离开后，其余各条自动上移回各自的位置（栈位用 transition 过渡）。
 *
 * 关键实现点：**每条提示是独立元素、带唯一 key**。
 * 之前所有提示共用一个元素，只换文字 —— 于是 animation-name 不变，
 * 浏览器不会重新播放入场动画（新的提示看起来没有入场动画）。分元素之后，
 * 新条目天然是一棵新节点，入场动画必定播放。
 *
 * 交互：点击它、或向上拖动它 → 提前退场（同样走退场动画）。
 * 外层容器 pointer-events-none，只有胶囊本身可交互，不挡底下内容。
 */
function ToastItemView({
  item,
  index,
  onGone,
}: {
  item: ToastItem;
  index: number;
  onGone: (id: number) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const dragStartY = useRef<number | null>(null);
  const gone = useRef(false);

  // 自己的 2 秒计时
  useEffect(() => {
    const t = window.setTimeout(() => setLeaving(true), TOAST_VISIBLE_MS);
    return () => window.clearTimeout(t);
  }, []);

  // 退场动画播完后再从队列里移除
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => {
      if (gone.current) return;
      gone.current = true;
      onGone(item.id);
    }, TOAST_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [leaving, item.id, onGone]);

  const dismiss = useCallback(() => {
    dragStartY.current = null;
    setLeaving(true);
  }, []);

  return (
    /*
     * 三层结构，各管一件事，避免 transform 互相覆盖：
     *  外层 = 栈位（纵向错位 + 水平居中 + 层级 + 位置过渡）
     *  中层 = 尺寸倍率（整体 150% 与层级 90%）
     *  内层 = 进出场动画（toast-drop / toast-rise 自带 scale）
     *
     * 水平居中用 flex 的 justify-center，而不是 translate(-50%)：
     * 后者按未缩放的宽度算一半，缩放后就会偏掉；缩放以「上边中点」为原点，
     * 左右对称展开，居中不受影响，纵向也不会顶出屏幕。
     */
    <div
      className="absolute inset-x-0 top-0 flex justify-center"
      style={{
        transform: `translateY(${index * STACK_OFFSET_PX}px)`,
        zIndex: 30 - index,
        transition: "transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      <div
        style={{
          transform: `scale(${(STACK_BASE_SCALE * Math.pow(STACK_SCALE_RATIO, index)).toFixed(4)})`,
          transformOrigin: "center top",
        }}
      >
        <div
          className={`${leaving ? "toast-rise" : "toast-drop"} pointer-events-auto cursor-pointer touch-none select-none whitespace-nowrap rounded-full bg-white px-4 py-2 text-xs font-medium text-neutral-900 opacity-100 shadow-lg shadow-black/25`}
          onClick={dismiss}
          onPointerDown={(e) => {
            dragStartY.current = e.clientY;
          }}
          onPointerMove={(e) => {
            const start = dragStartY.current;
            if (start === null) return;
            if (start - e.clientY > TOAST_DRAG_UP_PX) dismiss();
          }}
          onPointerUp={() => {
            dragStartY.current = null;
          }}
          onPointerCancel={() => {
            dragStartY.current = null;
          }}
        >
          {item.message}
        </div>
      </div>
    </div>
  );
}

export function Toast() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] h-0 px-4">
      {/* 最新的在最上面（栈顶），旧的压在下面 */}
      {[...toasts].reverse().map((item, index) => (
        <ToastItemView key={item.id} item={item} index={index} onGone={dismissToast} />
      ))}
    </div>
  );
}
