import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/lib/env";
import { APP_VERSION_LABEL, SOURCE_REPO_LABEL, SOURCE_REPO_URL } from "@/lib/version";

/**
 * 版权与免责声明（**首次启动弹窗**与设置页「关于」卡片共用）。
 *
 * 文案刻意保持"短句 + 分条"：用户基本不会逐字读，写得越像法律文书越会被直接点掉；
 * 这里的目标是让他至少扫到三件事 ——
 *   ① 仅供学习交流、禁止商用；② 与网易云官方无关、不含任何音源；③ 风险自负、支持正版。
 *
 * 关闭方式：
 *  · 首次启动弹窗里点「我已了解」→ 记录到本地，之后不再弹（见 DisclaimerGate）；
 *  · 直接点右上角 X / 按 Esc / 点遮罩 = 关闭但**不记录**，下次启动还会弹。
 */

const POINTS: { key: string; text: string }[] = [
  {
    key: "用途",
    text: "仅供个人学习、技术研究与交流使用，禁止任何形式的商业使用（含付费分发、捆绑销售、承接商业项目）。",
  },
  {
    key: "归属",
    text: "本项目是非官方客户端，与网易云音乐（杭州网易云音乐科技有限公司）及其关联公司没有任何关系，也未获得其授权或认可。",
  },
  {
    key: "音源",
    text: "不提供、不存储、不分发任何音频文件，也不内置账号凭据；音乐、封面、歌词的版权归各自权利人所有。",
  },
  {
    key: "接口",
    text: "通过非官方接口访问数据，这类用法可能不符合相关平台的服务条款，也可能随平台调整随时失效；是否使用由你自行判断，风险自负。",
  },
  {
    key: "正版",
    text: "喜欢请通过官方渠道购买会员、专辑与数字音乐。请勿用于破解付费内容、绕过版权限制、批量下载或二次分发。",
  },
  {
    key: "担保",
    text: "本项目按 AGPL-3.0「按原样（AS IS）」提供，不附带任何明示或默示担保，作者不对使用后果承担责任。",
  },
];

/** 源码仓库：网页端直接开新标签页；桌面端没有可用的外链通道，改为复制地址 */
function SourceRepoLink() {
  const toast = (msg: string) => useAppStore.getState().showToast(msg);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(SOURCE_REPO_URL);
      toast("源码地址已复制");
    } catch {
      toast("复制失败，请手动选择地址复制");
    }
  };

  if (isTauri()) {
    return (
      <button
        type="button"
        onClick={() => void copy()}
        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        title="点击复制源码地址"
      >
        {SOURCE_REPO_LABEL}
      </button>
    );
  }

  return (
    <a
      href={SOURCE_REPO_URL}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
    >
      {SOURCE_REPO_LABEL}
    </a>
  );
}

export function DisclaimerDialog({
  open,
  onOpenChange,
  onAccept,
  acceptLabel = "我已了解",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 点「我已了解」时调用（用来落同意记录）；不传就只关闭 */
  onAccept?: () => void;
  acceptLabel?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>使用前请阅读</DialogTitle>
          <DialogDescription>
            这是一个第三方开源客户端，不是网易云音乐官方产品。
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 text-xs leading-relaxed">
          {POINTS.map((p) => (
            <li key={p.key} className="flex gap-2">
              <span className="mt-[2px] shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {p.key}
              </span>
              <span className="text-muted-foreground">{p.text}</span>
            </li>
          ))}
        </ul>

        <DialogFooter className="mt-2 gap-3 sm:justify-between">
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            版本 {APP_VERSION_LABEL} · 源码（AGPL-3.0）：<SourceRepoLink />
          </span>
          <Button
            size="sm"
            onClick={() => {
              onAccept?.();
              onOpenChange(false);
            }}
          >
            {acceptLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
