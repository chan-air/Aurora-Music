import { Link } from "react-router-dom";
import { Disc3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "./nav";
import { useNavHighlight } from "./useNavHighlight";

/**
 * 横屏侧边导航。
 *
 * 与 BottomNav 同理：高亮改用 useNavHighlight() 显式判断，
 * 不再依赖 NavLink 的自动匹配（那会让 /favorites、/playlist/:id 等页面无高亮）。
 * 未选中项的 hover:bg-accent / hover:text-foreground 与选中项的反色样式原样保留。
 */
export default function Sidebar() {
  const active = useNavHighlight();
  return (
    <aside className="flex w-52 shrink-0 flex-col gap-1 border-r bg-card/40 p-3">
      <div className="flex items-center gap-2 px-2 py-4">
        <Disc3 className="h-8 w-8 text-primary" />
        <div>
          <div className="text-gradient text-lg font-bold leading-none">Aurora Music</div>
          <div className="mt-1 text-[10px] text-muted-foreground">网易云音乐播放器</div>
        </div>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map(({ to, label, icon: Icon }, i) => (
          <Link
            key={to}
            to={to}
            aria-current={active === i ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active === i
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto px-2 py-3 text-[11px] text-muted-foreground/70">
        Web · Windows · macOS · Linux · Android · iOS
      </div>
    </aside>
  );
}
