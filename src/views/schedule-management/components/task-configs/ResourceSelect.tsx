import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, Search, Loader2, FolderOpen, FileText, ChevronRight } from 'lucide-react';
import type { DolphinSchedulerApi } from '../../../../types/dolphinscheduler';
import './ResourceSelect.css';

interface ResourceSelectProps {
  value: string;
  onChange: (value: string) => void;
  api: DolphinSchedulerApi;
  resourceType?: string;
  placeholder?: string;
  label?: string;
}

interface ResourceNode {
  id?: number;
  name: string;
  currentDir: string;
  fullName: string;
  description: string | null;
  type: string;
  children: ResourceNode[];
  directory: boolean;
}

export function ResourceSelect({
  value,
  onChange,
  api,
  resourceType = 'FILE',
  placeholder = '请选择主程序包',
  label = '主程序包',
}: ResourceSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [resources, setResources] = useState<ResourceNode[]>([]);
  const [baseDir, setBaseDir] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      loadBaseDirAndResources();
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // 挂载时若已传入回显值，预加载资源中心目录，确保主Jar包能正确显示选中项
  // （否则 resources 为空、下拉未打开时 selectedResource 匹配不到，会显示成占位符）
  useEffect(() => {
    if (value) {
      loadBaseDirAndResources();
    }
    // 仅在初始挂载执行一次，回显依赖初始 value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadBaseDirAndResources = async () => {
    try {
      setLoading(true);
      setError(null);

      const [baseDirResponse, listResponse] = await Promise.all([
        api.resource.queryBaseDir(resourceType),
        api.resource.list(resourceType),
      ]);

      if (baseDirResponse.code === 0 && baseDirResponse.data) {
        setBaseDir(baseDirResponse.data.replace(/\/+$/, ''));
      }

      if (listResponse.code === 0 && Array.isArray(listResponse.data)) {
        const resourceNodes: ResourceNode[] = listResponse.data.map(item => ({
          ...item,
          currentDir: item.fullName.substring(0, item.fullName.lastIndexOf('/')) || '/',
          children: (item as any).children || [],
        }));
        setResources(resourceNodes);
        const rootPaths = resourceNodes
          .filter(r => r.directory)
          .map(r => getRelativePath(r.fullName));
        setExpandedNodes(new Set(rootPaths));
      } else {
        setError(listResponse.msg || '获取资源列表失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const getRelativePath = (fullPath: string): string => {
    if (!baseDir) return fullPath;
    const relativePath = fullPath.replace(baseDir, '').replace(/^\/+/, '');
    return relativePath || '/';
  };

  const toggleNode = (relativePath: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(relativePath)) {
        next.delete(relativePath);
      } else {
        next.add(relativePath);
      }
      return next;
    });
  };

  const flattenNodes = (nodes: ResourceNode[], result: ResourceNode[] = []): ResourceNode[] => {
    nodes.forEach(node => {
      if (!node.directory) {
        result.push(node);
      }
      if (node.children && node.children.length > 0) {
        flattenNodes(node.children, result);
      }
    });
    return result;
  };

  const filteredFlatResources = flattenNodes(resources).filter(resource =>
    resource.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    getRelativePath(resource.fullName).toLowerCase().includes(searchTerm.toLowerCase())
  );

  // 归一化路径：去掉 hdfs:// 协议头与首尾斜杠。mainJar 从 JSON 解析可能是对象（{resourceName}）或数字等，
  // 先做类型防御避免 (p||"").replace 抛错
  const normalizePath = (p: unknown): string => {
    const v = typeof p === 'string' ? p : '';
    return v.replace(/^[a-zA-Z]+:\/\/[^/]*/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  };

  // 从可能为对象（DS 3.x 的 mainJar 形如 {resourceName: "完整路径"}）的 value 中提取字符串
  const rawValue: string =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'resourceName' in value && typeof (value as any).resourceName === 'string'
        ? (value as any).resourceName
        : '';

  // 回显匹配：优先完整路径 fullName（与 mainJar.resourceName 一致），再按相对路径、纯文件名兜底。
  // 避免 DS 返回的 mainJar 带 baseDir 前缀/hdfs:///前导斜杠时匹配失败、显示成占位符
  const selectedResource = flattenNodes(resources).find(r => {
    const full = normalizePath(r.fullName);
    const rel = normalizePath(getRelativePath(r.fullName));
    const val = normalizePath(rawValue);
    return full === val || r.fullName === rawValue || rel === val || r.name === val || rel.endsWith('/' + val);
  });

  const renderTreeNode = (node: ResourceNode, level: number = 0): React.ReactNode => {
    const relativePath = getRelativePath(node.fullName);
    const isExpanded = expandedNodes.has(relativePath);
    const isSelected = rawValue === relativePath || rawValue === node.name;
    const hasChildren = node.directory && node.children && node.children.length > 0;

    return (
      <div key={node.id || node.fullName}>
        <div
          className={`tc-resource-select__tree-item ${isSelected ? 'tc-resource-select__tree-item--active' : ''} ${node.directory ? 'tc-resource-select__tree-item--directory' : ''}`}
          style={{ paddingLeft: `${level * 20 + 12}px` }}
          onClick={() => {
            if (node.directory) {
              toggleNode(relativePath);
            } else {
              onChange(relativePath);
              setIsOpen(false);
              setSearchTerm('');
            }
          }}
        >
          <span className={`tc-resource-select__tree-icon ${hasChildren ? 'tc-resource-select__tree-icon--expandable' : ''}`}>
            {node.directory ? (
              isExpanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )
            ) : (
              <FileText size={14} />
            )}
          </span>
          {node.directory ? (
            <FolderOpen size={14} className="tc-resource-select__tree-folder" />
          ) : null}
          <span className="tc-resource-select__tree-name">{node.name}</span>
        </div>

        {node.directory && isExpanded && hasChildren && (
          <div className="tc-resource-select__tree-children">
            {node.children!.map(child => renderTreeNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="tc-resource-select" ref={containerRef}>
      <label>{label}<span className="sm-required">*</span></label>
      <div className="tc-resource-select__trigger" onClick={() => setIsOpen(!isOpen)}>
        <div className="tc-resource-select__value">
          {selectedResource ? (
            <span className="tc-resource-select__selected">
              <FileText size={14} />
              {rawValue}
            </span>
          ) : (
            <span className="tc-resource-select__placeholder">{placeholder}</span>
          )}
        </div>
        <ChevronDown size={16} className={`tc-resource-select__icon ${isOpen ? 'tc-resource-select__icon--open' : ''}`} />
      </div>

      {isOpen && (
        <div className="tc-resource-select__dropdown">
          <div className="tc-resource-select__search">
            <Search size={14} />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索文件..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>

          {loading && (
            <div className="tc-resource-select__loading">
              <Loader2 size={20} className="tc-resource-select__spinner" />
              <span>加载中...</span>
            </div>
          )}

          {error && (
            <div className="tc-resource-select__error">{error}</div>
          )}

          {!loading && !error && searchTerm && filteredFlatResources.length === 0 && (
            <div className="tc-resource-select__empty">未找到匹配的文件</div>
          )}

          {!loading && !error && !searchTerm && resources.length === 0 && (
            <div className="tc-resource-select__empty">暂无可用资源文件</div>
          )}

          {!loading && !error && searchTerm && filteredFlatResources.length > 0 && (
            <div className="tc-resource-select__list">
              {filteredFlatResources.map(resource => (
                <div
                  key={resource.id || resource.fullName}
                  className={`tc-resource-select__item ${rawValue === getRelativePath(resource.fullName) || rawValue === resource.name ? 'tc-resource-select__item--active' : ''}`}
                  onClick={() => {
                    onChange(getRelativePath(resource.fullName));
                    setIsOpen(false);
                    setSearchTerm('');
                  }}
                >
                  <FileText size={14} />
                  <div className="tc-resource-select__item-info">
                    <span className="tc-resource-select__item-name">{resource.name}</span>
                    <span className="tc-resource-select__item-path">{getRelativePath(resource.fullName)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && !error && !searchTerm && resources.length > 0 && (
            <div className="tc-resource-select__tree">
              {resources.map(node => renderTreeNode(node))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
