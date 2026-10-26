import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

/*
 * 版本号不在这里注入：`src/lib/version.ts` 直接 import `package.json` 的 `version`。
 * 试过用 define 注入 __APP_VERSION__，生产构建能替换、**dev 下不会**，会导致设置页
 * 在开发时显示 "版本 dev"，两个环境不一致（已实测）。
 */

// Tauri 2 开发服务器固定使用 1420 端口（与 src-tauri/tauri.conf.json 的 devUrl 对应）
const host = process.env.TAURI_DEV_HOST;

/**
 * AMLL 里「间奏小白点」的出现阈值被写死在它的产物中：
 *
 *   // 判定为间奏所需的最小空隙时长
 *   const MIN_INTERLUDE_GAP = Duration.fromMillis(7e3);   // 7 秒
 *
 * 需求是这个阈值取 6 秒（空隙超过 6 秒就出现小白点，包括歌曲开头到第一句之间那段）。
 * 开发与生产两条管线都要改写，方式不同：
 *
 *  - 开发：依赖会被预打包，产物不再经过 Vite 的 transform，所以要在**预打包阶段**
 *    用 esbuild 插件改写（见下面的 optimizeDeps.esbuildOptions.plugins）。
 *    注意**不能**改用 optimizeDeps.exclude ——那样 AMLL 及其整条依赖链（pixi.js /
 *    gl-matrix / url…）都会变成未预打包的裸模块，其中 url 的模块互通会直接抛
 *    SyntaxError，页面整个白屏。
 *  - 生产：rollup 会处理依赖，直接用 Vite 的 transform 钩子即可。
 *
 * 两处都用同一对常量；匹配不到时明确告警，不静默失效。
 */
const AMLL_GAP_NEEDLE = "const MIN_INTERLUDE_GAP = Duration.fromMillis(7e3);";
const AMLL_GAP_REPLACEMENT = "const MIN_INTERLUDE_GAP = Duration.fromMillis(6e3);";

function patchAmllInterludeGap(code: string, id: string): string | null {
  if (!id.includes("applemusic-like-lyrics")) return null;
  if (!code.includes(AMLL_GAP_NEEDLE)) {
    if (id.includes("amll-core")) {
      console.warn("[aurora] 未能在 AMLL 产物中找到间奏阈值常量，6 秒阈值未生效：", id);
    }
    return null;
  }
  return code.replace(AMLL_GAP_NEEDLE, AMLL_GAP_REPLACEMENT);
}

/** 生产构建用：rollup 处理依赖时改写 */
function amllInterludeGap() {
  return {
    name: "aurora-amll-interlude-gap",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      const next = patchAmllInterludeGap(code, id);
      return next === null ? null : { code: next, map: null };
    },
  };
}

export default defineConfig({
  optimizeDeps: {
    // 开发用：在预打包阶段改写（预打包产物不会再经过 transform）
    esbuildOptions: {
      plugins: [
        {
          name: "aurora-amll-interlude-gap-dep",
          setup(build: {
            onLoad: (
              opts: { filter: RegExp },
              cb: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>,
            ) => void;
          }) {
            build.onLoad({ filter: /applemusic-like-lyrics.*amll-core\.mjs$/ }, async (args) => {
              const fs = await import("node:fs/promises");
              const code = await fs.readFile(args.path, "utf8");
              return { contents: patchAmllInterludeGap(code, args.path) ?? code, loader: "js" };
            });
          },
        },
      ],
    },
  },
  plugins: [amllInterludeGap(), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // 阻止 Vite 清屏，避免吞掉 Tauri 的错误输出
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 监听所有网卡，局域网内其它设备（手机 / 平板）也能通过本机 IP:1420 访问
    host: host || true,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      /*
       * 编辑器原子写入会留下 .*.tmpdir / *.tmp，Windows 下偶发被锁导致 watcher EBUSY 崩溃。
       * 同理，放在工程根目录的歌词/音频素材（.ttml / .lrc / .ass 等）常被播放器、编辑器
       * 或网盘同步进程占用 —— 它们不是源码、也不会被 import，Vite 完全没有必要监听；
       * 一旦被锁，FSWatcher 会抛 EBUSY 并让整个 dev server 直接退出。
       */
      ignored: [
        "**/src-tauri/**",
        "**/.*.tmpdir/**",
        "**/*.tmp",
        "**/*.ttml",
        "**/*.lrc",
        "**/*.ass",
        "**/*.srt",
        "**/*.mp3",
        "**/*.flac",
        "**/*.m4a",
        "**/*.wav",
      ],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
