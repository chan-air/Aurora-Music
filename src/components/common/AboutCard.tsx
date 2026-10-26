import { useState, type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DisclaimerDialog } from "@/components/common/DisclaimerDialog";
import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/lib/env";
import { APP_VERSION_LABEL, SOURCE_REPO_LABEL, SOURCE_REPO_URL } from "@/lib/version";

/**
 * 设置页的「关于 / 免责声明」卡片。
 *
 * 存在的意义有两层：
 *  1. 让**装完软件直接用**的人（不一定会去看 GitHub README）也能看到版权声明；
 *  2. 满足 AGPL-3.0 第 13 条的可获取源码要求 —— 界面上给出去处。
 *
 * 版本号来自构建时注入的 `__APP_VERSION__`（唯一来源是 package.json），
 * 所以这里显示的版本与安装包、GitHub tag 不会对不上。
 */

const SUMMARY: ReactNode[] = [
  <>
    仅供个人学习与技术交流，
    <span className="font-medium text-foreground">禁止商业使用</span>。
  </>,
  "非官方客户端：与网易云音乐及其关联公司无任何关系，也未获其授权。",
  "不提供、不存储、不分发任何音频文件；音乐、封面、歌词版权归各自权利人。",
  "通过非官方接口访问数据，可能不符合平台服务条款，使用风险自负。",
  "按 AGPL-3.0「按原样」提供，无任何担保；喜欢请支持正版。",
];

export function AboutCard() {
  const [open, setOpen] = useState(false);

  const openRepo = () => {
    const toast = (msg: string) => useAppStore.getState().showToast(msg);
    // 网页端直接开新标签页；桌面端 WebView 没有可用的外链通道，退化为复制地址
    if (!isTauri() && typeof window !== "undefined") {
      window.open(SOURCE_REPO_URL, "_blank", "noopener,noreferrer");
      return;
    }
    void navigator.clipboard
      .writeText(SOURCE_REPO_URL)
      .then(() => toast("源码地址已复制"))
      .catch(() => toast("复制失败，请手动复制：" + SOURCE_REPO_LABEL));
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>关于 / 免责声明</CardTitle>
          <CardDescription>
            Aurora Music {APP_VERSION_LABEL} · 第三方开源客户端，与网易云音乐官方无任何关联
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            {SUMMARY.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              查看完整声明
            </Button>
            <Button size="sm" variant="ghost" onClick={openRepo} title={SOURCE_REPO_URL}>
              源码仓库（AGPL-3.0）
            </Button>
          </div>
        </CardContent>
      </Card>

      <DisclaimerDialog open={open} onOpenChange={setOpen} acceptLabel="关闭" />
    </>
  );
}
