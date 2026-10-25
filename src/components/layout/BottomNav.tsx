import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "./nav";
import { useNavHighlight } from "./useNavHighlight";

/**
 * 鼠标端底部导航。
 *
 * 高亮**不用 NavLink 的自动匹配**：/favorites、/history、/song-settings、
 * /playlist/:id 这些页面本身不属于任何一项，自动匹配会让四项全部无高亮。
 * 改由 useNavHighlight() 统一解析（归属匹配 + 「从哪来回哪去」的退路），
 * 视觉类名与 hover/active 表现保持原样。
 */
export default function BottomNav() {
  const active = useNavHighlight();
  return (
    <nav className="flex border-t bg-card/60 backdrop-blur">
      {NAV_ITEMS.map(({ to, label, icon: Icon }, i) => (
        <Link
          key={to}
          to={to}
          aria-current={active === i ? "page" : undefined}
          className={cn(
            "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] transition-colors",
            active === i ? "text-primary" : "text-muted-foreground",
          )}
        >
          <Icon className="h-5 w-5" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
