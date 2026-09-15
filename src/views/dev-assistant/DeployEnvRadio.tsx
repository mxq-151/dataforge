import React, { useId } from 'react';
import {
  DEPLOY_ENV_OPTIONS, DEFAULT_DEPLOY_ENV, type DeployEnv,
} from '../../utils/deployEnv';
import './DeployEnvRadio.css';

export interface DeployEnvRadioProps {
  value: DeployEnv;
  onChange: (env: DeployEnv) => void;
  disabled?: boolean;
  /** 追加在选项后的说明文案（如「将作为工作流名称后缀」），不传则不渲染 */
  hint?: string;
}

/**
 * 提交调度的「环境」单选（生产 / 灰度 / 测试，默认测试）。
 *
 * 两个提交入口（单文件 / 文件夹）共用；选中的值影响两处：
 * ① **工作流名称的后缀**（见 `utils/deployEnv.ts::withDeployEnvSuffix`）；
 * ② **是否注入数据血缘参数**——只有生产环境注入（`shouldInjectLineage`）。
 * 不改变提交目标项目、worker 组等运行参数。
 */
const DeployEnvRadio: React.FC<DeployEnvRadioProps> = ({
  value = DEFAULT_DEPLOY_ENV,
  onChange,
  disabled = false,
  hint,
}) => {
  // 两个弹窗在同一会话里可能先后挂载，用 useId 保证 radio group 的 name 不冲突
  const groupName = useId();

  return (
    <div className="deploy-env-radio" role="radiogroup" aria-label="环境">
      {DEPLOY_ENV_OPTIONS.map(opt => {
        const active = opt.value === value;
        return (
          <label
            key={opt.value}
            className={`deploy-env-radio__item${active ? ' deploy-env-radio__item--active' : ''}`}
            data-testid={`deploy-env-${opt.value}`}
            data-active={String(active)}
          >
            <input
              type="radio"
              name={groupName}
              value={opt.value}
              checked={active}
              disabled={disabled}
              onChange={() => onChange(opt.value)}
            />
            <span>{opt.label}</span>
          </label>
        );
      })}
      {hint && <span className="deploy-env-radio__hint">{hint}</span>}
    </div>
  );
};

export default DeployEnvRadio;
