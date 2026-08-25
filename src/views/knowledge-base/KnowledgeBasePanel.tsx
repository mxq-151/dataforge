import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Search, FileText, FolderOpen, ChevronRight, ChevronDown, Trash2, AlertTriangle, Pencil, Save, X, Eye, Edit3 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { knowledgeApi, KnowledgeDocument, DocType, DOC_TYPE_OPTIONS } from '../../api/knowledge';
import AddDocumentModal from './AddDocumentModal';
import EditDocumentModal from './EditDocumentModal';
import './KnowledgeBasePanel.css';

const KnowledgeBasePanel: React.FC = () => {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [current] = useState(1);
  const [size] = useState(100);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingDoc, setEditingDoc] = useState<KnowledgeDocument | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<number | null>(null);
  const [isEditingContent, setIsEditingContent] = useState(false);
  const [editingContent, setEditingContent] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(DOC_TYPE_OPTIONS.map(opt => opt.value)));
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; docId: number; docTitle: string } | null>(null);
  const [isPreviewMode, setIsPreviewMode] = useState(true);

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const params: { keyword?: string } = {};
      if (searchQuery) params.keyword = searchQuery;

      const res = await knowledgeApi.getDocumentList(current, size, params);
      if (res.code === 200 && res.data) {
        setDocuments(res.data.records);
        setTotal(res.data.total);
      }
    } catch (error) {
      console.error('获取文档列表失败:', error);
    } finally {
      setLoading(false);
    }
  }, [current, size, searchQuery]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const handleAddDocument = async (doc: { title: string; docType: DocType; content: string; description?: string }) => {
    try {
      await knowledgeApi.createDocument({
        title: doc.title,
        docType: doc.docType,
        content: doc.content,
        description: doc.description,
      });
      setShowAddModal(false);
      fetchDocuments();
    } catch (error) {
      console.error('创建文档失败:', error);
    }
  };

  const handleDeleteClick = (id: number, title: string) => {
    setDeleteConfirm({ show: true, docId: id, docTitle: title });
  };

  const handleEditClick = (doc: KnowledgeDocument) => {
    setEditingDoc(doc);
    setShowEditModal(true);
  };

  const handleEditDocument = async (doc: { id: number; title: string; docType: DocType; description?: string }) => {
    try {
      await knowledgeApi.updateDocument({
        id: doc.id,
        title: doc.title,
        docType: doc.docType,
        description: doc.description,
      });
      setShowEditModal(false);
      setEditingDoc(null);
      fetchDocuments();
    } catch (error) {
      console.error('更新文档失败:', error);
    }
  };

  const handleStartEditContent = (doc: KnowledgeDocument) => {
    setEditingContent(doc.content || '');
    setIsEditingContent(true);
    setIsPreviewMode(false);
  };

  const handleSaveContent = async () => {
    if (!selectedDocId) return;

    const currentDoc = documents.find(d => d.id === selectedDocId);
    if (!currentDoc) return;

    try {
      await knowledgeApi.updateDocument({
        id: selectedDocId,
        title: currentDoc.title,
        docType: currentDoc.docType,
        content: editingContent,
      });
      setIsEditingContent(false);
      setIsPreviewMode(true);
      fetchDocuments();
    } catch (error) {
      console.error('保存文档内容失败:', error);
    }
  };

  const handleCancelEditContent = () => {
    setIsEditingContent(false);
    setEditingContent('');
    setIsPreviewMode(true);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;

    try {
      await knowledgeApi.deleteDocument(deleteConfirm.docId);
      if (selectedDocId === deleteConfirm.docId) {
        setSelectedDocId(null);
      }
      fetchDocuments();
    } catch (error) {
      console.error('删除文档失败:', error);
    } finally {
      setDeleteConfirm(null);
    }
  };

  const cancelDelete = () => {
    setDeleteConfirm(null);
  };

  const handleDocumentClick = async (doc: KnowledgeDocument) => {
    setSelectedDocId(doc.id);
    setIsEditingContent(false);
    setIsPreviewMode(true);
    try {
      await knowledgeApi.incrementViewCount(doc.id);
    } catch (error) {
      console.error('更新浏览次数失败:', error);
    }
  };

  const toggleNode = (nodeId: string) => {
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      return newSet;
    });
  };

  const getDocTypeLabel = (type: DocType) => {
    return DOC_TYPE_OPTIONS.find(opt => opt.value === type)?.label || type;
  };

  const groupDocumentsByType = () => {
    const groups: Record<string, KnowledgeDocument[]> = {};

    DOC_TYPE_OPTIONS.forEach(opt => {
      groups[opt.value] = [];
    });

    documents.forEach(doc => {
      const typeKey = doc.docType;
      if (!groups[typeKey]) {
        groups[typeKey] = [];
      }
      groups[typeKey].push(doc);
    });

    return groups;
  };

  const documentGroups = groupDocumentsByType();

  return (
    <div className="knowledge-base-panel">
      <div className="knowledge-base-panel__header">
        <h2 className="knowledge-base-panel__title">知识库</h2>
        <button
          className="knowledge-base-panel__add-btn"
          onClick={() => setShowAddModal(true)}
          title="新增文档"
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="knowledge-base-panel__search">
        <Search size={14} className="knowledge-base-panel__search-icon" />
        <input
          type="text"
          placeholder="搜索文档..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="knowledge-base-panel__search-input"
        />
      </div>

      <div className="knowledge-base-panel__content">
        <div className="knowledge-base-panel__tree">
          {loading ? (
            <div className="knowledge-base-panel__loading">加载中...</div>
          ) : (
            DOC_TYPE_OPTIONS.map(typeOpt => {
              const docs = documentGroups[typeOpt.value] || [];
              const isTypeExpanded = expandedNodes.has(typeOpt.value);

              return (
                <div key={typeOpt.value} className="knowledge-base-panel__type-node">
                  <div
                    className="knowledge-base-panel__node-header knowledge-base-panel__type-header"
                    onClick={() => toggleNode(typeOpt.value)}
                  >
                    {isTypeExpanded ? (
                      <ChevronDown size={14} className="knowledge-base-panel__chevron" />
                    ) : (
                      <ChevronRight size={14} className="knowledge-base-panel__chevron" />
                    )}
                    <FolderOpen size={16} className="knowledge-base-panel__icon knowledge-base-panel__icon--primary" />
                    <span className="knowledge-base-panel__node-label">{typeOpt.label}</span>
                    <span className="knowledge-base-panel__count">{docs.length}</span>
                  </div>

                  {isTypeExpanded && (
                    <div className="knowledge-base-panel__children">
                      {docs.map(doc => (
                        <div
                          key={doc.id}
                          className={`knowledge-base-panel__document ${selectedDocId === doc.id ? 'knowledge-base-panel__document--active' : ''}`}
                          onClick={() => handleDocumentClick(doc)}
                        >
                          <FileText size={14} />
                          <span className="knowledge-base-panel__document-title">{doc.title}</span>
                          <div className="knowledge-base-panel__document-actions">
                            <button
                              className="knowledge-base-panel__action-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEditClick(doc);
                              }}
                              title="编辑"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              className="knowledge-base-panel__action-btn knowledge-base-panel__action-btn--danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteClick(doc.id, doc.title);
                              }}
                              title="删除"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {!loading && documents.length === 0 && (
            <div className="knowledge-base-panel__empty">暂无文档</div>
          )}

          {!loading && documents.length > 0 && (
            <div className="knowledge-base-panel__footer-info">
              共 {total} 条文档
            </div>
          )}
        </div>

        {selectedDocId && (
          <div className="knowledge-base-panel__detail">
            {(() => {
              const doc = documents.find(d => d.id === selectedDocId);
              if (!doc) return null;

              return (
                <>
                  <div className="knowledge-base-panel__detail-header">
                    <div className="knowledge-base-panel__detail-header-top">
                      <h3>{doc.title}</h3>
                      <div className="knowledge-base-panel__detail-toolbar">
                        {isEditingContent ? (
                          <>
                            <button
                              className={`knowledge-base-panel__toolbar-btn ${isPreviewMode ? '' : 'knowledge-base-panel__toolbar-btn--active'}`}
                              onClick={() => setIsPreviewMode(false)}
                              title="编辑模式"
                            >
                              <Edit3 size={14} />
                              <span>编辑</span>
                            </button>
                            <button
                              className={`knowledge-base-panel__toolbar-btn ${isPreviewMode ? 'knowledge-base-panel__toolbar-btn--active' : ''}`}
                              onClick={() => setIsPreviewMode(true)}
                              title="预览模式"
                            >
                              <Eye size={14} />
                              <span>预览</span>
                            </button>
                            <button
                              className="knowledge-base-panel__toolbar-btn knowledge-base-panel__toolbar-btn--save"
                              onClick={handleSaveContent}
                              title="保存"
                            >
                              <Save size={14} />
                              <span>保存</span>
                            </button>
                            <button
                              className="knowledge-base-panel__toolbar-btn knowledge-base-panel__toolbar-btn--cancel"
                              onClick={handleCancelEditContent}
                              title="取消"
                            >
                              <X size={14} />
                              <span>取消</span>
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className={`knowledge-base-panel__toolbar-btn ${isPreviewMode ? 'knowledge-base-panel__toolbar-btn--active' : ''}`}
                              onClick={() => setIsPreviewMode(true)}
                              title="预览模式"
                            >
                              <Eye size={14} />
                              <span>预览</span>
                            </button>
                            <button
                              className={`knowledge-base-panel__toolbar-btn ${!isPreviewMode ? 'knowledge-base-panel__toolbar-btn--active' : ''}`}
                              onClick={() => setIsPreviewMode(false)}
                              title="源码模式"
                            >
                              <Edit3 size={14} />
                              <span>源码</span>
                            </button>
                            <button
                              className="knowledge-base-panel__toolbar-btn"
                              onClick={() => handleStartEditContent(doc)}
                              title="编辑内容"
                            >
                              <Pencil size={14} />
                              <span>编辑</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="knowledge-base-panel__detail-meta">
                      <span className="knowledge-base-panel__badge knowledge-base-panel__badge--primary">
                        {getDocTypeLabel(doc.docType)}
                      </span>
                      {doc.authorName && <span>作者: {doc.authorName}</span>}
                      <span>浏览: {doc.viewCount || 0}</span>
                      <span>{new Date(doc.updateTime).toLocaleDateString()}</span>
                    </div>
                  </div>
                  {doc.description && (
                    <div className="knowledge-base-panel__detail-description">
                      <p>{doc.description}</p>
                    </div>
                  )}
                  <div className="knowledge-base-panel__detail-content">
                    {isEditingContent ? (
                      isPreviewMode ? (
                        <div className="knowledge-base-panel__markdown-preview">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {editingContent || '暂无内容'}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <textarea
                          className="knowledge-base-panel__content-editor"
                          value={editingContent}
                          onChange={(e) => setEditingContent(e.target.value)}
                          placeholder="请输入文档内容（支持Markdown格式）..."
                        />
                      )
                    ) : (
                      isPreviewMode ? (
                        <div className="knowledge-base-panel__markdown-preview">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {doc.content || '暂无内容'}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <pre className="knowledge-base-panel__source-view">{doc.content || '暂无内容'}</pre>
                      )
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {showAddModal && (
        <AddDocumentModal
          onClose={() => setShowAddModal(false)}
          onConfirm={handleAddDocument}
        />
      )}

      {showEditModal && editingDoc && (
        <EditDocumentModal
          document={editingDoc}
          onClose={() => {
            setShowEditModal(false);
            setEditingDoc(null);
          }}
          onConfirm={handleEditDocument}
        />
      )}

      {deleteConfirm?.show && (
        <div className="knowledge-base-panel__confirm-backdrop" onClick={cancelDelete}>
          <div className="knowledge-base-panel__confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="knowledge-base-panel__confirm-icon">
              <AlertTriangle size={32} />
            </div>
            <h3 className="knowledge-base-panel__confirm-title">确认删除</h3>
            <p className="knowledge-base-panel__confirm-message">
              确定要删除文档 "{deleteConfirm.docTitle}" 吗？此操作无法撤销。
            </p>
            <div className="knowledge-base-panel__confirm-actions">
              <button
                className="knowledge-base-panel__confirm-btn knowledge-base-panel__confirm-btn--cancel"
                onClick={cancelDelete}
              >
                取消
              </button>
              <button
                className="knowledge-base-panel__confirm-btn knowledge-base-panel__confirm-btn--danger"
                onClick={confirmDelete}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default KnowledgeBasePanel;
