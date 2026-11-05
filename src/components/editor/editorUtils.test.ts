import { describe, it, expect } from 'vitest';
import { supportsRename, resolveRenameKeyAction } from './editorUtils';

// 验证「重命名符号」右键菜单的可见性判定，与 VS Code 的 editor.action.rename
// 前置条件（writable && hasRenameProvider）对齐：
// - 仅 Java / Scala（JDT.LS / Metals 提供 renameProvider）
// - 只读依赖源码 Tab 不可重命名（writable=false）
describe('supportsRename（重命名符号菜单可见性判定）', () => {
  it('Java 可写文件 → 支持重命名', () => {
    expect(supportsRename('java', false)).toBe(true);
  });

  it('Scala 可写文件 → 支持重命名', () => {
    expect(supportsRename('scala', false)).toBe(true);
  });

  it('SQL / Python / markdown 等无 LSP renameProvider 的语言 → 不支持', () => {
    expect(supportsRename('sql', false)).toBe(false);
    expect(supportsRename('python', false)).toBe(false);
    expect(supportsRename('markdown', false)).toBe(false);
    expect(supportsRename('plaintext', false)).toBe(false);
  });

  it('只读虚拟源码 Tab（metals:/jdt:/.metals/readonly）→ 即使 Java/Scala 也不支持', () => {
    expect(supportsRename('java', true)).toBe(false);
    expect(supportsRename('scala', true)).toBe(false);
  });
});

describe('resolveRenameKeyAction（重命名输入框键盘兜底映射）', () => {
  it('Enter（非 Shift）→ accept（确认重命名）', () => {
    expect(resolveRenameKeyAction('Enter', false)).toBe('accept');
  });

  it('Shift+Enter → 不处理（避免拦截 Shift+Enter 的特殊行为）', () => {
    expect(resolveRenameKeyAction('Enter', true)).toBeNull();
  });

  it('Escape → cancel（取消重命名）', () => {
    expect(resolveRenameKeyAction('Escape', false)).toBe('cancel');
    expect(resolveRenameKeyAction('Escape', true)).toBe('cancel');
  });

  it('其他按键（字母/方向键/制表符等）→ 不处理，交给默认行为', () => {
    expect(resolveRenameKeyAction('a', false)).toBeNull();
    expect(resolveRenameKeyAction('ArrowUp', false)).toBeNull();
    expect(resolveRenameKeyAction('ArrowDown', false)).toBeNull();
    expect(resolveRenameKeyAction('Tab', false)).toBeNull();
    expect(resolveRenameKeyAction('Backspace', false)).toBeNull();
  });
});
