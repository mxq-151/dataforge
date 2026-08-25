/**
 * QuestionTool — question 工具卡片
 *
 * 对齐桌面版 question 渲染器（message-part.tsx 2370-2413 行）。
 * pending/running 状态由 ToolPartDisplay 隐藏（不渲染）。
 * completed 时显示问答对，默认展开。
 */

import React, { useMemo } from 'react';
import BasicTool, { type TriggerTitle } from '../BasicTool';
import type { ToolProps } from '../ToolRegistry';

interface QuestionInfo {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }> | null;
}

const QuestionTool: React.FC<ToolProps> = ({ input, metadata, status }) => {
  const questions = (input.questions as QuestionInfo[] | undefined) ?? [];
  const answers = (metadata.answers as string[][] | undefined) ?? [];
  const completed = answers.length > 0;

  const trigger: TriggerTitle = useMemo(
    () => ({
      title: 'Questions',
      subtitle: completed
        ? `${questions.length} answered`
        : `${questions.length} question${questions.length > 1 ? 's' : ''}`,
    }),
    [completed, questions.length],
  );

  return (
    <BasicTool status={status} trigger={trigger} defaultOpen={completed}>
      <div className="ai-panel__question-answers">
        {questions.map((q, idx) => {
          const answer = answers[idx]?.join(', ');
          return (
            <div key={q.id || idx} className="ai-panel__question-item">
              <div className="ai-panel__question-header">{q.header}</div>
              <div className="ai-panel__question-text">{q.question}</div>
              {q.options && q.options.length > 0 && (
                <div className="ai-panel__question-options">
                  {q.options.map((opt, optIdx) => (
                    <div key={optIdx} className="ai-panel__question-option">
                      <span className="ai-panel__question-option-label">{opt.label}</span>
                      {opt.description && (
                        <span className="ai-panel__question-option-desc">{opt.description}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="ai-panel__question-answer">
                {answer || '(no answer)'}
              </div>
            </div>
          );
        })}
      </div>
    </BasicTool>
  );
};

export default React.memo(QuestionTool);
