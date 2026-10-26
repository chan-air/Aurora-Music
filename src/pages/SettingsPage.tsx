import { useSettingsStore } from "@/stores/settingsStore";
import {
  AUTO_COLLAPSE_DELAY_MS,
  DOCK_COLLAPSE_DISTANCE_MAX,
  DOCK_COLLAPSE_DISTANCE_MIN,
  glassBounceY1,
  glassPress,
  glassSnapMs,
  type AppSettings,
  type SpringParams,
  type DoubleClickAction,
  type AlignAnchor,
  type AutoCollapseSensitivity,
  type CloseButtonSensitivity,
  type SettingsProfileKey,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { AboutCard } from "@/components/common/AboutCard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import FontPicker from "@/components/common/FontPicker";
import SongSettingsShare from "@/components/common/SongSettingsShare";
import LockCompatExperiment from "@/components/common/LockCompatExperiment";
import GlassDockPreview from "@/components/settings/GlassDockPreview";

/** 4 档设备状态的显示名 */
const PROFILE_LABEL: Record<SettingsProfileKey, string> = {
  touch_landscape: "触屏 · 横屏",
  touch_portrait: "触屏 · 竖屏",
  mouse_landscape: "鼠标 · 横屏",
  mouse_portrait: "鼠标 · 竖屏",
};

/** 关闭键灵敏度档位对应的行为说明 */
const SENSITIVITY_HINT: Record<CloseButtonSensitivity, string> = {
  low: "鼠标待在关闭键周围区域内即使不动也不隐藏；离开该区域满 5s 才隐藏，且必须靠得非常近才会重新出现",
  medium: "鼠标静止 3s 即隐藏；移到关闭键周围稍大一圈的范围内重新出现",
  high: "鼠标静止 5s 才隐藏；只要鼠标一动就重新出现",
};

/** 自动折叠灵敏度档位的说明（时长取自 AUTO_COLLAPSE_DELAY_MS，不写死） */
function autoCollapseHint(v: AutoCollapseSensitivity): string {
  const sec = AUTO_COLLAPSE_DELAY_MS[v] / 1000;
  return v === "high"
    ? `展开后静置 ${sec} 秒无任何交互就自动折成一行（最容易折叠）`
    : `展开后静置 ${sec} 秒无任何交互就自动折成一行`;
}

export default function SettingsPage() {
  const s = useSettingsStore();
  const update = useSettingsStore((st) => st.update);
  const reset = useSettingsStore((st) => st.reset);
  const showToast = useAppStore((st) => st.showToast);

  const patch = (p: Partial<AppSettings>) => update(p);

  /** 按压形变当前落到的实际几何（说明文案要写「现在是多少」，不能只写两端） */
  const press = glassPress(s.glassPressDeform);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">设置</h2>
          <p className="text-sm text-muted-foreground">所有改动会自动保存</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            reset();
            showToast("已恢复默认设置");
          }}
        >
          恢复默认
        </Button>
      </div>

      {/* 通用 */}
      <Card>
        <CardHeader>
          <CardTitle>通用</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>网易云个人主页链接</Label>
            <Input
              value={s.neteaseHomeUrl}
              placeholder="https://music.163.com/#/user/home?id=…"
              onChange={(e) => patch({ neteaseHomeUrl: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              保存后，首页解析会默认填入该链接
            </p>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>双击歌曲的行为</Label>
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {(
                [
                  { value: "next", label: "插到下一首" },
                  { value: "append", label: "加到末尾" },
                  { value: "replace", label: "替换队列" },
                ] as { value: DoubleClickAction; label: string }[]
              ).map((o) => (
                <button
                  key={o.value}
                  onClick={() => patch({ doubleClickAction: o.value })}
                  className={cn(
                    "flex-1 rounded-md px-3 py-1.5 text-sm transition-colors",
                    s.doubleClickAction === o.value
                      ? "bg-background text-foreground shadow"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              单击选中，双击执行该动作（替换 = 用当前列表播放该曲）
            </p>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>进入歌词页时自动全屏</Label>
              <p className="text-xs text-muted-foreground">打开全屏歌词时，让网页进入全屏模式</p>
            </div>
            <Switch
              checked={s.fullscreenOnLyrics}
              onCheckedChange={(v) => patch({ fullscreenOnLyrics: v })}
            />
          </div>

          {/*
            与上面那条是**两个方向**的联动：上面是「打开歌词页 → 顺便全屏」，
            这条是「网页进入全屏 → 顺便打开歌词页」。两者互相幂等，不会来回抖。
            只在电脑端显示：触屏端的全屏多由系统手势 / WebView 接管，行为不可控。
          */}
          {!s.touch && (
            <>
              <Separator />

              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label>沉浸歌词跟随全屏</Label>
                  <p className="text-xs text-muted-foreground">
                    网页进入全屏（含浏览器 F11 全屏）时自动打开沉浸歌词页，退出全屏时自动关闭（仅电脑端）
                  </p>
                </div>
                <Switch
                  checked={s.lyricsFollowFullscreen}
                  onCheckedChange={(v) => patch({ lyricsFollowFullscreen: v })}
                />
              </div>
            </>
          )}

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>歌曲预加载</Label>
              <p className="text-xs text-muted-foreground">
                播放当前歌曲时，提前加载上一首 / 下一首的音频、歌词与封面，让切歌更顺滑
              </p>
            </div>
            <Switch
              checked={s.preloadEnabled}
              onCheckedChange={(v) => patch({ preloadEnabled: v })}
            />
          </div>

          <Separator />

          <div className="space-y-1.5">
            <Label>软件字体</Label>
            <FontPicker value={s.appFontFamily} onChange={(v) => patch({ appFontFamily: v })} />
            <p className="text-xs text-muted-foreground">
              界面与歌曲信息使用的字体，可从系统全局字体中选择（支持输入名称搜索）
            </p>
          </div>

          <Separator />

          <div className="space-y-1.5">
            <Label>退出歌词页按钮灵敏度</Label>
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {(
                [
                  { value: "low", label: "低" },
                  { value: "medium", label: "中" },
                  { value: "high", label: "高" },
                ] as { value: CloseButtonSensitivity; label: string }[]
              ).map((o) => (
                <button
                  key={o.value}
                  onClick={() => patch({ closeButtonSensitivity: o.value })}
                  className={cn(
                    "flex-1 rounded-md px-3 py-1.5 text-sm transition-colors",
                    s.closeButtonSensitivity === o.value
                      ? "bg-background text-foreground shadow"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {SENSITIVITY_HINT[s.closeButtonSensitivity]}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* AMLL 歌词 */}
      <Card>
        <CardHeader>
          <CardTitle>AMLL 歌词</CardTitle>
          <CardDescription>
            Apple Music 风格歌词的显示与动画参数 —— 按
            <span className="text-foreground">触屏/鼠标 × 横屏/竖屏</span> 共 4 档分别保存，
            当前编辑的是「
            <span className="text-foreground">{PROFILE_LABEL[s.profileKey]}</span>」这一档
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>对齐锚点</Label>
              <Select
                value={s.alignAnchor}
                onValueChange={(v) => patch({ alignAnchor: v as AlignAnchor })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="center">居中 (center)</SelectItem>
                  <SelectItem value="top">顶部 (top)</SelectItem>
                  <SelectItem value="bottom">底部 (bottom)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>歌词字体</Label>
              <FontPicker value={s.fontFamily} onChange={(v) => patch({ fontFamily: v })} />
            </div>
          </div>

          <SliderField
            label="高亮行位置"
            hint={`${Math.round(s.alignPosition * 100)}% 处（占屏幕高度比例）`}
            value={s.alignPosition}
            min={0.05}
            max={0.95}
            step={0.01}
            onChange={(v) => patch({ alignPosition: v })}
          />

          <SliderField
            label="歌词组件宽度"
            hint={`${s.lyricsWidth}px（全屏时，左右间距自动计算）`}
            value={s.lyricsWidth}
            min={320}
            max={1200}
            step={10}
            onChange={(v) => patch({ lyricsWidth: v })}
          />

          <SliderField
            label="横屏左侧元素比例"
            hint={`${Math.round(s.leftColumnScale * 100)}%（封面 / 歌曲信息 / 控制条整体缩放）`}
            value={s.leftColumnScale}
            min={0.6}
            max={1.5}
            step={0.05}
            onChange={(v) => patch({ leftColumnScale: v })}
          />

          <SliderField
            label="歌词字号"
            hint={`${s.fontSize}px`}
            value={s.fontSize}
            min={12}
            max={64}
            step={1}
            onChange={(v) => patch({ fontSize: v })}
          />

          <SliderField
            label="歌词字重"
            hint={String(s.fontWeight)}
            value={s.fontWeight}
            min={100}
            max={900}
            step={5}
            onChange={(v) => patch({ fontWeight: v })}
          />

          <SliderField
            label="渐变宽度 (wordFadeWidth)"
            hint={s.wordFadeWidth.toFixed(2)}
            value={s.wordFadeWidth}
            min={0.05}
            max={1.5}
            step={0.05}
            onChange={(v) => patch({ wordFadeWidth: v })}
          />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>歌词颜色</Label>
              <p className="text-xs text-muted-foreground">默认白色，发光混合效果最佳</p>
            </div>
            <input
              type="color"
              value={s.lyricColor}
              onChange={(e) => patch({ lyricColor: e.target.value })}
              className="h-9 w-14 cursor-pointer rounded border border-input bg-transparent p-1"
            />
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <ToggleField
              label="弹簧动画"
              hint="物理弹簧滚动（性能要求高）"
              checked={s.enableSpring}
              onChange={(v) => patch({ enableSpring: v })}
            />
            <ToggleField
              label="缩放动画"
              hint="歌词行缩放动效"
              checked={s.enableScale}
              onChange={(v) => patch({ enableScale: v })}
            />
            <ToggleField
              label="模糊效果"
              hint="非高亮行的模糊"
              checked={s.enableBlur}
              onChange={(v) => patch({ enableBlur: v })}
            />
            <ToggleField
              label="隐藏已播放行"
              hint="只显示当前及之后的行"
              checked={s.hidePassedLines}
              onChange={(v) => patch({ hidePassedLines: v })}
            />
          </div>
        </CardContent>
      </Card>

      {/* 弹簧参数 */}
      <Card>
        <CardHeader>
          <CardTitle>弹簧参数</CardTitle>
          <CardDescription>歌词行在 X / Y / 缩放方向上的物理弹簧（同样按 4 档分别保存）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <SpringEditor
            title="水平位置 (posX)"
            value={s.posXSpring}
            onChange={(v) => patch({ posXSpring: v })}
          />
          <SpringEditor
            title="垂直位置 (posY)"
            value={s.posYSpring}
            onChange={(v) => patch({ posYSpring: v })}
          />
          <SpringEditor
            title="缩放 (scale)"
            value={s.scaleSpring}
            onChange={(v) => patch({ scaleSpring: v })}
          />
        </CardContent>
      </Card>

      {/* 流动背景 */}
      <Card>
        <CardHeader>
          <CardTitle>流动背景</CardTitle>
          <CardDescription>全屏歌词页的动态背景参数（同样按 4 档分别保存）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleField
            label="开启流动背景"
            hint="关闭后沉浸歌词页使用静态底色（更省电），下方各项一并折叠"
            checked={s.bgEnabled}
            onChange={(v) => patch({ bgEnabled: v })}
          />
          {/* 手动关闭流动背景后，下面这些只对它生效的参数就没有意义了，折叠起来 */}
          {s.bgEnabled && (
            <>
              <SliderField
                label="帧率"
                hint={`${s.bgFps} FPS`}
                value={s.bgFps}
                min={24}
                max={120}
                step={1}
                onChange={(v) => patch({ bgFps: v })}
              />
              <SliderField
                label="流动速度"
                hint={s.bgFlowSpeed.toFixed(1)}
                value={s.bgFlowSpeed}
                min={0}
                max={5}
                step={0.1}
                onChange={(v) => patch({ bgFlowSpeed: v })}
              />
              <SliderField
                label="渲染缩放"
                hint={`${s.bgRenderScale.toFixed(2)}x`}
                value={s.bgRenderScale}
                min={0.25}
                max={1.5}
                step={0.05}
                onChange={(v) => patch({ bgRenderScale: v })}
              />
              <ToggleField
                label="静态模式"
                hint="背景静止以省电（低性能设备）"
                checked={s.bgStaticMode}
                onChange={(v) => patch({ bgStaticMode: v })}
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* 触屏底栏（液态玻璃）*/}
      <Card>
        <CardHeader>
          <CardTitle>触屏底栏（液态玻璃）</CardTitle>
          <CardDescription>
            仅触屏设备的底部药丸停靠栏；这里调整玻璃大胶囊的透明度、松手回位 / 回弹 / 按压缩放的手感、
            滑动阻尼、滚动收起的两栏切换距离与静置自动折叠的灵敏度
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SliderField
            label="玻璃透明度"
            hint={`${s.glassTransparency}%（越大越透明）`}
            value={s.glassTransparency}
            min={80}
            max={94}
            step={1}
            onChange={(v) => patch({ glassTransparency: v })}
          />
          <SliderField
            label="滑动阻力"
            hint={`${s.flingResistance}%（越小甩得越远）`}
            value={s.flingResistance}
            min={0}
            max={100}
            step={1}
            onChange={(v) => patch({ flingResistance: v })}
          />
          <SliderField
            label="回位速度"
            hint="松手后回到正确位置的快慢，越大越快"
            value={s.glassReturnSpeed}
            min={0}
            max={100}
            step={1}
            onChange={(v) => patch({ glassReturnSpeed: v })}
          />
          <SliderField
            label="回弹幅度"
            hint="越过目标位置多远，越大弹得越明显（始终只弹一次）"
            value={s.glassBounce}
            min={0}
            max={100}
            step={1}
            onChange={(v) => patch({ glassBounce: v })}
          />
          <SliderField
            label="按压形变"
            hint="按住时按钮与胶囊的形变幅度"
            value={s.glassPressDeform}
            min={0}
            max={100}
            step={1}
            onChange={(v) => patch({ glassPressDeform: v })}
          />

          {/*
            可拖动的预览条：与真实底栏同一套材质与手势，四项设置当场生效。
            放在四个滑块下方、静置自动折叠之前 —— 调完参数立刻能在它身上试。
          */}
          <GlassDockPreview />

          {/*
            收起触发距离：内容区滚动的**累计位移**（不分方向）达到它就收成合一态。
            默认 28 = 加这个设置项之前写死的 SCROLL_DEAD_ZONE，不动滑块 = 原来的手感。
            与同卡片里的玻璃 / 静置灵敏度一样按 4 档设备状态分别保存。
          */}
          <SliderField
            label="收起触发距离"
            hint={`${s.dockCollapseDistance}px（滚动累计多少像素后收起，不分方向）`}
            value={s.dockCollapseDistance}
            min={DOCK_COLLAPSE_DISTANCE_MIN}
            max={DOCK_COLLAPSE_DISTANCE_MAX}
            step={1}
            onChange={(v) => patch({ dockCollapseDistance: v })}
          />

          {/* 展开态静置过久 → 自动折成一行（三档灵敏度，样式与「退出歌词页按钮灵敏度」一致） */}
          <div className="space-y-1.5">
            <Label>静置自动折叠灵敏度</Label>
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {(
                [
                  { value: "high", label: "高" },
                  { value: "medium", label: "中" },
                  { value: "low", label: "低" },
                ] as { value: AutoCollapseSensitivity; label: string }[]
              ).map((o) => (
                <button
                  key={o.value}
                  onClick={() => patch({ autoCollapseSensitivity: o.value })}
                  className={cn(
                    "flex-1 rounded-md px-3 py-1.5 text-sm transition-colors",
                    s.autoCollapseSensitivity === o.value
                      ? "bg-background text-foreground shadow"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {autoCollapseHint(s.autoCollapseSensitivity)}；触摸 / 点击 / 滚动都会重新计时，
              已折叠时不计时
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            <b>收起触发距离</b>（{s.dockCollapseDistance}px）管的是<b>滚动切形态</b>：
            内容区滚动的<b>累计位移</b>（往上滑、往下滑<b>都算</b>，20px 最灵敏 / 400px 几乎等于半屏）
            达到这个距离，两栏就收成一行。累计是相对<b>上次切换时</b>的位置算的 ——
            没到阈值的滚动不清零，所以慢慢滑也会一路累加。
            <br />
            反过来，<b>滑到内容顶部或底部就展开回两栏</b>（在端点继续滑同样保持展开）；
            点击合一态的左圆 / 歌曲胶囊也仍然可以展开，静置过久则按上面的灵敏度自动收起。
            <br />
            <b>玻璃透明度</b>（{s.glassTransparency}%）就是<b>底栏那枚大胶囊的透明度数值</b>：
            a = 1 − 数字/100，80% → 0.20（半透明玻璃），94% → 0.06（几乎完全不可见）。
            这个系数作用在大胶囊的<b>全部涂装</b>上 —— 本体两层色标、描边、顶部高光、
            内阴影与表面光泽一起按同一比例淡出；背后的磨砂也跟着走：
            模糊 80% → 18px，94% → <b>0px</b>；饱和度 80% → 180%，94% → 100%。
            <b>文字与图标不跟着淡</b>，始终清晰可读（浅色背景下转深色由玻璃色调自适应负责）。
            <br />
            <b>回位速度</b>（{s.glassReturnSpeed}）只改松手后「回到正确位置」这段回弹动画的时长：
            当前 {glassSnapMs(s.glassReturnSpeed)}ms（0 → 720ms 最慢，100 → 200ms 最快）。
            <br />
            <b>回弹幅度</b>（{s.glassBounce}）只改吸附时<b>越过目标位置多远</b>（过冲量）：
            当前弹性曲线 y1 = {glassBounceY1(s.glassBounce)}（0 → 1.00 完全不越界，
            100 → 2.12 明显冲过头）。<b>始终只弹一次</b> —— 它调的是冲过头多少，不是弹几下。
            <br />
            <b>按压形变</b>（{s.glassPressDeform}）改按住时的放大与跟手拉伸：
            当前按住放大 sx {press.sx} / sy {press.sy}、拖动拉伸上限 {press.stretch}
            （0 → 完全无形变，100 → 1.03 / 1.006 / 0.07）。真实底栏与上面那条预览条
            都吃这个旋钮：本体按 sx / sy 放大，那枚高亮胶囊按同一比例放大
            （默认 50 时仍是原来的 1.05 倍）。
            <br />
            <b>滑动阻力</b>只影响快速甩动能滑多远：0 最滑，100 几乎甩不动 ——
            它管的是「甩出去多远」，与上面「回位速度」管的「多久回到位」是两件事，互不叠加。
            <br />
            歌曲栏与药丸之间、以及合一态三个元素（左圆 / 歌曲胶囊 / 右圆）之间的切换都是形变：
            目标元素从源元素的矩形（位置 + 尺寸）弹性地长到自己的位置；这段形变时长固定，
            不受上面几个滑块影响。
          </p>
        </CardContent>
      </Card>

      {/* 锁屏歌词（上行文字换句节奏）*/}
      <Card>
        <CardHeader>
          <CardTitle>锁屏歌词</CardTitle>
          <CardDescription>
            手机锁屏 / 媒体面板的上行显示当前歌词正文（不含翻译与音译），这里控制它换句的节奏
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SliderField
            label="歌词时间偏移"
            hint={`${(s.lockLyricOffsetMs / 1000).toFixed(1)}s（负数=提前，正数=延后）`}
            value={s.lockLyricOffsetMs}
            min={-1500}
            max={1500}
            step={100}
            onChange={(v) => patch({ lockLyricOffsetMs: v })}
          />
          <SliderField
            label="每句最短停留"
            hint={
              s.lockLyricMinDwellMs === 0
                ? "不限制（0）"
                : `${(s.lockLyricMinDwellMs / 1000).toFixed(1)}s（短句密集时不会立刻翻页）`
            }
            value={s.lockLyricMinDwellMs}
            min={0}
            max={4000}
            step={100}
            onChange={(v) => patch({ lockLyricMinDwellMs: v })}
          />
          <p className="text-xs text-muted-foreground">
            纯音乐（含「纯音乐，请欣赏」这类占位歌词）不显示歌词，仍按「歌名 / 歌手」两行显示。
          </p>
        </CardContent>
      </Card>

      {/* 歌曲设置共享（默认关闭）*/}
      <SongSettingsShare />

      {/*
        锁屏兼容（进阶）：控制「把 <audio> 挂进文档」与「每秒推 positionState」。
        默认「开 + 开」= 实机验证过可用的组合（进度条可拖、锁屏按钮/切歌回调可用），
        改动前请先读卡片里的取舍说明。
      */}
      <LockCompatExperiment />

      {/* 关于 / 免责声明：版本号 + 版权声明 + 源码仓库（AGPL-3.0 §13） */}
      <AboutCard />
    </div>
  );
}

function SliderField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {hint && <span className="text-xs tabular-nums text-muted-foreground">{hint}</span>}
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
    </div>
  );
}

function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div className="space-y-0.5">
        <Label>{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SpringEditor({
  title,
  value,
  onChange,
}: {
  title: string;
  value: SpringParams;
  onChange: (v: SpringParams) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{title}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">soft</span>
          <Switch
            checked={value.soft}
            onCheckedChange={(v) => onChange({ ...value, soft: v })}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <SliderField
          label="mass"
          hint={value.mass.toFixed(1)}
          value={value.mass}
          min={0.1}
          max={10}
          step={0.1}
          onChange={(v) => onChange({ ...value, mass: v })}
        />
        <SliderField
          label="damping"
          hint={String(Math.round(value.damping))}
          value={value.damping}
          min={1}
          max={100}
          step={1}
          onChange={(v) => onChange({ ...value, damping: v })}
        />
        <SliderField
          label="stiffness"
          hint={String(Math.round(value.stiffness))}
          value={value.stiffness}
          min={1}
          max={300}
          step={1}
          onChange={(v) => onChange({ ...value, stiffness: v })}
        />
      </div>
    </div>
  );
}
