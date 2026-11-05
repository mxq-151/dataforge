import React, { useMemo, useEffect, useState, useRef } from 'react';
import { MessageSquare, Settings, User, Database, BookOpen, FolderOpen, Calendar, Shield, Library, LogOut, X, GitBranch, Check, BarChart3 } from 'lucide-react';
import { ActiveTab, MENU_CODE_MAP, FIRST_LEVEL_MENU_CODES } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import './ActivityBar.css';

// 菜单权限常量已迁至 types/index（供 contexts 等下层模块引用，避免循环依赖），此处 re-export
export { MENU_CODE_MAP, FIRST_LEVEL_MENU_CODES };

interface ActivityBarProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
}

const ActivityBar: React.FC<ActivityBarProps> = ({ activeTab, onTabChange }) => {
  const { user, logout, switchRole } = useAuth();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!showUserMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showUserMenu]);

  const handleUserClick = () => {
    setShowUserMenu(prev => !prev);
  };

  const handleSwitchRole = async (roleId: number) => {
    await switchRole(roleId);
    setShowUserMenu(false);
  };

  const handleLogoutClick = () => {
    setShowUserMenu(false);
    setShowLogoutConfirm(true);
  };

  const handleLogoutConfirm = () => {
    setShowLogoutConfirm(false);
    logout();
  };

  const allTabs: { id: ActiveTab; icon: React.ReactNode; title: string }[] = [
    { id: 'devAssist', icon: <MessageSquare size={20} />, title: '开发助手' },
    { id: 'dataExplore', icon: <Database size={20} />, title: '数据探索' },
    { id: 'indicatorManagement', icon: <BarChart3 size={20} />, title: '指标管理' },
    { id: 'knowledgeBase', icon: <BookOpen size={20} />, title: '知识库' },
    { id: 'fileBrowser', icon: <FolderOpen size={20} />, title: '文件浏览器' },
    { id: 'scheduleManagement', icon: <Calendar size={20} />, title: '调度管理' },
    { id: 'dataLineage', icon: <GitBranch size={20} />, title: '数据血缘' },
    { id: 'assetCatalog', icon: <Library size={20} />, title: '资产管理' },
    { id: 'systemManagement', icon: <Shield size={20} />, title: '系统管理' },
    { id: 'settings', icon: <Settings size={20} />, title: '设置' },
  ];

  const visibleTabs = useMemo(() => {
    if (!user) {
      return allTabs;
    }
    if (user.isSuperAdmin) {
      return allTabs;
    }
    const menuTags = user.menuTags;
    if (!menuTags || menuTags.length === 0) {
      // 设置默认所有人可见
      return allTabs.filter(tab => tab.id === 'settings');
    }
    const hasAllMenus = FIRST_LEVEL_MENU_CODES.every(code => menuTags.includes(code));
    if (hasAllMenus) {
      return allTabs;
    }
    const filtered = allTabs.filter(tab => menuTags.includes(MENU_CODE_MAP[tab.id]));
    // 设置始终可见
    if (!filtered.some(t => t.id === 'settings')) {
      filtered.push(allTabs.find(t => t.id === 'settings')!);
    }
    return filtered;
  }, [user?.menuTags, user?.isSuperAdmin]);

  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.some(t => t.id === activeTab)) {
      onTabChange(visibleTabs[0].id);
    }
  }, [visibleTabs, activeTab, onTabChange]);

  return (
    <aside className="activity-bar">
      <div className="activity-bar__top">
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            className={`activity-bar__item ${activeTab === tab.id ? 'activity-bar__item--active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.icon}
            <span className="activity-bar__tooltip">{tab.title}</span>
          </button>
        ))}
      </div>
      <div className="activity-bar__bottom" ref={userMenuRef}>
        <button className="activity-bar__item" title={user ? (user.realName || user.username) : '用户'} onClick={user ? handleUserClick : undefined}>
          <User size={20} />
        </button>

        {showUserMenu && user && (
          <div className="activity-bar__user-menu">
            <div className="activity-bar__user-menu-section">
              {user.roles.map(role => (
                <button
                  key={role.id}
                  className={`activity-bar__user-menu-item ${user.currentRoleId === role.id ? 'activity-bar__user-menu-item--active' : ''}`}
                  onClick={() => handleSwitchRole(role.id)}
                >
                  <span>{role.roleName}</span>
                  {user.currentRoleId === role.id && <Check size={14} />}
                </button>
              ))}
            </div>
            <div className="activity-bar__user-menu-divider" />
            <button className="activity-bar__user-menu-item activity-bar__user-menu-item--danger" onClick={handleLogoutClick}>
              <LogOut size={14} />
              <span>退出登录</span>
            </button>
          </div>
        )}
      </div>

      {showLogoutConfirm && (
        <div className="activity-bar__modal-overlay" onClick={() => setShowLogoutConfirm(false)}>
          <div className="activity-bar__modal" onClick={e => e.stopPropagation()}>
            <div className="activity-bar__modal-header">
              <h3>确认退出</h3>
              <button className="activity-bar__modal-close" onClick={() => setShowLogoutConfirm(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="activity-bar__modal-body">
              <p>确定要退出登录吗？</p>
            </div>
            <div className="activity-bar__modal-footer">
              <button className="activity-bar__modal-btn activity-bar__modal-btn--cancel" onClick={() => setShowLogoutConfirm(false)}>
                取消
              </button>
              <button className="activity-bar__modal-btn activity-bar__modal-btn--confirm" onClick={handleLogoutConfirm}>
                退出登录
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

export default ActivityBar;
