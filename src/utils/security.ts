// L6/M5 修复：移除侵入式反调试（console.clear 循环、键盘拦截），
// 安全防护应依赖后端鉴权和输入校验，而非前端反调试。
// 仅保留 contextmenu 阻止（防止右键查看源码）。

function setupContextMenuGuard(): void {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

export function initSecurity(): void {
  if (import.meta.env.DEV) return;

  setupContextMenuGuard();
}
