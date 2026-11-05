/**
 * 通用文本规范校验工具
 *
 * 供各表单统一使用，返回错误提示或 null（校验通过）。
 */

const MAX_NAME_LEN = 64;
const MAX_CODE_LEN = 64;

/** 名称字段规范：非空、首尾不留空格、长度 1~64、不含控制字符（允许中文等） */
export function validateName(value: string | undefined, label = '名称'): string | null {
  const raw = value ?? '';
  if (raw.trim() === '') return `请输入${label}`;
  if (raw !== raw.trim()) return `${label}不能以空格开头或结尾`;
  if (raw.length > MAX_NAME_LEN) return `${label}长度不能超过${MAX_NAME_LEN}个字符`;
  if (/[\u0000-\u001f]/.test(raw)) return `${label}不能包含控制字符`;
  return null;
}

/** 编码字段规范：非空、仅英文字母开头、允许字母/数字/下划线/中划线、长度 1~64 */
export function validateCode(value: string | undefined, label = '编码'): string | null {
  const raw = value ?? '';
  if (raw.trim() === '') return `请输入${label}`;
  if (raw.length > MAX_CODE_LEN) return `${label}长度不能超过${MAX_CODE_LEN}个字符`;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw)) {
    return `${label}仅支持英文字母、数字、下划线、中划线，且必须以英文字母开头`;
  }
  return null;
}