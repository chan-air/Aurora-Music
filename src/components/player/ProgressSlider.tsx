import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

/**
 * 沉浸歌词页进度条：
 * - 默认细，悬浮变粗，按下/拖动更粗
 * - 无圆球、无光晕，拖动时跟手
 */
interface ProgressSliderProps
  extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  /**
   * 是否正在拖动。触屏没有 hover，:active 在拖动中也未必可靠，
   * 所以「变粗」由状态驱动，保证手指按住时一定变粗。
   */
  dragging?: boolean;
}

const ProgressSlider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  ProgressSliderProps
>(({ className, dragging, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      // 不要写 w-full：在 flex 行里会占满整行、把两侧时间标签挤没
      "group relative flex min-w-0 flex-1 touch-none select-none items-center",
      className,
    )}
    {...props}
  >
    <SliderPrimitive.Track
      className={cn(
        "relative h-1 w-full grow overflow-hidden rounded-full bg-foreground/20 transition-all duration-200 group-hover:h-2 group-active:h-3",
        dragging && "h-3",
      )}
    >
      <SliderPrimitive.Range className="absolute h-full rounded-full bg-foreground" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-5 w-5 rounded-full bg-transparent focus-visible:outline-none" />
  </SliderPrimitive.Root>
));
ProgressSlider.displayName = "ProgressSlider";

export { ProgressSlider };
