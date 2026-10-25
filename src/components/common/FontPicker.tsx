import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  SYSTEM_FONT,
  getCachedFonts,
  loadSystemFonts,
  quoteFontFamily,
  type FontOption,
} from "@/lib/fonts";

interface FontPickerProps {
  value: string;
  onChange: (family: string) => void;
  className?: string;
}

/**
 * 字体选择器：从系统全局字体中挑选，支持输入名称搜索。
 * Local Font Access API 不可用时退回内置常见字体列表；
 * 也可以直接把输入的文字当作字体名使用（「使用"xxx"」）。
 */
export default function FontPicker({ value, onChange, className }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [fonts, setFonts] = useState<FontOption[]>(() => getCachedFonts());
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 打开时才去读取系统字体
  useEffect(() => {
    if (!open) return;
    if (fonts.length > 0) return;
    setLoading(true);
    void loadSystemFonts()
      .then(setFonts)
      .finally(() => setLoading(false));
  }, [open, fonts.length]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const q = query.trim().toLowerCase();
  const list = useMemo(
    () => (q ? fonts.filter((f) => f.family.toLowerCase().includes(q)) : fonts),
    [fonts, q],
  );

  const isSystem = !value || value === SYSTEM_FONT;
  const display = isSystem ? "系统默认字体" : value;
  const exact = list.some((f) => f.family.toLowerCase() === q);

  const pick = (family: string) => {
    onChange(family);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={boxRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors hover:bg-accent/40"
      >
        <span
          className="truncate text-left"
          style={isSystem ? undefined : { fontFamily: quoteFontFamily(value) }}
        >
          {display}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center gap-2 border-b px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 opacity-50" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (list.length > 0) pick(list[0].family);
                  else if (query.trim()) pick(query.trim());
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder="输入字体名称搜索…"
              className="h-7 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>

          <div className="max-h-60 overflow-y-auto py-1">
            <Row label="系统默认字体" active={isSystem} onClick={() => pick(SYSTEM_FONT)} />
            {list.map((f) => (
              <Row
                key={f.family}
                label={f.family}
                family={f.family}
                active={!isSystem && value === f.family}
                onClick={() => pick(f.family)}
              />
            ))}
            {q && !exact && (
              <Row label={`使用“${query.trim()}”`} onClick={() => pick(query.trim())} />
            )}
            {loading && list.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">读取系统字体中…</div>
            )}
            {!loading && list.length === 0 && q && (
              <div className="px-3 py-2 text-xs text-muted-foreground">没有匹配的字体</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  family,
  active,
  onClick,
}: {
  label: string;
  family?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent",
        active && "bg-accent/60",
      )}
    >
      <span className="truncate" style={family ? { fontFamily: quoteFontFamily(family) } : undefined}>
        {label}
      </span>
      {active && <Check className="h-4 w-4 shrink-0" />}
    </button>
  );
}
