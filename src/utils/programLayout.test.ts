import { describe, it, expect } from 'vitest';
import { isUnderCodeLayerPath, WAREHOUSE_LAYERS, PROGRAM_CODE_DIR } from './programLayout';

/**
 * 程序目录布局判定的纯函数测试。
 *
 * 需求：文件浏览器右键的「配置参数」「提交调度」只在**父目录是 code、
 * 子目录是 ads/dws/dwd/ods/dqc/dim** 时显示（含这些分层目录更深的子目录）。
 */

const WS = '/ws/TEST';

describe('isUnderCodeLayerPath', () => {
  it('六个数仓分层目录都被识别', () => {
    expect(WAREHOUSE_LAYERS).toEqual(['ads', 'dws', 'dwd', 'ods', 'dqc', 'dim']);
    WAREHOUSE_LAYERS.forEach(layer => {
      expect(isUnderCodeLayerPath(`${WS}/${PROGRAM_CODE_DIR}/${layer}`)).toBe(true);
    });
  });

  it('命中 code 的直接子目录（分层目录自身）', () => {
    expect(isUnderCodeLayerPath(`${WS}/code/ods`)).toBe(true);
  });

  it('命中分层目录更深的子目录', () => {
    expect(isUnderCodeLayerPath(`${WS}/code/ods/sub`)).toBe(true);
    expect(isUnderCodeLayerPath(`${WS}/code/dwd/trade/order/etl`)).toBe(true);
  });

  it('父目录不是 code 时不命中（如 sql/ods、algo/ods）', () => {
    expect(isUnderCodeLayerPath(`${WS}/sql/ods`)).toBe(false);
    expect(isUnderCodeLayerPath(`${WS}/sql/dwd/trade`)).toBe(false);
    expect(isUnderCodeLayerPath(`${WS}/algo/ods`)).toBe(false);
    expect(isUnderCodeLayerPath(`${WS}/javacode/ods`)).toBe(false);
  });

  it('code 下但不是数仓分层目录时不命中（如 code/utils、code）', () => {
    expect(isUnderCodeLayerPath(`${WS}/code/utils`)).toBe(false);
    expect(isUnderCodeLayerPath(`${WS}/code`)).toBe(false);
    expect(isUnderCodeLayerPath(`${WS}/code/odsx`)).toBe(false);
    expect(isUnderCodeLayerPath(`${WS}/code/ood`)).toBe(false);
  });

  it('目录名大小写不敏感', () => {
    expect(isUnderCodeLayerPath(`${WS}/CODE/ODS`)).toBe(true);
    expect(isUnderCodeLayerPath(`${WS}/Code/Ods/sub`)).toBe(true);
  });

  it('兼容 Windows 反斜杠分隔符与尾部斜杠', () => {
    expect(isUnderCodeLayerPath('C:\\ws\\TEST\\code\\dws')).toBe(true);
    expect(isUnderCodeLayerPath(`${WS}/code/ods/`)).toBe(true);
    expect(isUnderCodeLayerPath(`${WS}/code/ods/sub/`)).toBe(true);
  });

  it('code/分层 出现在中间层级也命中（判定与当前所处深度无关）', () => {
    expect(isUnderCodeLayerPath(`${WS}/code/ods/foo/code/bar`)).toBe(true);
  });

  it('空值与非目录路径不命中', () => {
    expect(isUnderCodeLayerPath('')).toBe(false);
    expect(isUnderCodeLayerPath('ods')).toBe(false);
    expect(isUnderCodeLayerPath('/code')).toBe(false);
  });
});
