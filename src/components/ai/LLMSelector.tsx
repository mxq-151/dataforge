/**
 * LLMSelector — LLM 模型下拉选择器
 *
 * 使用原生 <select>，避免自定义下拉在底部布局被遮挡的问题。
 */

import React, { useCallback } from 'react';
import type { LLMModelConfig } from '../../types/opencode-backend';

interface LLMSelectorProps {
  /** 用户配置的 LLM 模型列表 */
  models: LLMModelConfig[];
  /** 当前选中的模型 ID */
  selectedId: string | null;
  /** 切换模型时触发 */
  onChange: (model: LLMModelConfig | null) => void;
  /** 是否禁用 */
  disabled?: boolean;
}

const LLMSelector: React.FC<LLMSelectorProps> = ({
  models,
  selectedId,
  onChange,
  disabled,
}) => {
  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (!id) {
      onChange(null);
      return;
    }
    const m = models.find(x => x.id === id) ?? null;
    onChange(m);
  }, [models, onChange]);

  const selectedModel = models.find(m => m.id === selectedId) ?? null;
  const displayText = selectedModel
    ? selectedModel.name
    : (models.length === 0 ? '默认模型' : '选择模型');

  return (
    <select
      className="ai-panel__llm-select"
      value={selectedId ?? ''}
      onChange={handleChange}
      disabled={disabled || models.length === 0}
      title={selectedModel
        ? `${selectedModel.name} (${selectedModel.providerID}/${selectedModel.modelID})`
        : '选择 LLM 模型'}
    >
      {models.length === 0 ? (
        <option value="">{displayText}</option>
      ) : (
        models.map(model => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))
      )}
    </select>
  );
};

export default React.memo(LLMSelector);
