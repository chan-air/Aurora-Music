import { useEffect, useState } from "react";
import { DisclaimerDialog } from "@/components/common/DisclaimerDialog";
import { APP_VERSION } from "@/lib/version";
import { getDisclaimerAccepted, saveDisclaimerAccepted } from "@/lib/storage";

/**
 * 首次启动的免责声明闸门。
 *
 * 行为：
 *  · 启动时读一次「是否同意过」（网页端 localStorage / 桌面端 SQLite，见 storage.ts）；
 *  · 没同意过 → 弹一次声明；点「我已了解」才写入记录，之后不再打扰；
 *  · 点 X / Esc / 点遮罩直接关掉 = **不记录**，下次启动继续弹（不给"一关了之"留后门）。
 *  · 读取失败一律当作"没同意过"：宁可多弹一次，也不要默默跳过声明。
 */
export function DisclaimerGate() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const accepted = await getDisclaimerAccepted().catch(() => null);
      if (alive && !accepted) setOpen(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <DisclaimerDialog
      open={open}
      onOpenChange={setOpen}
      onAccept={() => {
        // 记录失败也不阻塞使用：下次启动会再弹一次而已
        void saveDisclaimerAccepted(APP_VERSION).catch(() => {});
      }}
    />
  );
}
