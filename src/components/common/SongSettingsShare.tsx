import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAppStore } from "@/stores/appStore";
import { fetchWhoAmI, importSharedSongSettings, type WhoAmI } from "@/lib/share";
import { API_BASE } from "@/lib/env";

/** 从代理地址里取出端口，用于提示其它设备该填什么 */
function apiPort(): string {
  try {
    return new URL(API_BASE).port || "3000";
  } catch {
    return "3000";
  }
}

/**
 * 「本机地址」那一行（放在「共享我的歌曲设置」开关下方）。
 *
 * 为什么要有它：输入框要填的是**共享来源那台设备**的局域网 IP，用户往往不知道该填什么。
 * 浏览器自己读不到局域网 IP，所以问本机代理（GET /share/whoami，见 server/index.js）：
 *   · 请求来自局域网（手机 / 另一台电脑打开本应用）→ 「本机地址：x.x.x.x:3000」；
 *   · 请求来自本机回环（在电脑上开 localhost）    → 老实说明读不到，改显示「服务所在设备 IP」；
 *   · 接口都没拿到（代理没起来）                  → 也给人话说明，不留空白 / undefined。
 *
 * 地址里的 IP 用 <code>：一是等宽更好认，二是可以直接选中复制（浏览器原生可选中）。
 * 挂载时自动拉一次，「刷新」按钮可手动重拉（换 Wi-Fi 后 IP 会变）。
 */
function CurrentDeviceIp() {
  const [data, setData] = useState<WhoAmI | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "fail">("loading");

  const load = useCallback(async () => {
    setState("loading");
    const r = await fetchWhoAmI();
    setData(r);
    setState(r ? "ok" : "fail");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const serverIp = data?.serverIps?.[0] ?? null;
  const clientIp = data?.clientIp ?? null;
  /* 另一台设备要填的是「地址（IP + 端口）」；对方填 IP 也行，端口会自动补上 */
  const address = (ip: string) => `${ip}:${apiPort()}`;

  return (
    <div className="space-y-1 rounded-md bg-muted/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {state === "loading" && "正在读取本机地址…"}
          {state === "fail" && (
            <>
              本机地址：读取不到（本机代理未响应）—— 请确认代理已启动，或点右侧「刷新」重试
            </>
          )}
          {state === "ok" && clientIp && (
            <>
              本机地址：
              <code className="select-text font-mono text-foreground">{address(clientIp)}</code>
              {" —— 在另一台设备上填这个即可添加"}
            </>
          )}
          {state === "ok" && !clientIp && (
            <>
              本机地址：本机访问，无法读取
              {serverIp ? (
                <>
                  ；服务所在设备地址：
                  <code className="select-text font-mono text-foreground">{address(serverIp)}</code>
                </>
              ) : (
                " —— 请在这台电脑上查看局域网 IP"
              )}
            </>
          )}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
        >
          刷新
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {state === "ok" && clientIp
          ? "这就是你现在用的这台设备。在另一台设备（同一 Wi-Fi）上打开本应用，把上面这个地址填进输入框即可一键添加。"
          : serverIp
            ? `在另一台设备（同一 Wi-Fi）上打开本应用，把 ${address(serverIp)} 填进输入框即可一键添加。`
            : `在另一台设备（同一 Wi-Fi）上打开本应用，填入共享来源那台设备的局域网 IP（端口 ${apiPort()} 会自动使用）即可一键添加。`}
      </p>
    </div>
  );
}

/**
 * 歌曲设置共享。
 *
 * 默认关闭；开启后本机代理会对外提供 GET /share/song-settings，
 * 同一局域网内的其它设备在下面填本机 IP 就能一键把歌曲设置添加过去。
 * 发布（POST）由 App 顶层在开关变化与歌曲设置变化时触发，见 lib/share.ts。
 */
export default function SongSettingsShare() {
  const shareSongSettings = useSettingsStore((s) => s.shareSongSettings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useAppStore((s) => s.showToast);
  const [ip, setIp] = useState("");
  const [busy, setBusy] = useState(false);

  const onImport = async () => {
    const target = ip.trim();
    if (!target || busy) return;
    setBusy(true);
    const r = await importSharedSongSettings(target);
    setBusy(false);
    if (!r.ok) {
      showToast("未找到共享设置，请确认对方 IP 与共享开关");
      return;
    }
    const parts = [`已添加 ${r.added} 首`];
    if (r.updated) parts.push(`更新 ${r.updated} 首`);
    if (r.audio) parts.push(`含替换音频 ${r.audio} 首`);
    if (r.skipped) parts.push(`跳过 ${r.skipped} 首（本机较新）`);
    showToast(parts.join("，"));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>歌曲设置共享</CardTitle>
        <CardDescription>
          把自己的逐首歌曲设置（歌词、纯音乐标记等）共享给同一局域网内的其它设备
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label>共享我的歌曲设置</Label>
            <p className="text-xs text-muted-foreground">
              默认关闭。开启后，其它设备在下面填入本机局域网 IP 即可一键添加
            </p>
          </div>
          <Switch
            checked={shareSongSettings}
            onCheckedChange={(v) => update({ shareSongSettings: v })}
          />
        </div>

        {/* 开关下方：本机地址（方便在另一台设备上照着填），可选中复制、可手动刷新 */}
        <CurrentDeviceIp />

        {shareSongSettings && (
          <p className="text-xs text-muted-foreground">
            本机 IP 就是手机访问本应用时用的那个地址（形如 192.168.x.x）；
            对方只需填 IP，端口会自动使用 {apiPort()}。
          </p>
        )}

        <div className="space-y-2 rounded-lg border p-3">
          <Label>从其它设备添加</Label>
          <div className="flex gap-2">
            <Input
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="例如 192.168.0.28"
              onKeyDown={(e) => {
                if (e.key === "Enter") void onImport();
              }}
            />
            <Button onClick={() => void onImport()} disabled={busy || !ip.trim()}>
              {busy ? "添加中…" : "一键添加"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            只添加对方有、本机没有的设置；同一首歌以更新时间较新的为准，不会用旧数据覆盖。
            <br />
            手动替换的音频（本地文件）也会一并同步：发布时经二进制通道上传，导入时取回并存入本机，
            因此改过音源的歌在对方那边同样能直接播放。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
