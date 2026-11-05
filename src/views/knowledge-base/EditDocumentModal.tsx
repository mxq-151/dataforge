import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { DocType, DOC_TYPE_OPTIONS, KnowledgeDocument } from '../../api/knowledge';
import './EditDocumentModal.css';

interface EditDocumentModalProps {
  document: KnowledgeDocument;
  onClose: () => void;
  onConfirm: (doc: { id: number; title: string; docType: DocType; description?: string }) => void;
}

const EditDocumentModal: React.FC<EditDocumentModalProps> = ({ document, onClose, onConfirm }) => {
  const [title, setTitle] = useState(document.title);
  const [docType, setDocType] = useState<DocType>(document.docType);
  const [description, setDescription] = useState(document.description || '');

  useEffect(() => {
    setTitle(document.title);
    setDocType(document.docType);
    setDescription(document.description || '');
  }, [document]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    onConfirm({
      id: document.id,
      title: title.trim(),
      docType,
      description: description.trim(),
    });
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="edit-document-modal__backdrop" onClick={handleBackdropClick}>
      <div className="edit-document-modal">
        <div className="edit-document-modal__header">
          <h2 className="edit-document-modal__title">编辑文档信息</h2>
          <button className="edit-document-modal__close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="edit-document-modal__form">
          <div className="edit-document-modal__field">
            <label className="edit-document-modal__label" htmlFor="edit-doc-title">
              文档标题 <span className="edit-document-modal__required">*</span>
            </label>
            <input
              id="edit-doc-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="请输入文档标题"
              className="edit-document-modal__input"
              autoFocus
            />
          </div>

          <div className="edit-document-modal__field">
            <label className="edit-document-modal__label" htmlFor="edit-doc-type">
              文档类型 <span className="edit-document-modal__required">*</span>
            </label>
            <select
              id="edit-doc-type"
              value={docType}
              onChange={(e) => setDocType(e.target.value as DocType)}
              className="edit-document-modal__select"
            >
              {DOC_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div className="edit-document-modal__field">
            <label className="edit-document-modal__label" htmlFor="edit-doc-description">
              文档描述
            </label>
            <textarea
              id="edit-doc-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="请输入文档简要描述（可选）"
              className="edit-document-modal__textarea edit-document-modal__textarea--small"
              rows={3}
            />
          </div>

          <div className="edit-document-modal__actions">
            <button type="button" className="edit-document-modal__btn edit-document-modal__btn--cancel" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="edit-document-modal__btn edit-document-modal__btn--confirm"
              disabled={!title.trim()}
            >
              保存修改
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EditDocumentModal;
