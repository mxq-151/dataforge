/**
 * 画布右键菜单（从 dolphinscheduler-ui 的 dag-context-menu.tsx 移植，通用化）。
 * 由调用方通过 items 传入菜单项，点击空白处 / Esc 关闭。
 */
import React, { useEffect, useRef } from 'react';

export interface DagMenuItem {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface DagContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  items: DagMenuItem[];
  onClose: () => void;
}

const DagContextMenu: React.FC<DagContextMenuProps> = ({
  visible,
  x,
  y,
  items,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [visible, onClose]);

  if (!visible) return null;

  // 防止菜单超出视口右/下边缘
  const style: React.CSSProperties = {
    left: x,
    top: y
  };

  return (
    <div ref={menuRef} className="dag-context-menu" style={style}>
      {items.map((item) => (
        <button
          key={item.key}
          className="dag-context-menu__item"
          disabled={item.disabled}
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
};

export default DagContextMenu;
