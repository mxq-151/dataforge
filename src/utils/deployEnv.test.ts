import { describe, it, expect } from 'vitest';
import {
  DEPLOY_ENV_OPTIONS, DEFAULT_DEPLOY_ENV, deployEnvLabel, isDeployEnv, withDeployEnvSuffix,
} from './deployEnv';

/**
 * 提交调度「环境」的定义与命名口径（单文件 / 文件夹两个入口共用）。
 *
 * 需求：两个提交调度弹窗都提供「生产 / 灰度 / 测试」单选，默认测试；
 * 选中的环境拼在工作流名称**末尾**作为后缀（`olist_code_ods` → `olist_code_ods_test`），
 * 使不同环境各自拥有一份独立工作流，同一环境重复提交则原地更新。
 */
describe('deployEnv — 提交调度环境单选', () => {
  it('选项为 生产/灰度/测试，顺序即展示顺序，取值分别为 prod/gray/test', () => {
    expect(DEPLOY_ENV_OPTIONS.map(o => o.value)).toEqual(['prod', 'gray', 'test']);
    expect(DEPLOY_ENV_OPTIONS.map(o => o.label)).toEqual(['生产', '灰度', '测试']);
  });

  it('默认环境为测试', () => {
    expect(DEFAULT_DEPLOY_ENV).toBe('test');
    expect(isDeployEnv(DEFAULT_DEPLOY_ENV)).toBe(true);
  });

  it('isDeployEnv 只认三个合法取值', () => {
    expect(isDeployEnv('prod')).toBe(true);
    expect(isDeployEnv('gray')).toBe(true);
    expect(isDeployEnv('test')).toBe(true);
    expect(isDeployEnv('dev')).toBe(false);
    expect(isDeployEnv(undefined)).toBe(false);
    expect(isDeployEnv(1)).toBe(false);
  });

  it('deployEnvLabel 返回中文名（未知值原样返回）', () => {
    expect(deployEnvLabel('prod')).toBe('生产');
    expect(deployEnvLabel('gray')).toBe('灰度');
    expect(deployEnvLabel('test')).toBe('测试');
    expect(deployEnvLabel('other' as never)).toBe('other');
  });

  it('把环境后缀拼在名称末尾，三个环境各自独立', () => {
    expect(withDeployEnvSuffix('olist_code_ods', 'test')).toBe('olist_code_ods_test');
    expect(withDeployEnvSuffix('olist_code_ods', 'gray')).toBe('olist_code_ods_gray');
    expect(withDeployEnvSuffix('olist_code_ods', 'prod')).toBe('olist_code_ods_prod');
  });

  it('不做 sanitize：含特殊字符的名称保持原样（清洗留给真正提交时）', () => {
    // 与 deriveFolderWorkflowName 同口径，否则两处界面显示会不一致
    expect(withDeployEnvSuffix('demo_a-b (v2)', 'prod')).toBe('demo_a-b (v2)_prod');
  });

  it('基础名末尾的下划线/分隔符不会造成重复下划线', () => {
    expect(withDeployEnvSuffix('dw_orders_', 'test')).toBe('dw_orders_test');
    expect(withDeployEnvSuffix('dw_orders/', 'test')).toBe('dw_orders_test');
    expect(withDeployEnvSuffix('  dw_orders  ', 'test')).toBe('dw_orders_test');
  });

  it('基础名为空时退化为纯环境后缀（不产生前导下划线）', () => {
    expect(withDeployEnvSuffix('', 'test')).toBe('test');
    expect(withDeployEnvSuffix('   ', 'prod')).toBe('prod');
  });
});
