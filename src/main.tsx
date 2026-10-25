import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
// AMLL 歌词组件的全局样式（先引入，便于后续 index.css 覆盖其默认样式）
import "@applemusic-like-lyrics/core/style.css";
import "./index.css";
import { startWatchdog } from "./lib/watchdog";
import { startNetworkMonitor } from "./lib/network";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);

// 播放系统看门狗：每 3 秒体检一次，能就地修复的就地修复（如停掉多余的声音实例），
// 其余只在控制台告警 —— 已移除「自动刷新页面」的行为
startWatchdog();

// 网络质量监测：持续体检，不佳时由 AppLayout 弹出「提示框」
startNetworkMonitor();
