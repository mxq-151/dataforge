// 单调自增序号，保证同一毫秒内多次调用 generateId 也能生成唯一 ID
let _idCounter = 0;

/**
 * 生成唯一 ID（数字）。
 * 采用「时间戳 + 单调自增小数位」组合：若仅用 Date.now() + Math.random()，
 * 在当前时间戳量级（≈1.7e12）下浮点精度 ULP 约 2^-12，同一毫秒内两次调用
 * 的随机小数可能舍入到同一个值，产生重复 ID 并导致 React 列表 key 重复告警。
 *
 * 代码头域（生成/解析/校验）见 ./fileHeader；参数域见 ./programArgs。
 */
export const generateId = (): number => {
  _idCounter = (_idCounter + 1) % 1000;
  return Date.now() + _idCounter / 1000;
};
