import { SlidersHorizontal } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";

/**
 * 锁屏兼容（进阶设置）。
 *
 * 控制 iPhone / WebKit 锁屏媒体会话的两种行为。它们不是一次性实验，
 * 而是三件事互相牵制后定下来的正式开关，默认值就是**实机验证过可用的那套组合**：
 *
 *   · 不撤回 seekbackward / seekforward（mediaSession.ts 的 WITHDRAW_SEEK_ACTIONS = false）
 *     → 锁屏**进度条可拖**；代价是系统默认的「±10 秒」进退键会顶掉我们注册的 ⏮/⏭。
 *   · 显式撤回这两个动作 → 锁屏恢复 ⏮/⏭，但**进度条变回只读**（两次实机验证）。
 *   · 关掉「把 <audio> 挂进文档」→ 锁屏的动作回调收不到（已实测）。
 *   · 关掉「每秒推 positionState」→ 进度条很可能不再可拖。
 *
 * 所以：**改默认值 / 改这里的开关之前，请先读上面这段取舍**。
 */

/** 当前组合的实际后果（按实机验证过的结论如实陈述） */
function consequence(mount: boolean, push: boolean): string {
  if (mount && push) {
    return "当前组合（已验证可用）：进度条可拖、锁屏按钮与切歌回调可用；锁屏的进退键是系统默认的「±10 秒」（⏮/⏭ 被它顶掉）。";
  }
  if (!mount && push) {
    return "已实测：<audio> 游离时锁屏的**动作回调收不到**，进度条与按钮都不响应。";
  }
  if (mount && !push) {
    return "预计：不周期推位置后，进度条很可能不再可拖（推 positionState 是可拖的前提之一）。";
  }
  return "两个都关 = 回到最早那版：锁屏只有歌名/歌词等信息，按钮与进度条都不响应。";
}

export default function LockCompatExperiment() {
  const mount = useSettingsStore((s) => s.lockMountAudio);
  const push = useSettingsStore((s) => s.lockPushPosition);
  const update = useSettingsStore((s) => s.update);

  return (
    // data-* 便于在浏览器里定位这张卡片（取证/自测时用）
    <div data-lock-compat-experiment>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4" />
            锁屏兼容（进阶）
          </CardTitle>
          <CardDescription>
            控制手机锁屏（Media Session）的两种行为。默认值就是<b>实机验证过可用的组合</b>，
            一般不需要动；改动前请先读下面的取舍说明。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label>把 &lt;audio&gt; 挂进文档</Label>
              <p className="text-xs text-muted-foreground">
                开（默认）：把 Howler 的音频节点放进页面里，WebKit 会因此为它建立媒体会话，
                锁屏的按钮 / 拖动回调才收得到。
                关：恢复“游离节点”的老写法 —— 已实测锁屏动作回调会收不到，仅供排查用。
              </p>
            </div>
            <Switch checked={mount} onCheckedChange={(v) => update({ lockMountAudio: v })} />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label>每秒推 positionState</Label>
              <p className="text-xs text-muted-foreground">
                开（默认）：每秒把播放位置写给系统，锁屏进度条据此保持可拖（拖动时会自动让位，
                不会和手抢滑块）。
                关：只在播放 / 搜索 / 首次拿到时长时推 —— 进度条很可能不再可拖。
              </p>
            </div>
            <Switch checked={push} onCheckedChange={(v) => update({ lockPushPosition: v })} />
          </div>

          <Separator />

          <div className="space-y-1.5 text-xs">
            <p className="text-foreground">
              当前组合：挂载 &lt;audio&gt; = <b>{mount ? "开" : "关"}</b>　每秒推 positionState ={" "}
              <b>{push ? "开" : "关"}</b>
            </p>
            <p className="text-muted-foreground">{consequence(mount, push)}</p>
            <p className="text-muted-foreground">
              <b>另一处取舍（不在本卡片，改代码才生效）：</b>显式撤回 seekbackward / seekforward
              → 锁屏恢复 <b>⏮/⏭</b>，但进度条会变回只读（两次实机验证）。当前选择是不撤回，
              优先保证进度条可拖。见 <code>src/lib/mediaSession.ts</code> 的
              <code> WITHDRAW_SEEK_ACTIONS</code>。
            </p>
            <p className="text-muted-foreground">
              <b>验证方法：</b>改完开关后<b>硬刷新页面</b> → 播放一首 → 锁屏上看：
              ① 进度条能不能拖；② 进退键是 ⏮/⏭ 还是系统默认的 ±10 秒。
            </p>
            <p className="text-muted-foreground">
              这两个开关<b>立即生效</b>（不用重启服务）：关掉挂载会把正在播放的 &lt;audio&gt;
              移出文档，关掉推送会立刻停掉那个 1 秒定时器（移出/挂上都不会打断播放）。
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
