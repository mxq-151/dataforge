import React, { useState } from 'react';
import { X } from 'lucide-react';
import { DocType, DOC_TYPE_OPTIONS } from '../../api/knowledge';
import './AddDocumentModal.css';

interface AddDocumentModalProps {
  onClose: () => void;
  onConfirm: (doc: { title: string; docType: DocType; content: string; description?: string }) => void;
}

const AddDocumentModal: React.FC<AddDocumentModalProps> = ({ onClose, onConfirm }) => {
  const [title, setTitle] = useState('');
  const [docType, setDocType] = useState<DocType>(DocType.BUSINESS_KNOWLEDGE);
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    onConfirm({
      title: title.trim(),
      docType,
      content: content.trim(),
      description: description.trim(),
    });
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="add-document-modal__backdrop" onClick={handleBackdropClick}>
      <div className="add-document-modal">
        <div className="add-document-modal__header">
          <h2 className="add-document-modal__title">新增文档</h2>
          <button className="add-document-modal__close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="add-document-modal__form">
          <div className="add-document-modal__field">
            <label className="add-document-modal__label" htmlFor="doc-title">
              文档标题 <span className="add-document-modal__required">*</span>
            </label>
            <input
              id="doc-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="请输入文档标题"
              className="add-document-modal__input"
              autoFocus
            />
          </div>

          <div className="add-document-modal__field">
            <label className="add-document-modal__label" htmlFor="doc-type">
              文档类型 <span className="add-document-modal__required">*</span>
            </label>
            <select
              id="doc-type"
              value={docType}
              onChange={(e) => setDocType(e.target.value as DocType)}
              className="add-document-modal__select"
            >
              {DOC_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div className="add-document-modal__field">
            <label className="add-document-modal__label" htmlFor="doc-description">
              文档描述
            </label>
            <input
              id="doc-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="请输入文档简要描述（可选）"
              className="add-document-modal__input"
            />
          </div>

          <div className="add-document-modal__field">
            <label className="add-document-modal__label" htmlFor="doc-content">
              文档内容
            </label>
            <textarea
              id="doc-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="请输入文档内容（支持Markdown格式）..."
              className="add-document-modal__textarea"
              rows={8}
            />
          </div>

          <div className="add-document-modal__actions">
            <button type="button" className="add-document-modal__btn add-document-modal__btn--cancel" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="add-document-modal__btn add-document-modal__btn--confirm"
              disabled={!title.trim()}
            >
              确认添加
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddDocumentModal;
