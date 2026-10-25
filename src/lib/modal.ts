/**
 * 模态弹窗（提示框等）开关标记。
 *
 * 弹窗自身是一个 fixed 全屏遮罩，指针事件天然被它接住，下层元素的元素级
 * mouseenter/mousemove 不会触发。但有些行为挂在 window 上（例如关闭键 /
 * 控制栏的「自动隐藏 + 靠近唤回」监听 window mousemove），遮罩拦不住它们，
 * 于是弹窗打开时鼠标一动，下层元素还是会被唤出来。
 *
 * 这里用一个模块级计数给那些全局监听做闸门：弹窗打开期间直接停摆。
 */

let depth = 0;

export function pushModal(): void {
  depth += 1;
}

export function popModal(): void {
  depth = Math.max(0, depth - 1);
}

export function isModalOpen(): boolean {
  return depth > 0;
}
