/**
 * 环境切换器（生产 / 灰度 / 测试）
 *
 * ── 为什么抽成组件 ────────────────────────────────────────
 * 环境是资产管理模块的**模块级**维度：切换器挂在模块页签条右侧，「资产概况」与「资产目录」
 * 两个页签共用同一个选中环境，切换一次即让两处的全部内容（含资产概况的五块图表看板）一起重取。
 * 状态由 AssetCatalogPanel 持有，本组件是纯受控的展示 + 回调，不保存任何状态。
 *
 * ── 环境从哪来 ──────────────────────────────────────────────
 * 环境不是前端猜的：服务端按库名规范 {分层}_{业务域}_{环境} 解析（后缀仅 _prod/_gray/_test），
 * 这里只负责把选中的环境码随请求下发。取值与中文名直接复用提交调度的环境定义
 * （见 `api/assetCatalog.ts` 的 ASSET_ENV_OPTIONS），保证「库里叫什么」与「界面上叫什么」同源。
 *
 * ── 配色 ────────────────────────────────────────────────────
 * 生产蓝 / 灰度橙 / 测试绿，与 AssetOverviewTab 的图表配色共用同一份常量
 * （ASSET_ENV_COLOR），避免切换器与图表对同一个环境给出两种颜色。
 */

import type { ReactNode } from 'react';
import { ASSET_ENV_OPTIONS } from '../../api/assetCatalog';
import type { AssetEnvCode } from '../../api/assetCatalog';

/** 环境语义配色：跨切换器、图表、图例统一 */
export const ASSET_ENV_COLOR: Record<AssetEnvCode, string> = {
  prod: '#4FC3F7',
  gray: '#FFB74D',
  test: '#81C784',
};

/** 环境码 → 中文名（与 ASSET_ENV_OPTIONS 同源） */
export function assetEnvLabel(env: AssetEnvCode): string {
  return ASSET_ENV_OPTIONS.find(o => o.value === env)?.label ?? env;
}

export interface AssetEnvSwitchProps {
  value: AssetEnvCode;
  onChange: (next: AssetEnvCode) => void;
  /** 左侧前缀文案，默认「环境」 */
  label?: string;
  /** 右侧说明文案 */
  hint?: ReactNode;
}

const AssetEnvSwitch: React.FC<AssetEnvSwitchProps> = ({ value, onChange, label = '环境', hint }) => (
  <div className="ac-envbar">
    <span className="ac-envbar__label">{label}</span>
    <div className="ac-envswitch" role="tablist" aria-label="部署环境">
      {ASSET_ENV_OPTIONS.map(opt => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={`ac-envswitch__btn ${active ? 'ac-envswitch__btn--active' : ''}`}
            style={active ? { borderColor: ASSET_ENV_COLOR[opt.value] } : undefined}
            onClick={() => onChange(opt.value)}
          >
            <span className="ac-envswitch__dot" style={{ background: ASSET_ENV_COLOR[opt.value] }} />
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
    {hint ? <span className="ac-envbar__hint">{hint}</span> : null}
  </div>
);

export default AssetEnvSwitch;
