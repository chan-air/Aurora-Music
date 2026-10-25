# 应用图标

`tauri build` 需要以下图标文件，请在首次构建前用 Tauri CLI 从源图标生成：

```bash
# 在项目根目录执行（@tauri-apps/cli 已安装）
pnpm tauri icon src-tauri/icons/icon.svg
```

该命令会自动生成 `32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`、`icon.ico`
以及 Android / iOS 所需的各尺寸图标到 `src-tauri/icons/` 目录。

> 建议源图标为正方形，分辨率 >= 1024x1024。默认提供的 `icon.svg` 可作为占位源图。
