/**
 * 一级菜单一致性守卫
 *
 * 背景：新增一个 activity bar 入口需要同时改动多处，而其中最危险的一处不会报错 ——
 * 菜单可见性是按 `MENU_CODE_MAP[tab.id]` 取权限码后再与用户 menuTags 比对，
 * 如果新增了 tab 但漏了映射，`MENU_CODE_MAP[tab.id]` 为 undefined，
 * 该 tab 会被静默过滤掉：代码看起来对、编译通过、界面就是不出现。
 *
 * 已知的改动连锁（2026-09 的两次菜单调整都是这个形态）：
 *   ① types/index.ts 的 MENU_CODE_MAP（权限码，唯一事实源）
 *   ② types/index.ts 的 FIRST_LEVEL_TAB_IDS（由 ① 派生，不再单独维护）
 *   ③ ActivityBar.tsx 的 allTabs（图标与顺序）
 *   ④ App.tsx 的视图容器与 workspaceClassMap（少了就白屏 / 没有布局类）
 *   ⑤ App.css 的 workspace 布局类
 *   ⑥ 服务端 sys_menu_permission 与角色授权种子（sql/testdata + 迁移脚本）
 *
 * 本测试覆盖 ①~⑤ 的静态一致性（⑥ 在服务端，由迁移脚本自带断言之外的评审保证）。
 * 读取源码做断言是有意为之：这些约束是「文件之间的约定」，不是运行时可观察行为，
 * 与此前 extractMetrics.test.ts 从提示词文本里抽表头做列数断言是同一手法。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MENU_CODE_MAP,
  FIRST_LEVEL_MENU_CODES,
  FIRST_LEVEL_TAB_IDS,
} from './index';

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

/** camelCase → kebab-case，用于推导 App.css 的 workspace 类名 */
function camelToKebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

const APP_SOURCE = readSource('../App.tsx');
const ACTIVITY_BAR_SOURCE = readSource('../components/layout/ActivityBar.tsx');
const APP_CSS = readSource('../App.css');

const TAB_IDS = Object.keys(MENU_CODE_MAP);
const MENU_CODES = Object.values(MENU_CODE_MAP);

describe('一级菜单 —— 映射表自身', () => {
  it('每个 tab 都有权限码，且码两两不同', () => {
    expect(TAB_IDS.length).toBeGreaterThan(0);
    for (const id of TAB_IDS) {
      expect(MENU_CODE_MAP[id], `${id} 缺少权限码`).toBeTruthy();
    }
    expect(new Set(MENU_CODES).size).toBe(MENU_CODES.length);
  });

  it('权限码为小写下划线形式（与 sys_menu_permission.menu_code 一致）', () => {
    for (const code of MENU_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('一级菜单 —— 派生量不漂移', () => {
  it('FIRST_LEVEL_MENU_CODES 等于权限码集合（超管默认可见全部一级菜单）', () => {
    expect([...FIRST_LEVEL_MENU_CODES].sort()).toEqual([...MENU_CODES].sort());
  });

  it('FIRST_LEVEL_TAB_IDS 与权限码集合一一对应（顺序由映射表键序决定）', () => {
    expect([...FIRST_LEVEL_TAB_IDS].sort()).toEqual([...TAB_IDS].sort());
    expect(FIRST_LEVEL_TAB_IDS).toEqual(TAB_IDS);
  });
});

describe('一级菜单 —— 活动栏图标项完整', () => {
  const barIds = [...ACTIVITY_BAR_SOURCE.matchAll(/id: '([a-zA-Z]+)'/g)].map(m => m[1]);

  it('活动栏里的每个 tab 都有权限码（否则入口静默消失）', () => {
    const orphan = barIds.filter(id => !(id in MENU_CODE_MAP));
    expect(orphan, `活动栏存在无权限码的 tab: ${orphan.join('、')}`).toEqual([]);
  });

  it('每个权限码在活动栏都有图标项（否则永远不会被渲染）', () => {
    const missing = TAB_IDS.filter(id => !barIds.includes(id));
    expect(missing, `活动栏缺少 tab: ${missing.join('、')}`).toEqual([]);
  });

  it('活动栏没有重复项', () => {
    expect(new Set(barIds).size).toBe(barIds.length);
  });
});

describe('一级菜单 —— 视图挂载与布局类完整', () => {
  it('每个 tab 在 App.tsx 都有视图容器判定', () => {
    const missing = TAB_IDS.filter(id => !APP_SOURCE.includes(`activeTab === '${id}'`));
    expect(missing, `App.tsx 缺少视图容器: ${missing.join('、')}`).toEqual([]);
  });

  it('每个 tab 在 workspaceClassMap 有条目', () => {
    const missing = TAB_IDS.filter(id => !APP_SOURCE.includes(`${id}: 'app__workspace--`));
    expect(missing, `workspaceClassMap 缺少: ${missing.join('、')}`).toEqual([]);
  });

  it('App.css 定义了每个 tab 的 workspace 布局类', () => {
    const missing = TAB_IDS.filter(id => !APP_CSS.includes(`.app__workspace--${camelToKebab(id)}`));
    expect(missing, `App.css 缺少布局类: ${missing.map(camelToKebab).join('、')}`).toEqual([]);
  });
});

describe('一级菜单 —— 本次新增的两个入口', () => {
  it('数据质量与资产目录的权限码固定为 data_quality / asset_catalog', () => {
    expect(MENU_CODE_MAP.dataQuality).toBe('data_quality');
    expect(MENU_CODE_MAP.assetCatalog).toBe('asset_catalog');
  });

  it('资产目录对业务需求方可见（找数认数是提需求的前提，不能只给治理角色）', () => {
    // 该约定在服务端授权种子里落地，这里只固化「码存在且未被改名」这一前提，
    // 避免后续有人改名后服务端种子与前端取码不一致。
    expect(FIRST_LEVEL_MENU_CODES).toContain('asset_catalog');
    expect(FIRST_LEVEL_MENU_CODES).toContain('data_quality');
  });
});
