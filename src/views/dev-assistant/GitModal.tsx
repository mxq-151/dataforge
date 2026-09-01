import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  Sparkles,
  Loader2,
  GitCommit,
  GitPullRequest,
  Upload,
  History,
  RotateCcw,
  CheckSquare,
  Square,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import {
  gitStatus,
  gitAdd,
  gitCommit,
  gitDiff,
  gitPush,
  gitPull,
  gitLog,
  gitReset,
  type GitFileStatus,
  type GitLogEntry,
} from '../../api/git';
import './GitModal.css';

type TabKey = 'changes' | 'history' | 'remote';

interface GitModalProps {
  visible: boolean;
  rootPath: string | null;
  onClose: () => void;
  onAISummarize?: (files: string[], diffs: string) => Promise<string>;
  onBeforeCommit?: () => { valid: boolean; message: string | null };
  onCommitted?: () => void;
}

const GitModal: React.FC<GitModalProps> = ({
  visible,
  rootPath,
  onClose,
  onAISummarize,
  onBeforeCommit,
  onCommitted,
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>('changes');

  // 变更页状态
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState('');
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);

  // 历史页状态
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([]);
  const [isLoadingLog, setIsLoadingLog] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);

  // 远程页状态
  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [branch, setBranch] = useState('');
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);

  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const clearTransient = useCallback(() => {
    setError(null);
    setSuccessMsg(null);
  }, []);

  const loadStatus = useCallback(async () => {
    if (!rootPath) return;
    setIsLoadingStatus(true);
    clearTransient();
    try {
      const status = await gitStatus(rootPath);
      const changed = status.files.filter(
        f => f.status === 'modified' || f.status === 'added' || f.status === 'deleted' || f.status === 'untracked'
      );
      setGitFiles(changed);
      setSelectedFiles(new Set(changed.map(f => f.path)));
      setBranch(status.branch);
      setAhead(status.ahead);
      setBehind(status.behind);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取 Git 状态失败');
    } finally {
      setIsLoadingStatus(false);
    }
  }, [rootPath, clearTransient]);

  const loadLog = useCallback(async () => {
    if (!rootPath) return;
    setIsLoadingLog(true);
    clearTransient();
    try {
      const result = await gitLog(rootPath);
      setLogEntries(result.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取提交历史失败');
    } finally {
      setIsLoadingLog(false);
    }
  }, [rootPath, clearTransient]);

  // 打开时加载数据
  useEffect(() => {
    if (visible && rootPath) {
      loadStatus();
    }
  }, [visible, rootPath, loadStatus]);

  // 切换标签页时加载对应数据
  useEffect(() => {
    if (!visible || !rootPath) return;
    if (activeTab === 'history') {
      // 每次进入历史页都重新拉取，避免提交后仍然停留在旧的历史记录
      loadLog();
    }
    if (activeTab === 'changes') {
      loadStatus();
    }
  }, [activeTab, visible, rootPath]);

  const handleToggleFile = useCallback((filePath: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selectedFiles.size === gitFiles.length && gitFiles.length > 0) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(gitFiles.map(f => f.path)));
    }
  }, [gitFiles, selectedFiles]);

  const handleAISummarize = useCallback(async () => {
    if (!rootPath || !onAISummarize || selectedFiles.size === 0) return;
    setIsSummarizing(true);
    clearTransient();
    try {
      const files = Array.from(selectedFiles);
      const diffs: string[] = [];
      for (const file of files) {
        const diff = await gitDiff(rootPath, file);
        if (diff) diffs.push(diff);
      }
      const summary = await onAISummarize(files, diffs.join('\n'));
      setCommitMessage(summary);
    } catch {
      setError('AI 总结失败，请手动输入提交信息');
    } finally {
      setIsSummarizing(false);
    }
  }, [rootPath, onAISummarize, selectedFiles, clearTransient]);

  const handleCommit = useCallback(async () => {
    if (!rootPath || selectedFiles.size === 0) return;
    if (!commitMessage.trim()) {
      setError('请输入提交信息');
      return;
    }
    if (onBeforeCommit) {
      const result = onBeforeCommit();
      if (!result.valid) {
        setError(result.message || '数据源校验失败，请检查代码头中的数据源配置');
        return;
      }
    }
    setIsCommitting(true);
    clearTransient();
    try {
      const filesToAdd = Array.from(selectedFiles);
      await gitAdd(rootPath, filesToAdd);
      await gitCommit(rootPath, commitMessage.trim());
      setSuccessMsg(`已提交 ${filesToAdd.length} 个文件`);
      setCommitMessage('');
      await loadStatus();
      // 提交后立即刷新历史，保证历史页能看到最新提交
      await loadLog();
      onCommitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败');
    } finally {
      setIsCommitting(false);
    }
  }, [rootPath, selectedFiles, commitMessage, onBeforeCommit, clearTransient, loadStatus, loadLog, onCommitted]);

  const handlePush = useCallback(async () => {
    if (!rootPath) return;
    setIsPushing(true);
    clearTransient();
    try {
      const result = await gitPush(rootPath);
      if (result.success) {
        setSuccessMsg('推送成功');
        await loadStatus();
      } else {
        setError(result.message || '推送失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '推送失败');
    } finally {
      setIsPushing(false);
    }
  }, [rootPath, clearTransient, loadStatus]);

  const handlePull = useCallback(async () => {
    if (!rootPath) return;
    setIsPulling(true);
    clearTransient();
    try {
      const result = await gitPull(rootPath);
      if (result.success) {
        setSuccessMsg('拉取成功');
        await loadStatus();
        onCommitted?.();
      } else {
        setError(result.message || '拉取失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '拉取失败');
    } finally {
      setIsPulling(false);
    }
  }, [rootPath, clearTransient, loadStatus, onCommitted]);

  const handleRollback = useCallback(async () => {
    if (!rootPath || !rollbackTarget) return;
    setIsCommitting(true);
    clearTransient();
    try {
      await gitReset(rootPath, rollbackTarget, 'hard');
      setSuccessMsg(`已回滚到 ${rollbackTarget.slice(0, 7)}`);
      setRollbackTarget(null);
      await loadStatus();
      await loadLog();
      onCommitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '回滚失败');
    } finally {
      setIsCommitting(false);
    }
  }, [rootPath, rollbackTarget, clearTransient, loadStatus, loadLog, onCommitted]);

  const handleRefresh = useCallback(() => {
    if (activeTab === 'changes') loadStatus();
    else if (activeTab === 'history') loadLog();
    else loadStatus();
  }, [activeTab, loadStatus, loadLog]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && activeTab === 'changes') {
      e.preventDefault();
      handleCommit();
    }
  }, [onClose, activeTab, handleCommit]);

  if (!visible) return null;

  const getStatusLabel = (status: GitFileStatus['status']): string => {
    switch (status) {
      case 'modified': return 'M';
      case 'added': return 'A';
      case 'deleted': return 'D';
      case 'untracked': return 'U';
      case 'renamed': return 'R';
      default: return '?';
    }
  };

  const getStatusColor = (status: GitFileStatus['status']): string => {
    switch (status) {
      case 'modified': return '#e2c08d';
      case 'added': return '#4EC9B0';
      case 'deleted': return '#f44747';
      case 'untracked': return '#858585';
      case 'renamed': return '#569cd6';
      default: return '#858585';
    }
  };

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'changes', label: '变更', icon: <GitCommit size={14} /> },
    { key: 'history', label: '历史', icon: <History size={14} /> },
    { key: 'remote', label: '远程', icon: <GitPullRequest size={14} /> },
  ];

  return (
    <div className="git-modal__overlay" onClick={onClose}>
      <div className="git-modal" onClick={e => e.stopPropagation()}>
        <div className="git-modal__header">
          <div className="git-modal__title">
            <GitCommit size={16} />
            <span>Git 管理</span>
            {branch && (
              <span className="git-modal__branch">
                <span className="git-modal__branch-dot" />
                {branch}
                {(ahead > 0 || behind > 0) && (
                  <span className="git-modal__branch-status">
                    {ahead > 0 && <span className="git-modal__ahead">↑{ahead}</span>}
                    {behind > 0 && <span className="git-modal__behind">↓{behind}</span>}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="git-modal__header-actions">
            <button
              className="git-modal__icon-btn"
              title="刷新"
              onClick={handleRefresh}
              disabled={isLoadingStatus || isLoadingLog}
            >
              {isLoadingStatus || isLoadingLog ? (
                <Loader2 size={14} className="git-modal__spin" />
              ) : (
                <RefreshCw size={14} />
              )}
            </button>
            <button className="git-modal__icon-btn" title="关闭" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="git-modal__tabs">
          {tabs.map(tab => (
            <button
              key={tab.key}
              className={`git-modal__tab ${activeTab === tab.key ? 'git-modal__tab--active' : ''}`}
              onClick={() => { setActiveTab(tab.key); clearTransient(); }}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="git-modal__body">
          {error && (
            <div className="git-modal__error">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )}
          {successMsg && (
            <div className="git-modal__success">
              <CheckSquare size={14} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* 变更标签页 */}
          {activeTab === 'changes' && (
            <div className="git-modal__changes">
              <div className="git-modal__files-section">
                <div className="git-modal__files-header" onClick={handleSelectAll}>
                  {selectedFiles.size === gitFiles.length && gitFiles.length > 0 ? (
                    <CheckSquare size={14} />
                  ) : (
                    <Square size={14} />
                  )}
                  <span>更改的文件</span>
                  <span className="git-modal__count">{gitFiles.length}</span>
                </div>
                <div className="git-modal__files-list">
                  {isLoadingStatus ? (
                    <div className="git-modal__loading">
                      <Loader2 size={16} className="git-modal__spin" />
                      <span>加载中...</span>
                    </div>
                  ) : gitFiles.length === 0 ? (
                    <div className="git-modal__empty">
                      <span>没有检测到文件更改</span>
                    </div>
                  ) : (
                    gitFiles.map(file => {
                      const trimmedPath = file.path.replace(/\/+$/, '');
                      const fileName = trimmedPath.split(/[/\\]/).pop() || file.path;
                      return (
                      <div
                        key={file.path}
                        className={`git-modal__file ${selectedFiles.has(file.path) ? 'git-modal__file--selected' : ''}`}
                        onClick={() => handleToggleFile(file.path)}
                      >
                        {selectedFiles.has(file.path) ? (
                          <CheckSquare size={13} />
                        ) : (
                          <Square size={13} />
                        )}
                        <span className="git-modal__filename">{fileName}</span>
                        <span className="git-modal__filepath">{file.path}</span>
                        <span
                          className="git-modal__status"
                          style={{ color: getStatusColor(file.status) }}
                        >
                          {getStatusLabel(file.status)}
                        </span>
                      </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="git-modal__field">
                <div className="git-modal__label-row">
                  <label className="git-modal__label">提交信息</label>
                  {onAISummarize && (
                    <button
                      className="git-modal__ai-btn"
                      onClick={handleAISummarize}
                      disabled={isSummarizing || selectedFiles.size === 0}
                      title="AI 总结变更"
                    >
                      {isSummarizing ? (
                        <Loader2 size={13} className="git-modal__spin" />
                      ) : (
                        <Sparkles size={13} />
                      )}
                      <span>AI 总结</span>
                    </button>
                  )}
                </div>
                <textarea
                  className="git-modal__textarea"
                  value={commitMessage}
                  onChange={e => { setCommitMessage(e.target.value); clearTransient(); }}
                  onKeyDown={handleKeyDown}
                  placeholder="输入提交信息... (Ctrl+Enter 提交)"
                  rows={4}
                  autoFocus
                />
              </div>
            </div>
          )}

          {/* 历史标签页 */}
          {activeTab === 'history' && (
            <div className="git-modal__history">
              {rollbackTarget && (
                <div className="git-modal__confirm-bar">
                  <AlertTriangle size={14} />
                  <span>确认回滚到 {rollbackTarget.slice(0, 7)}？此操作不可撤销（hard reset）</span>
                  <div className="git-modal__confirm-actions">
                    <button
                      className="git-modal__small-btn git-modal__small-btn--cancel"
                      onClick={() => setRollbackTarget(null)}
                    >
                      取消
                    </button>
                    <button
                      className="git-modal__small-btn git-modal__small-btn--danger"
                      onClick={handleRollback}
                      disabled={isCommitting}
                    >
                      {isCommitting ? <Loader2 size={12} className="git-modal__spin" /> : <RotateCcw size={12} />}
                      确认回滚
                    </button>
                  </div>
                </div>
              )}
              <div className="git-modal__log-list">
                {isLoadingLog ? (
                  <div className="git-modal__loading">
                    <Loader2 size={16} className="git-modal__spin" />
                    <span>加载中...</span>
                  </div>
                ) : logEntries.length === 0 ? (
                  <div className="git-modal__empty">没有提交历史</div>
                ) : (
                  logEntries.map(entry => (
                    <div key={entry.hash} className="git-modal__log-entry">
                      <div className="git-modal__log-hash">{entry.shortHash}</div>
                      <div className="git-modal__log-content">
                        <div className="git-modal__log-message" title={entry.message}>{entry.message}</div>
                        <div className="git-modal__log-meta">
                          <span>{entry.author}</span>
                          <span>·</span>
                          <span>{entry.date}</span>
                        </div>
                      </div>
                      <button
                        className="git-modal__small-btn git-modal__small-btn--warning"
                        title="回滚到此提交（hard reset）"
                        onClick={() => { setRollbackTarget(entry.hash); clearTransient(); }}
                        disabled={!!rollbackTarget}
                      >
                        <RotateCcw size={12} />
                        回滚
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* 远程标签页 */}
          {activeTab === 'remote' && (
            <div className="git-modal__remote">
              <div className="git-modal__remote-info">
                <div className="git-modal__remote-row">
                  <span className="git-modal__remote-label">当前分支</span>
                  <span className="git-modal__remote-value">{branch || '-'}</span>
                </div>
                <div className="git-modal__remote-row">
                  <span className="git-modal__remote-label">领先远程</span>
                  <span className="git-modal__remote-value git-modal__remote-value--ahead">{ahead} 个提交</span>
                </div>
                <div className="git-modal__remote-row">
                  <span className="git-modal__remote-label">落后远程</span>
                  <span className="git-modal__remote-value git-modal__remote-value--behind">{behind} 个提交</span>
                </div>
              </div>

              <div className="git-modal__remote-actions">
                <button
                  className="git-modal__action-btn git-modal__action-btn--primary"
                  onClick={handlePull}
                  disabled={isPulling || isPushing}
                >
                  {isPulling ? (
                    <Loader2 size={14} className="git-modal__spin" />
                  ) : (
                    <GitPullRequest size={14} />
                  )}
                  <span>拉取 (Pull)</span>
                </button>
                <button
                  className="git-modal__action-btn git-modal__action-btn--accent"
                  onClick={handlePush}
                  disabled={isPushing || isPulling}
                >
                  {isPushing ? (
                    <Loader2 size={14} className="git-modal__spin" />
                  ) : (
                    <Upload size={14} />
                  )}
                  <span>推送 (Push)</span>
                </button>
              </div>
              <p className="git-modal__remote-tip">
                拉取会合并远程变更到本地；推送会将本地提交上传到远程仓库。
              </p>
            </div>
          )}
        </div>

        {activeTab === 'changes' && (
          <div className="git-modal__footer">
            <button className="git-modal__cancel-btn" onClick={onClose}>
              取消
            </button>
            <button
              className="git-modal__commit-btn"
              onClick={handleCommit}
              disabled={isCommitting || selectedFiles.size === 0 || !commitMessage.trim()}
            >
              {isCommitting ? (
                <>
                  <Loader2 size={14} className="git-modal__spin" />
                  <span>提交中...</span>
                </>
              ) : (
                <>
                  <GitCommit size={14} />
                  <span>提交</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default GitModal;
