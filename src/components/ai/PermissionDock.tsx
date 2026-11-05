/**
 * PermissionDock — 权限审批 inline dock
 *
 * 对齐 opencode 桌面版 SessionPermissionDock（session-permission-dock.tsx）。
 * 从 PermissionModal 改造为 inline dock（无 position:fixed overlay），
 * 渲染在 composer 栈内 ChatInput 上方。
 *
 * 三选项：拒绝 / 始终允许 / 仅本次允许 + 文件路径模式显示。
 */

import React from 'react';
import { AlertTriangle, Wrench, X } from 'lucide-react';
import type { ModalRequest } from '../../types/opencode-backend';

interface PermissionDockProps {
  modal: ModalRequest;
  onRespond: (requestId: string, response: 'once' | 'always' | 'reject') => void;
}

const PermissionDock: React.FC<PermissionDockProps> = ({ modal, onRespond }) => {
  const toolName = modal.tool_name || modal.permission || '未知工具';
  const patterns = modal.patterns || [];

  // 工具描述映射
  const toolDescriptions: Record<string, string> = {
    edit: '请求编辑文件',
    write: '请求写入文件',
    bash: '请求执行 Shell 命令',
    apply_patch: '请求应用补丁',
    webfetch: '请求访问网页',
    websearch: '请求搜索网页',
  };
  const description = toolDescriptions[modal.permission || ''] || modal.reason || '';

  return (
    <div className="ai-panel__dock ai-panel__permission-dock">
      <div className="ai-panel__dock-header">
        <AlertTriangle size={16} className="ai-panel__dock-warning-icon" />
        <span className="ai-panel__dock-title">权限请求</span>
        <button className="ai-panel__dock-close" onClick={() => onRespond(modal.request_id, 'reject')}>
          <X size={14} />
        </button>
      </div>
      <div className="ai-panel__dock-body">
        <div className="ai-panel__dock-tool-name">
          <Wrench size={14} />
          <span>{toolName}</span>
        </div>
        {description && (
          <div className="ai-panel__dock-description">
            {description}
          </div>
        )}
        {patterns.length > 0 && (
          <div className="ai-panel__dock-patterns">
            <div className="ai-panel__dock-patterns-label">涉及文件：</div>
            <div className="ai-panel__dock-patterns-list">
              {patterns.map((pattern, idx) => (
                <code key={idx} className="ai-panel__dock-pattern">{pattern}</code>
              ))}
            </div>
          </div>
        )}
        {modal.reason && !description && (
          <div className="ai-panel__dock-reason">
            <pre>{modal.reason}</pre>
          </div>
        )}
      </div>
      <div className="ai-panel__dock-footer ai-panel__dock-footer--permission">
        <button
          className="ai-panel__dock-btn ai-panel__dock-btn--deny"
          onClick={() => onRespond(modal.request_id, 'reject')}
        >
          拒绝
        </button>
        <button
          className="ai-panel__dock-btn ai-panel__dock-btn--always"
          onClick={() => onRespond(modal.request_id, 'always')}
        >
          始终允许
        </button>
        <button
          className="ai-panel__dock-btn ai-panel__dock-btn--allow"
          onClick={() => onRespond(modal.request_id, 'once')}
        >
          仅本次允许
        </button>
      </div>
    </div>
  );
};

export default React.memo(PermissionDock);
