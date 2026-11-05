/**
 * 工作流画布侧栏（从 dolphinscheduler-ui 的 dag-sidebar.tsx 移植，改用 dataforge 的分类与 React）。
 * 左侧按分类展示可拖拽的任务类型，拖入画布即可创建节点。
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { TASK_CATEGORIES, TASK_TYPE_LABELS } from '../../../types/dolphinscheduler';
import type { DSTaskType } from '../../../types/dolphinscheduler';
import { getTaskTypeIconName } from './useCustomCellBuilder';

interface DagSidebarProps {
  readonly?: boolean;
  onAddTask?: (taskType: DSTaskType) => void;
}

const DagSidebar: React.FC<DagSidebarProps> = ({ readonly = false, onAddTask }) => {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    () => new Set(TASK_CATEGORIES.map((c) => c.id))
  );

  const toggleCategory = (catId: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  if (readonly) return null;

  return (
    <div className="dag-sidebar">
      <div className="dag-sidebar__header">任务节点</div>
      <div className="dag-sidebar__content">
        {TASK_CATEGORIES.map((cat) => (
          <div key={cat.id} className="dag-sidebar__category">
            <button
              className="dag-sidebar__category-header"
              onClick={() => toggleCategory(cat.id)}
            >
              {expandedCategories.has(cat.id) ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
              <span>{cat.label}</span>
              <span className="dag-sidebar__count">{cat.tasks.length}</span>
            </button>
            {expandedCategories.has(cat.id) && (
              <div className="dag-sidebar__category-tasks">
                {cat.tasks.map((taskType) => (
                  <div
                    key={taskType}
                    className="dag-sidebar__task-item"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('taskType', taskType);
                    }}
                    onDoubleClick={() => onAddTask?.(taskType)}
                    title={`双击添加 ${TASK_TYPE_LABELS[taskType]}`}
                  >
                    <span
                      className="dag-sidebar__task-icon"
                      style={{
                        backgroundImage: `url(${import.meta.env.BASE_URL}images/task-icons/${getTaskTypeIconName(taskType)}.png)`
                      }}
                    />
                    <span className="dag-sidebar__task-name">
                      {TASK_TYPE_LABELS[taskType]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default DagSidebar;
