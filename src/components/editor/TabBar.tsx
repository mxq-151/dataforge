import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Circle, XCircle, Layers, XOctagon } from 'lucide-react';
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
  /** 关闭除指定标签外的所有标签 */
  onTabCloseOthers?: (id: string) => void;
  /** 关闭全部标签 */
  onTabCloseAll?: () => void;
  rootPath?: string;
}

/** 右键菜单状态 */
interface TabContextMenu {
  x: number;
  y: number;
  tabId: string;
}

// 复用统一实现：Tab 路径可能是 Windows 本地形式（跳转打开的），rootPath 由 joinPath 拼成
// （'/' 分隔），必须忽略分隔符差异才能正确显示相对路径。
const getRelativePath = (fullPath: string, rootPath?: string): string => {
  return toRelativePath(fullPath, rootPath);
};

const TabBar: React.FC<TabBarProps> = ({ tabs, activeTabId, onTabSelect, onTabClose, onTabCloseOthers, onTabCloseAll, rootPath }) => {
  const [menu, setMenu] = useState<TabContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 记录为规避视口溢出已校正过的位置，避免重复校正触发 setState 循环
  const menuAdjustedRef = useRef<{ x: number; y: number } | null>(null);

  // 关闭菜单（点击外部时）
  useEffect(() => {
    if (!menu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menu]);

  // 渲染后按视口边界校正菜单位置，避免溢出窗口
  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const last = menuAdjustedRef.current;
    if (last && last.x === menu.x && last.y === menu.y) return;

    const el = menuRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 4;

    let nx = menu.x;
    let ny = menu.y;
    if (nx + w > vw - margin) nx = Math.max(margin, vw - w - margin);
    if (ny + h > vh - margin) ny = Math.max(margin, vh - h - margin);
    if (nx < margin) nx = margin;
    if (ny < margin) ny = margin;

    if (nx !== menu.x || ny !== menu.y) {
      menuAdjustedRef.current = { x: nx, y: ny };
      setMenu(prev => prev ? { ...prev, x: nx, y: ny } : prev);
    } else {
      menuAdjustedRef.current = { x: nx, y: ny };
    }
  }, [menu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    menuAdjustedRef.current = null;
    setMenu({ x: e.clientX, y: e.clientY, tabId });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const handleCloseCurrent = useCallback(() => {
    if (!menu) return;
    const id = menu.tabId;
    closeMenu();
    onTabClose(id);
  }, [menu, closeMenu, onTabClose]);

  const handleCloseOthers = useCallback(() => {
    if (!menu) return;
    const id = menu.tabId;
    closeMenu();
    onTabCloseOthers?.(id);
  }, [menu, closeMenu, onTabCloseOthers]);

  const handleCloseAll = useCallback(() => {
    closeMenu();
    onTabCloseAll?.();
  }, [closeMenu, onTabCloseAll]);

  return (
    <div className="tab-bar">
      <div className="tab-bar__list">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`tab ${activeTabId === tab.id ? 'tab--active' : ''}`}
            onClick={() => onTabSelect(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
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

      {menu && (
        <div ref={menuRef} className="tab-bar__context-menu" style={{ left: menu.x, top: menu.y }}>
          <button className="tab-bar__context-menu-item" onClick={handleCloseCurrent} title="关闭当前页">
            <XCircle size={14} />
            <span>关闭当前页</span>
          </button>
          <button
            className="tab-bar__context-menu-item"
            onClick={handleCloseOthers}
            disabled={tabs.length <= 1}
            title="关闭其他页"
          >
            <Layers size={14} />
            <span>关闭其他页</span>
          </button>
          <button
            className="tab-bar__context-menu-item"
            onClick={handleCloseAll}
            disabled={tabs.length === 0}
            title="关闭全部页"
          >
            <XOctagon size={14} />
            <span>关闭全部页</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default TabBar;