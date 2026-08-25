import React from 'react';
import { X, Circle } from 'lucide-react';
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

const getRelativePath = (fullPath: string, rootPath?: string): string => {
  if (!rootPath) return fullPath;
  const normalizedRoot = rootPath.replace(/\/$/, '');
  const normalizedPath = fullPath.replace(/\\/g, '/');
  if (normalizedPath.startsWith(normalizedRoot + '/')) {
    return normalizedPath.substring(normalizedRoot.length + 1);
  }
  return normalizedPath;
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
