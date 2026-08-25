import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Upload, FolderPlus, Folder, FileText, RefreshCw, AlertCircle, ArrowLeft, ChevronRight, X } from 'lucide-react';
import { fileExplorerApi, StorageConfig, FileInfo } from '../../api/fileExplorer';
import { useToast } from '../../components/Toast';
import { splitPath } from '../../utils/pathUtils';
import './FileBrowserPanel.css';

const MAX_PREVIEW_SIZE = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico'];
const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'bat', 'sql', 'csv', 'log', 'yaml', 'yml', 'ini', 'conf', 'env', 'gitignore', 'dockerfile', 'makefile', 'properties', 'vue', 'svelte', 'rb', 'go', 'rs', 'php', 'swift', 'kt', 'scala', 'r', 'm', 'mm'];
const ARCHIVE_EXTENSIONS = ['gz', 'gzip', 'tar', 'zip', 'rar', '7z', 'bz2'];

const getFileExtension = (filename: string): string => {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
};

const isPreviewableImage = (filename: string): boolean => {
  return IMAGE_EXTENSIONS.includes(getFileExtension(filename));
};

const isPreviewableArchive = (filename: string): boolean => {
  return ARCHIVE_EXTENSIONS.includes(getFileExtension(filename));
};

const canPreviewFile = (file: FileInfo): boolean => {
  if (file.isDir) return false;
  if (file.size > MAX_PREVIEW_SIZE) return false;
  return [...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS, ...ARCHIVE_EXTENSIONS].includes(getFileExtension(file.name));
};

interface PreviewModalProps {
  file: FileInfo;
  onClose: () => void;
}

const PreviewModal: React.FC<PreviewModalProps> = ({ file, onClose }) => {
  const [content, setContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadPreview();
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, []);

  const loadPreview = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const configId = (window as any).__currentConfigId;
      const storageType = (window as any).__currentStorageType || 'local';
      
      if (isPreviewableImage(file.name)) {
        const blob = await fileExplorerApi.previewFile(storageType, file.path || '', configId);
        setBlobUrl(URL.createObjectURL(blob));
        setContent(null);
      } else {
        const blob = await fileExplorerApi.previewFile(storageType, file.path || '', configId);
        setContent(await blob.text());
        setBlobUrl(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="preview-modal" onClick={onClose}>
      <div className="preview-modal__content" onClick={(e) => e.stopPropagation()}>
        <div className="preview-modal__header">
          <h3 className="preview-modal__title">{file.name}</h3>
          <button className="preview-modal__close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="preview-modal__body">
          {loading && <div className="preview-modal__loading">加载中...</div>}
          {error && (
            <div className="preview-modal__error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}
          {!loading && !error && blobUrl && (
            <img src={blobUrl} alt={file.name} className="preview-modal__image" 
                 style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} />
          )}
          {!loading && !error && content !== null && (
            <pre className="preview-modal__text"><code>{content}</code></pre>
          )}
          {!loading && !error && !blobUrl && content === null && isPreviewableArchive(file.name) && (
            <div className="preview-modal__info">
              <Folder size={48} />
              <p>这是一个压缩包文件</p>
              <p className="preview-modal__meta">
                文件名：{file.name}<br/>
                大小：{(file.size / 1024 / 1024).toFixed(2)} MB<br/>
                类型：{getFileExtension(file.name).toUpperCase()}
              </p>
              <p className="preview-modal__hint">请下载后使用解压工具查看内容</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface InputModalProps {
  title: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

const InputModal: React.FC<InputModalProps> = ({ 
  title, 
  label, 
  placeholder = '', 
  defaultValue = '',
  onConfirm, 
  onCancel 
}) => {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      onConfirm(value.trim());
    }
  };

  return (
    <div className="input-modal" onClick={onCancel}>
      <div className="input-modal__content" onClick={(e) => e.stopPropagation()}>
        <div className="input-modal__header">
          <h3 className="input-modal__title">{title}</h3>
          <button className="input-modal__close" onClick={onCancel}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="input-modal__form">
          <div className="input-modal__field">
            <label className="input-modal__label">{label}</label>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              className="input-modal__input"
              autoFocus
            />
          </div>

          <div className="input-modal__actions">
            <button type="button" className="input-modal__btn input-modal__btn--cancel" onClick={onCancel}>
              取消
            </button>
            <button 
              type="submit" 
              className="input-modal__btn input-modal__btn--confirm"
              disabled={!value.trim()}
            >
              确定
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({ 
  title, 
  message, 
  confirmText = '确定',
  cancelText = '取消',
  type = 'danger',
  onConfirm, 
  onCancel 
}) => {
  return (
    <div className={`confirm-modal confirm-modal--${type}`} onClick={onCancel}>
      <div className="confirm-modal__content" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-modal__header">
          <h3 className="confirm-modal__title">{title}</h3>
          <button className="confirm-modal__close" onClick={onCancel}>
            <X size={20} />
          </button>
        </div>

        <div className="confirm-modal__body">
          <AlertCircle size={48} className="confirm-modal__icon" />
          <p className="confirm-modal__message">{message}</p>
        </div>

        <div className="confirm-modal__actions">
          <button className="confirm-modal__btn confirm-modal__btn--cancel" onClick={onCancel}>
            {cancelText}
          </button>
          <button className="confirm-modal__btn confirm-modal__btn--confirm" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

const FileBrowserPanel: React.FC = () => {
  const toast = useToast();
  const [storageConfigs, setStorageConfigs] = useState<StorageConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState<number | null>(null);
  const [currentPath, setCurrentPath] = useState('/');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [filePage, setFilePage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileInfo | null>(null);
  const [showInputModal, setShowInputModal] = useState(false);
  const [inputModalConfig, setInputModalConfig] = useState<{ title: string; label: string; placeholder: string; onConfirm: (value: string) => void } | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmModalConfig, setConfirmModalConfig] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadStorageConfigs();
  }, []);

  useEffect(() => {
    if (selectedConfigId !== null) loadFiles();
  }, [selectedConfigId, currentPath]);

  useEffect(() => {
    (window as any).__currentConfigId = selectedConfigId;
    (window as any).__currentStorageType = storageConfigs.find(c => c.id === selectedConfigId)?.storageType || 'local';
  }, [selectedConfigId, storageConfigs]);

  const loadStorageConfigs = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fileExplorerApi.getStorageConfigList(1, 100);
      if (res.code === 200 && res.data) {
        setStorageConfigs(res.data.records || []);
        if (res.data.records?.length > 0) {
          setSelectedConfigId(res.data.records[0].id);
          if (res.data.records[0].rootPath) setCurrentPath(res.data.records[0].rootPath);
        }
      } else {
        setError(res.message || '获取存储配置失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取存储配置失败');
    } finally {
      setLoading(false);
    }
  };

  const loadFiles = async () => {
    if (selectedConfigId === null) return;

    try {
      setLoading(true);
      setError(null);
      const config = storageConfigs.find(c => c.id === selectedConfigId);
      const res = await fileExplorerApi.listFiles(config?.storageType || 'local', currentPath, selectedConfigId);
      if (res.code === 200 && res.data) {
        setFiles(res.data);
        setFilePage(1);
      } else {
        setError(res.message || '获取文件列表失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取文件列表失败');
    } finally {
      setLoading(false);
    }
  };

  const FILE_PAGE_SIZE = 20;
  const fileTotal = files.length;
  const pagedFiles = useMemo(() => {
    const start = (filePage - 1) * FILE_PAGE_SIZE;
    return files.slice(start, start + FILE_PAGE_SIZE);
  }, [files, filePage]);

  const renderPagination = () => {
    const totalPages = Math.max(1, Math.ceil(fileTotal / FILE_PAGE_SIZE));
    const pages: (number | '...')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (filePage > 3) pages.push('...');
      const start = Math.max(2, filePage - 1);
      const end = Math.min(totalPages - 1, filePage + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (filePage < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return (
      <div className="sys-mgmt__pagination">
        <button className="sys-mgmt__page-btn" disabled={filePage <= 1} onClick={() => setFilePage(filePage - 1)}>上一页</button>
        {pages.map((p, idx) =>
          p === '...' ? (
            <span key={`ellipsis-${idx}`} className="sys-mgmt__page-ellipsis">...</span>
          ) : (
            <button
              key={p}
              className={`sys-mgmt__page-num ${filePage === p ? 'sys-mgmt__page-num--active' : ''}`}
              onClick={() => setFilePage(p)}
            >
              {p}
            </button>
          )
        )}
        <button className="sys-mgmt__page-btn" disabled={filePage >= totalPages} onClick={() => setFilePage(filePage + 1)}>下一页</button>
        <span className="sys-mgmt__page-info">(共{fileTotal}条)</span>
      </div>
    );
  };

  const getFilePath = (file: FileInfo): string => {
    if (file.path) return file.path;
    return `${currentPath.endsWith('/') ? '' : '/'}${file.name}`;
  };

  const handleNewFolderButtonClick = () => {
    
    if (selectedConfigId === null) {
      toast.warning('请先选择存储配置');
      return;
    }

    setInputModalConfig({
      title: '新建文件夹',
      label: '文件夹名称',
      placeholder: '请输入文件夹名称',
      onConfirm: (name) => {
        setShowInputModal(false);
        createFolder(name);
      }
    });
    setShowInputModal(true);
  };

  const createFolder = async (name: string) => {
    try {
      setCreatingFolder(true);
      setError(null);
      const config = storageConfigs.find(c => c.id === selectedConfigId);
      await fileExplorerApi.createDirectory(config?.storageType || 'local', currentPath, name, selectedConfigId ?? undefined);
      toast.info('文件夹 "' + name + '" 创建成功');
      await loadFiles();
    } catch (err) {
      console.error('[ERROR] 创建文件夹失败:', err);
      const msg = err instanceof Error ? err.message : '未知错误';
      setError(msg);
      toast.error('创建失败: ' + msg);
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDeleteButtonClick = (file: FileInfo, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    
    if (selectedConfigId === null) {
      toast.warning('请先选择存储配置');
      return;
    }

    if (loading) {
      toast.warning('正在加载中');
      return;
    }

    setConfirmModalConfig({
      title: '确认删除',
      message: `确定要删除 "${file.name}" 吗？\n\n此操作不可恢复！`,
      onConfirm: () => {
        setShowConfirmModal(false);
        deleteFile(file);
      }
    });
    setShowConfirmModal(true);
  };

  const deleteFile = async (file: FileInfo) => {
    try {
      setLoading(true);
      setError(null);
      const config = storageConfigs.find(c => c.id === selectedConfigId);
      const filePath = getFilePath(file);

      console.log('[API] 删除文件:', { storageType: config?.storageType, filePath, configId: selectedConfigId });

      await fileExplorerApi.deleteFile(config?.storageType || 'local', filePath, selectedConfigId ?? undefined);
      
      toast.info('文件 "' + file.name + '" 已删除');
      await loadFiles();
    } catch (err) {
      console.error('[ERROR] 删除失败:', err);
      const msg = err instanceof Error ? err.message : '未知错误';
      setError(msg);
      toast.error('删除失败: ' + msg);
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList?.length || selectedConfigId === null) return;

    try {
      setUploading(true);
      setError(null);
      const config = storageConfigs.find(c => c.id === selectedConfigId);

      for (const file of Array.from(fileList)) {
        await fileExplorerApi.uploadFile(config?.storageType || 'local', currentPath, file, selectedConfigId);
      }

      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRename = async (file: FileInfo, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (selectedConfigId === null || loading) return;

    const newName = prompt('请输入新名称：', file.name);
    if (!newName?.trim() || newName.trim() === file.name) return;

    try {
      setLoading(true);
      setError(null);
      const config = storageConfigs.find(c => c.id === selectedConfigId);
      await fileExplorerApi.renameFile(config?.storageType || 'local', getFilePath(file), newName.trim(), selectedConfigId);
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (file: FileInfo, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (selectedConfigId === null || loading) return;

    try {
      setError(null);
      const config = storageConfigs.find(c => c.id === selectedConfigId);
      const blob = await fileExplorerApi.downloadFile(config?.storageType || 'local', getFilePath(file), selectedConfigId);
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败');
    }
  };

  const handlePreview = (file: FileInfo, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (!canPreviewFile(file)) return;
    setPreviewFile({ ...file, path: getFilePath(file) });
  };

  const handleEnterDirectory = (file: FileInfo) => {
    if (!file.isDir) return;
    setCurrentPath(getFilePath(file));
  };

  const handleGoBack = () => {
    if (currentPath === '/') return;
    const parts = splitPath(currentPath);
    parts.pop();
    const config = storageConfigs.find(c => c.id === selectedConfigId);
    setCurrentPath(parts.length === 0 ? (config?.rootPath || '/') : '/' + parts.join('/'));
  };

  const handleNavigateToPath = (_part: string, index: number) => {
    const config = storageConfigs.find(c => c.id === selectedConfigId);
    const rootParts = splitPath(config?.rootPath || '/');

    if (index < rootParts.length) {
      setCurrentPath(config?.rootPath || '/');
      return;
    }

    const allParts = splitPath(currentPath);
    setCurrentPath('/' + allParts.slice(0, index + 1).join('/'));
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '-';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const canGoBack = (): boolean => {
    if (currentPath === '/') return false;
    const config = storageConfigs.find(c => c.id === selectedConfigId);
    return currentPath !== (config?.rootPath || '/');
  };

  return (
    <div className="file-browser-panel">
      <div className="file-browser-panel__header">
        <h2 className="file-browser-panel__title">文件浏览器</h2>
        <div className="file-browser-panel__toolbar">
          <select value={selectedConfigId || ''} onChange={(e) => {
            const id = parseInt(e.target.value);
            setSelectedConfigId(id);
            const config = storageConfigs.find(c => c.id === id);
            setCurrentPath(config?.rootPath || '/');
          }} className="file-browser-panel__path-select" disabled={loading}>
            {storageConfigs.map(config => (
              <option key={config.id} value={config.id}>
                {config.storageName} ({config.storageType})
              </option>
            ))}
          </select>
          
          <button className="file-browser-panel__btn file-browser-panel__btn--primary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || loading || selectedConfigId === null}>
            <Upload size={14} />{uploading ? '上传中...' : '上传'}
          </button>
          <input ref={fileInputRef} type="file" multiple onChange={handleUpload} style={{ display: 'none' }} />
          
          <button className="file-browser-panel__btn"
                  onMouseDown={() => console.log('[MOUSEDOWN] 新建文件夹按钮')}
                  onClick={handleNewFolderButtonClick}
                  disabled={creatingFolder || selectedConfigId === null}
                  title={selectedConfigId === null ? '请先选择存储配置' : '新建文件夹'}>
            <FolderPlus size={14} />{creatingFolder ? '创建中...' : '新建文件夹'}
          </button>
          
          <button className="file-browser-panel__btn" onClick={loadFiles} disabled={loading || selectedConfigId === null} title="刷新">
            <RefreshCw size={14} className={loading ? 'file-browser-panel__spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="file-browser-panel__error">
          <AlertCircle size={16} /><span>{error}</span>
        </div>
      )}

      <div className="file-browser-panel__content">
        <div className="file-browser-panel__breadcrumb">
          <button className={`file-browser-panel__back-btn ${!canGoBack() ? 'file-browser-panel__back-btn--disabled' : ''}`}
                  onClick={handleGoBack} disabled={!canGoBack()} title="返回上级目录">
            <ArrowLeft size={14} />
          </button>
          <span className="file-browser-panel__path-parts">
            {splitPath(currentPath).map((part, idx) => (
              <React.Fragment key={`${part}-${idx}`}>
                <ChevronRight size={12} className="file-browser-panel__breadcrumb-separator" />
                <span className="file-browser-panel__path-part" onClick={() => handleNavigateToPath(part, idx)} title={`导航到 ${part}`}>
                  {part}
                </span>
              </React.Fragment>
            ))}
          </span>
        </div>

        {loading && files.length === 0 ? (
          <div className="file-browser-panel__loading">加载中...</div>
        ) : files.length === 0 ? (
          <div className="file-browser-panel__empty">此目录为空</div>
        ) : (
          <>
          <table className="file-browser-panel__table">
            <thead>
              <tr>
                <th className="file-browser-panel__th file-browser-panel__th--name">名称</th>
                <th className="file-browser-panel__th">大小</th>
                <th className="file-browser-panel__th">修改时间</th>
                <th className="file-browser-panel__th">权限</th>
                <th className="file-browser-panel__th">操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedFiles.map((file, idx) => (
                <tr key={`${file.name}-${idx}`} className="file-browser-panel__row">
                  <td className="file-browser-panel__td file-browser-panel__td--name">
                    <div className="file-browser-panel__file-info"
                         onClick={() => { if (file.isDir) handleEnterDirectory(file); }}>
                      {file.isDir ? (
                        <>
                          <Folder size={18} className="file-browser-panel__icon file-browser-panel__icon--folder" />
                          <span className="file-browser-panel__filename file-browser-panel__filename--folder file-browser-panel__filename--clickable">{file.name}</span>
                        </>
                      ) : (
                        <>
                          <FileText size={18} className="file-browser-panel__icon file-browser-panel__icon--file" />
                          <span className="file-browser-panel__filename">{file.name}</span>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="file-browser-panel__td">{formatFileSize(file.size)}</td>
                  <td className="file-browser-panel__td">{file.modifiedTime}</td>
                  <td className="file-browser-panel__td file-browser-panel__td--permissions">{file.permissions}</td>
                  <td className="file-browser-panel__td file-browser-panel__td--actions">
                    <div className="file-browser-panel__action-group">
                      {!file.isDir && (
                        <button className={`file-browser-panel__action-btn ${!canPreviewFile(file) ? 'file-browser-panel__action-btn--disabled' : ''}`}
                                onClick={(e) => handlePreview(file, e)}
                                title={canPreviewFile(file) ? '预览文件' : '不支持预览'}
                                disabled={loading || !canPreviewFile(file)}>
                          预览
                        </button>
                      )}
                      {!file.isDir && (
                        <button className="file-browser-panel__action-btn"
                                onClick={(e) => handleDownload(file, e)}
                                title="下载" disabled={loading}>
                          下载
                        </button>
                      )}
                      <button className="file-browser-panel__action-btn file-browser-panel__action-btn--rename"
                              onClick={(e) => handleRename(file, e)}
                              title="重命名" disabled={loading}>
                        重命名
                      </button>
                      <button className="file-browser-panel__action-btn file-browser-panel__action-btn--delete"
                              onClick={(e) => handleDeleteButtonClick(file, e)}
                              title="删除" disabled={loading}
                              onMouseDown={(e) => { e.stopPropagation(); console.log('[DELETE-MOUSEDOWN]'); }}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {renderPagination()}
          </>
        )}
      </div>

      {previewFile && <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
      
      {showInputModal && inputModalConfig && (
        <InputModal
          title={inputModalConfig.title}
          label={inputModalConfig.label}
          placeholder={inputModalConfig.placeholder}
          onConfirm={inputModalConfig.onConfirm}
          onCancel={() => setShowInputModal(false)}
        />
      )}

      {showConfirmModal && confirmModalConfig && (
        <ConfirmModal
          title={confirmModalConfig.title}
          message={confirmModalConfig.message}
          onConfirm={confirmModalConfig.onConfirm}
          onCancel={() => setShowConfirmModal(false)}
        />
      )}
    </div>
  );
};

export default FileBrowserPanel;
