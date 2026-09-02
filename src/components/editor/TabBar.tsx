import React from 'react';
import { X, Circle } from 'lucide-react';
import { toRelativePath } from '../../utils/pathUtils';
import './TabBar.css';

interface Tab {
  id: string;
  name: string;
  path: string;
  isModified: boolean;
  isSaving?: boolean;
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string) => void;
  rootPath?: string;
}

// 复用统一实现：Tab 路径可能是 Windows 本地形式（跳转打开的），rootPath 由 joinPath 拼成
// （'/' 分隔），必须忽略分隔符差异才能正确显示相对路径。
const getRelativePath = (fullPath: string, rootPath?: string): string => {
  return toRelativePath(fullPath, rootPath);
};

const TabBar: React.FC<TabBarProps> = ({ tabs, activeTabId, onTabSelect, onTabClose, rootPath }) => {
  return (
    <div className="tab-bar">
      <div className="tab-bar__list">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`tab ${activeTabId === tab.id ? 'tab--active' : ''}`}
            onClick={() => onTabSelect(tab.id)}
            title={getRelativePath(tab.path, rootPath)}
          >
            {tab.isSaving
              ? <Circle size={8} className="tab__saving" />
              : tab.isModified
                ? <Circle size={8} className="tab__modified" />
                : null
            }
            <span className="tab__name">{tab.name}</span>
            <button
              className="tab__close"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
              title="关闭标签页"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TabBar;
