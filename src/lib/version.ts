/**
 * 应用版本号与「源码仓库」地址。
 *
 * 版本号只有一个来源：`package.json` 的 `version`（与 `src-tauri/tauri.conf.json` 保持一致）。
 * 这里直接 import 那份 JSON —— 开发（vite dev）与生产（vite build / tauri build）都成立。
 *
 * 之前试过用 `define` 注入 `__APP_VERSION__`：生产构建没问题，但 **dev 下不会被替换**，
 * 设置页会显示 "版本 dev"，两个环境行为不一致。直接读 JSON 最稳，代价是 package.json
 * 会进到前端 bundle 里（几百字节，没有敏感信息）。
 *
 * 注意：`v` 前缀只是**展示**用（与 git tag 一致），包内版本号必须是合法 SemVer。
 */
import pkg from "../../package.json";

export const APP_VERSION: string =
  typeof pkg?.version === "string" && pkg.version ? pkg.version : "dev";

/** 展示用版本号（带 v 前缀，例如 v0.0.1-beta） */
export const APP_VERSION_LABEL = APP_VERSION === "dev" ? "dev" : `v${APP_VERSION}`;

/**
 * 源码仓库地址。
 * AGPL-3.0 第 13 条要求：通过网络使用本程序的用户也能拿到完整对应源码，所以这个地址
 * 必须出现在界面里（设置页「关于 / 免责声明」与首次启动的声明弹窗都会显示）。
 */
export const SOURCE_REPO_URL = "https://github.com/chan-air/Aurora-Music";

/** 不带协议的展示形式（窄屏更省地方） */
export const SOURCE_REPO_LABEL = "github.com/chan-air/Aurora-Music";
