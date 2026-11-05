import { useState, useCallback, useEffect } from 'react';
import {
  X,
  History,
  GitCommitHorizontal,
  User,
  Calendar,
  FileCode2,
  RotateCcw,
} from 'lucide-react';
import { gitLogFile, gitShowFileContent, GitLogEntry } from '../../api/git';
import { useToast } from '../../components/Toast';
import './FileHistoryModal.css';

interface FileHistoryModalProps {
  /** 文件在磁盘上的完整路径 */
  filePath: string;
  /** 仓库根目录 */
  repoPath: string;
  onClose: () => void;
  /** 用指定提交的内容回滚文件 */
  onRollback: (commitHash: string, content: string) => Promise<boolean>;
}

export default function FileHistoryModal({
  filePath,
  repoPath,
  onClose,
  onRollback,
}: FileHistoryModalProps) {
  const toast = useToast();
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);

  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  // 计算相对仓库根的 POSIX 路径
  const relPath = useCallback(() => {
    const sep = filePath.includes('\\') ? '\\' : '/';
    const parts = filePath.split(sep);
    const repoParts = repoPath.split(sep);
    const diffParts: string[] = [];
    const max = Math.max(parts.length, repoParts.length);
    for (let i = 0; i < max; i++) {
      if (parts[i] !== repoParts[i]) {
        // 剩余未匹配的部分拼接为相对路径
        for (let j = i; j < parts.length; j++) {
          diffParts.push(parts[j]);
        }
        break;
      }
    }
    return diffParts.length > 0 ? diffParts.join('/') : fileName;
  }, [filePath, repoPath, fileName]);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setEntries([]);
    setSelectedHash(null);
    setPreview('');
    try {
      const result = await gitLogFile(repoPath, relPath());
      setEntries(result.entries);
      // 默认选中最近一次提交并加载内容
      if (result.entries.length > 0) {
        selectCommit(result.entries[0].hash);
      }
    } catch (err) {
      console.error('加载文件历史失败:', err);
      toast.error('加载文件历史失败');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, relPath, toast]);

  const selectCommit = useCallback(async (hash: string) => {
    setSelectedHash(hash);
    setConfirmRollback(false);
    setPreviewLoading(true);
    setPreview('');
    try {
      const content = await gitShowFileContent(repoPath, hash, relPath());
      setPreview(content ?? '');
    } finally {
      setPreviewLoading(false);
    }
  }, [repoPath, relPath]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // 回滚二次确认：第一次点击进入确认态，再次点击才真正执行
  const handleRollbackClick = useCallback(async () => {
    if (!selectedHash || preview === '') return;
    if (!confirmRollback) {
      setConfirmRollback(true);
      return;
    }
    setRollingBack(true);
    try {
      const ok = await onRollback(selectedHash, preview);
      if (ok) {
        toast.info(`已回滚至提交 ${selectedHash.slice(0, 7)}`);
        onClose();
      } else {
        toast.error('回滚失败');
      }
    } finally {
      setRollingBack(false);
    }
  }, [selectedHash, preview, confirmRollback, onRollback, onClose, toast]);

  const selectedDate = entries.find(e => e.hash === selectedHash)?.date;
  const selectedAuthor = entries.find(e => e.hash === selectedHash)?.author;

  return (
    <div className="fh-modal__overlay" onClick={onClose}>
      <div className="fh-modal" onClick={e => e.stopPropagation()}>
        <div className="fh-modal__header">
          <History size={18} className="fh-modal__header-icon" />
          <span>文件历史版本</span>
          <button className="fh-modal__header-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="fh-modal__file">
          <FileCode2 size={15} />
          <span className="fh-modal__file-name" title={filePath}>{fileName}</span>
        </div>

        <div className="fh-modal__body">
          <div className="fh-modal__list">
            {loading ? (
              <div className="fh-modal__empty">加载历史中...</div>
            ) : entries.length === 0 ? (
              <div className="fh-modal__empty">
                该文件暂无 Git 历史（可能尚未纳入版本管理或从未提交）
              </div>
            ) : (
              entries.map((entry) => {
                const active = entry.hash === selectedHash;
                return (
                  <div
                    key={entry.hash}
                    className={`fh-modal__row${active ? ' fh-modal__row--active' : ''}`}
                    onClick={() => selectCommit(entry.hash)}
                  >
                    <div className="fh-modal__row-title">
                      <GitCommitHorizontal size={14} />
                      <span className="fh-modal__row-msg" title={entry.message}>
                        {entry.message || '(无提交信息)'}
                      </span>
                    </div>
                    <div className="fh-modal__row-meta">
                      <span className="fh-modal__row-hash">{entry.shortHash}</span>
                      <span className="fh-modal__row-date">{entry.date}</span>
                      <span className="fh-modal__row-author" title={entry.author}>{entry.author}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="fh-modal__preview">
            <div className="fh-modal__preview-header">
              <div className="fh-modal__preview-meta">
                {selectedHash && preview !== '' ? (
                  <>
                    <span><User size={13} /> {selectedAuthor || '-'}</span>
                    <span><Calendar size={13} /> {selectedDate || '-'}</span>
                  </>
                ) : (
                  selectedHash ? '该版本文件中无内容' : '请在左侧选择一个版本查看内容'
                )}
              </div>
              <button
                className={`fh-modal__rollback${confirmRollback ? ' fh-modal__rollback--confirm' : ''}`}
                onClick={handleRollbackClick}
                disabled={!selectedHash || preview === '' || rollingBack || previewLoading}
                title={confirmRollback ? '再次点击确认将当前文件恢复为该版本内容' : '将当前文件恢复为该版本内容'}
              >
                <RotateCcw size={14} />
                {rollingBack ? '回滚中...' : confirmRollback ? '确认回滚？' : '回滚'}
              </button>
            </div>
            <div className="fh-modal__preview-content">
              {previewLoading ? (
                <div className="fh-modal__preview-loading">加载内容中...</div>
              ) : (
                <pre>{preview === '' && selectedHash ? '(该版本文件中无内容)' : preview}</pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}