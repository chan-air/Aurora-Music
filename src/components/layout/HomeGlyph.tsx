/**
 * 「首页」图标：圆角小房子（自绘内联 SVG）。
 *
 * 为什么不用 lucide 的 `Home`：它是线稿风格（细描边 + 不填充），
 * 与底栏其它实心图标放在一起会显得单薄；这里要的是 Apple Music 那种
 * **粗壮、圆角、实心**的小房子。
 *
 * 画法：先写一个内缩过的五边形（房顶 + 房身），再用**同色描边把轮廓加粗**，
 * 靠 `stroke-linejoin: round` 把每个角都磨圆 —— 描边向外扩张的那一圈正好
 * 变成圆角与厚度，比手写一串圆弧路径更好调、也不会在缩放时失真。
 */
export default function HomeGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {/* 顶点 (12,5.6) → 右肩 (18.5,10.5) → 右下角 (18.5,17) → 左下角 (5.5,17) → 闭合 */}
      <path d="M12 5.6 18.5 10.5 V17 H5.5 V10.5 Z" />
    </svg>
  );
}
