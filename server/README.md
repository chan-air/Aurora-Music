# Aurora Music 后端代理

基于 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 的 Node.js 代理服务。

## 启动

```bash
# 在项目根目录执行（会自动安装 server 依赖并启动）
pnpm server

# 或进入 server 目录手动启动
cd server
npm install
npm start
```

默认监听 `0.0.0.0:3000`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |

## 登录（可选，读取 VIP / 私密数据）

个人主页的公开歌单与公开听歌排行无需登录即可读取。
如需读取私密歌单或 VIP 歌曲，请提供登录 Cookie：

1. 登录网页版网易云音乐，打开开发者工具 → 复制请求头里的 `Cookie`（主要是 `MUSIC_U` 字段）。
2. 启动时注入：

   - Windows (PowerShell): `$env:COOKIE="MUSIC_U=xxx"; pnpm server`
   - macOS / Linux: `COOKIE="MUSIC_U=xxx" pnpm server`

3. NeteaseCloudMusicApi 会读取 `COOKIE` 环境变量用于需要登录的接口。
