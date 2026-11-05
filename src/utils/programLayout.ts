/**
 * 程序目录布局约定（与 `hooks/opencode/opencodeInstructions.ts` 里的开发规范一致）
 *
 * 工作空间按「程序类型」分三类目录，再按数仓分层归类：
 *   {项目编码}/code/{分层}/...   java / scala 程序
 *   {项目编码}/sql/{分层}/...    sql 程序
 *   {项目编码}/algo/...          python 算法程序
 * 另有 java/scala 公共工具类放在 code/utils 下。
 *
 * 文件浏览器右键的「配置参数」「提交调度」只对 `code` 目录下的数仓分层目录
 * （及其更深子目录）开放，避免在无关目录上误触发。
 */

import { splitPath } from './pathUtils';

/** 数仓分层目录名 */
export const WAREHOUSE_LAYERS = ['ads', 'dws', 'dwd', 'ods', 'dqc', 'dim'] as const;

/** java / scala 程序的归类目录名 */
export const PROGRAM_CODE_DIR = 'code';

const WAREHOUSE_LAYER_SET = new Set<string>(WAREHOUSE_LAYERS);

/**
 * 路径是否位于「code 目录下的数仓分层目录」中。
 *
 * 命中条件：路径里存在相邻的两级 `code/{分层}`，且分层 ∈ {@link WAREHOUSE_LAYERS}；
 * 该分层目录自身与其更深的子目录都算命中。例如（项目编码 TEST）：
 *   `/ws/TEST/code/ods`          命中（code 的直接子目录）
 *   `/ws/TEST/code/ods/sub/job`  命中（更深子目录）
 *   `/ws/TEST/sql/ods`           不命中（父目录是 sql 而不是 code）
 *   `/ws/TEST/code/utils`        不命中（utils 不是数仓分层）
 *   `/ws/TEST/code`              不命中（code 自身不是分层目录）
 *
 * 目录名大小写不敏感（Windows 路径本身不区分大小写，且分层名可能被写成 ODS）。
 * 同时兼容 `\` 与 `/` 分隔符。
 */
export const isUnderCodeLayerPath = (path: string): boolean => {
  if (!path) return false;
  const segments = splitPath(path);
  for (let i = 0; i + 1 < segments.length; i++) {
    if (
      segments[i].toLowerCase() === PROGRAM_CODE_DIR &&
      WAREHOUSE_LAYER_SET.has(segments[i + 1].toLowerCase())
    ) {
      return true;
    }
  }
  return false;
};
