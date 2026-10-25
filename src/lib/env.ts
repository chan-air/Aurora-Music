/** 是否运行在 Tauri 环境（桌面 / 移动端原生容器） */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * NeteaseCloudMusicApi 代理地址，可通过 VITE_API_BASE 覆盖。
 * 默认跟随当前页面主机名（端口 3000），这样用手机访问 http://<本机IP>:1420 时，
 * 接口会自动指向 http://<本机IP>:3000，而不是手机自己的 localhost。
 */
function defaultApiBase(): string {
  /*
   * Tauri 原生容器里 location.hostname 是 `tauri.localhost`，
   * 用它拼接口地址会变成 http://tauri.localhost:3000 —— 那个服务并不存在，
   * 打包后的桌面应用必然连不上。桌面端代理就跑在本机，固定指向 127.0.0.1。
   *
   * 移动端（Android / iOS）代理不在手机上，需在构建时用 VITE_API_BASE
   * 指定一个手机能访问到的服务地址（见文件头的覆盖逻辑）。
   */
  if (isTauri()) return "http://127.0.0.1:3000";
  if (typeof location !== "undefined" && location.hostname) {
    // 本机访问时用 127.0.0.1：代理只监听 IPv4，走 localhost 可能被解析到 ::1 而失败
    const host = location.hostname === "localhost" ? "127.0.0.1" : location.hostname;
    return `http://${host}:3000`;
  }
  return "http://127.0.0.1:3000";
}

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) || defaultApiBase();
