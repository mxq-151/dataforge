import React, { useState, useRef, useEffect } from 'react';
import { Check, X } from 'lucide-react';
import { useToast } from '../../../components/Toast';
import '../ExplorerPanel.css';

export interface RenameTarget {
  filePath: string;
  name: string;
  type: string;
}

interface RenameDialogProps {
  node: RenameTarget;
  onRenameNode: (oldPath: string, newName: string, nodeType: 'file' | 'folder') => Promise<boolean>;
  onClose: () => void;
}

/** 重命名对话框：自动聚焦并全选文件名，Enter 提交 / Esc 取消 */
const RenameDialog: React.FC<RenameDialogProps> = ({ node, onRenameNode, onClose }) => {
  const toast = useToast();
  const [value, setValue] = useState(node.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  const handleSubmit = async () => {
    if (!value.trim()) return;

    const success = await onRenameNode(
      node.filePath,
      value.trim(),
      node.type === 'Folder' ? 'folder' : 'file'
    );

    if (success) {
      toast.info('重命名成功');
    } else {
      toast.error('重命名失败');
    }

    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  return (
    <div className="explorer-panel__rename-overlay" onClick={handleCancel}>
      <div className="explorer-panel__rename-input-wrapper" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="explorer-panel__rename-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
            if (e.key === 'Escape') handleCancel();
          }}
        />
        <button
          className="explorer-panel__rename-confirm"
          onMouseDown={(e) => { e.preventDefault(); handleSubmit(); }}
          title="确认重命名"
        >
          <Check size={16} />
        </button>
        <button
          className="explorer-panel__rename-cancel"
          onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
          title="取消"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
};

export default RenameDialog;
