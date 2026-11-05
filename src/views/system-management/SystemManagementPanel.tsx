import { useState } from 'react';
import { Settings, Users, Shield, ScrollText } from 'lucide-react';
import SystemConfigTab from './components/SystemConfigTab';
import UserRoleManageTab from './components/UserRoleManageTab';
import PermissionManageTab from './components/PermissionManageTab';
import OperationLogTab from './components/OperationLogTab';
import './SystemManagementPanel.css';

type SystemTab = 'config' | 'userRole' | 'permission' | 'audit';

const SystemManagementPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SystemTab>('config');

  const tabs: { id: SystemTab; label: string; icon: React.ReactNode }[] = [
    { id: 'config', label: '系统配置', icon: <Settings size={16} /> },
    { id: 'userRole', label: '用户管理', icon: <Users size={16} /> },
    { id: 'permission', label: '权限管理', icon: <Shield size={16} /> },
    { id: 'audit', label: '操作审计', icon: <ScrollText size={16} /> },
  ];

  return (
    <div className="system-management">
      <div className="sys-mgmt__sidebar">
        <div className="sys-mgmt__sidebar-title">系统管理</div>
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`sys-mgmt__sidebar-item ${activeTab === tab.id ? 'sys-mgmt__sidebar-item--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="sys-mgmt__main">
        {activeTab === 'config' && <SystemConfigTab />}
        {activeTab === 'userRole' && <UserRoleManageTab />}
        {activeTab === 'permission' && <PermissionManageTab />}
        {activeTab === 'audit' && <OperationLogTab />}
      </div>
    </div>
  );
};

export default SystemManagementPanel;
