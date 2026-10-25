# ============================================================================
#  Aurora Music 一键启动
#
#  启动两个东西：
#    1) 本机代理（server/index.js）—— 端口 3000，负责访问网易云接口、图片透传、歌曲设置共享
#    2) 网页端（Vite）—— 端口 1420，就是你平时打开的那个页面
#
#  用法：双击 start.cmd（推荐），或右键本文件「使用 PowerShell 运行」。
#  停止：关掉它开出来的那两个窗口即可。
# ============================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  [注意] $text" -ForegroundColor Yellow }
function Fail($text) {
  Write-Host "  [失败] $text" -ForegroundColor Red
  Write-Host ''
  Read-Host '按回车键关闭'
  exit 1
}

function Test-Port([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Get-LanIp {
  try {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -First 1 -ExpandProperty IPAddress
    return $ip
  } catch { return $null }
}

Write-Host ''
Say '==========================================' 'Cyan'
Say '   Aurora Music  一键启动' 'Cyan'
Say '==========================================' 'Cyan'
Write-Host ''

# ---------------------------------------------------------------- 1) 检查 Node
Say '[1/4] 检查 Node.js ...'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail '找不到 node 命令。请先安装 Node.js 18 或更高版本：https://nodejs.org/  安装后重新打开本窗口。'
}
$ver = (& node --version).Trim()
Ok "Node $ver（$($node.Source)）"

# ------------------------------------------------------------ 2) 按需安装依赖
Say '[2/4] 检查依赖 ...'
if (-not (Test-Path (Join-Path $root 'node_modules\vite'))) {
  Warn '首次运行，正在安装网页端依赖（可能要几分钟）...'
  & npm install
  if ($LASTEXITCODE -ne 0) { Fail '网页端依赖安装失败。' }
  Ok '网页端依赖安装完成'
} else {
  Ok '网页端依赖已存在'
}
if (-not (Test-Path (Join-Path $root 'server\node_modules'))) {
  Warn '正在安装代理依赖（server/ 下）...'
  Push-Location (Join-Path $root 'server')
  & npm install
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Fail '代理依赖安装失败。' }
  Ok '代理依赖安装完成'
} else {
  Ok '代理依赖已存在'
}

# -------------------------------------------------------------- 3) 启动代理
Say '[3/4] 启动本机代理（端口 3000）...'
if (Test-Port 3000) {
  Warn '端口 3000 已有服务在跑，跳过启动（不会重复启动）'
} else {
  Start-Process -FilePath 'node' -ArgumentList 'server/index.js' -WorkingDirectory $root `
    -WindowStyle Minimized -ErrorAction Stop
  # 代理启动较慢（要加载网易云接口库），最多等 40 秒
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Port 3000) { $ready = $true; break }
  }
  if ($ready) { Ok '代理已就绪（3000）' } else { Warn '代理还没监听 3000，可能仍在启动，请稍等或看那个最小化的窗口' }
}

# ------------------------------------------------------------ 4) 启动网页端
Say '[4/4] 启动网页端（端口 1420）...'
if (Test-Port 1420) {
  Warn '端口 1420 已有服务在跑，跳过启动（不会重复启动）'
} else {
  Start-Process -FilePath 'node' -ArgumentList 'node_modules/vite/bin/vite.js', '--port', '1420' `
    -WorkingDirectory $root -WindowStyle Minimized -ErrorAction Stop
  $ready = $false
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Port 1420) { $ready = $true; break }
  }
  if ($ready) { Ok '网页端已就绪（1420）' } else { Warn '网页端还没监听 1420，请看那个最小化的窗口' }
}

# ------------------------------------------------------------------ 结果汇总
Write-Host ''
Say '==========================================' 'Cyan'
Say '  已启动，用这些地址打开：' 'Cyan'
Say '==========================================' 'Cyan'
Say '  本机浏览器：  http://localhost:1420' 'White'
$lan = Get-LanIp
if ($lan) {
  Say "  手机 / 平板： http://${lan}:1420   （同一 Wi-Fi）" 'White'
} else {
  Warn '没读到局域网 IP，请用 ipconfig 自行查看'
}
Write-Host ''
Say '  说明：' 'DarkGray'
Say '    · 手机访问时用上面那个局域网地址，localhost 在手机上指的是手机自己' 'DarkGray'
Say '    · 关掉那两个最小化的窗口即可停止服务' 'DarkGray'
Say '    · 页面若有异常，先按 Ctrl+Shift+R 硬刷新' 'DarkGray'
Write-Host ''
Read-Host '按回车键关闭本窗口（服务会继续在后台运行）'
