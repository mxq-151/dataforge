import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Search, X, File, FileText, Loader2 } from 'lucide-react';
import type { FileNode } from '../../types';
import './GlobalSearch.css';

interface SearchResult {
  path: string;
  name: string;
  type: 'file' | 'folder';
  matches?: MatchRange[];
}

interface MatchRange {
  line: number;
  text: string;
}

interface GlobalSearchProps {
  fileTree: FileNode[];
  readFileContent: (path: string) => Promise<string>;
  onFileOpen?: (filePath: string) => void;
}

/** 递归收集所有文件节点 */
function collectAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = [];
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === 'file') {
        files.push(node);
      } else if (node.children) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return files;
}

/** 简单的模糊匹配（大小写不敏感） */
function fuzzyMatch(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

export default function GlobalSearch({ fileTree, readFileContent, onFileOpen }: GlobalSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'name' | 'content'>('name');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 预先收集所有文件
  const allFiles = useMemo(() => collectAllFiles(fileTree), [fileTree]);

  // 打开时自动聚焦输入框
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // 文件名搜索
  const searchByName = useCallback((q: string): SearchResult[] => {
    if (!q.trim()) return [];
    return allFiles
      .filter(f => fuzzyMatch(f.name, q) || fuzzyMatch(f.path, q))
      .map(f => ({ path: f.path, name: f.name, type: f.type }));
  }, [allFiles]);

  // 文件内容搜索（带防抖）
  useEffect(() => {
    if (!open || !query.trim() || mode !== 'content') return;

    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        // 文件内容模式：遍历所有文件读取内容搜索（不做文件名预过滤）
        const candidates = allFiles;

        const contentResults: SearchResult[] = [];
        const qLower = query.toLowerCase();

        // 分批读取，避免一次性读取过多文件
        const batchSize = 20;
        for (let i = 0; i < candidates.length; i += batchSize) {
          const batch = candidates.slice(i, i + batchSize);
          const results = await Promise.allSettled(
            batch.map(async (f) => {
              const content = await readFileContent(f.path);
              if (!content) return null;
              const lines = content.split('\n');
              const matches: MatchRange[] = [];
              lines.forEach((line, idx) => {
                if (line.toLowerCase().includes(qLower)) {
                  matches.push({ line: idx + 1, text: line.trim().slice(0, 80) });
                }
              });
              return matches.length > 0 ? { path: f.path, name: f.name, type: f.type as 'file', matches } : null;
            })
          );
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
              contentResults.push(r.value);
            }
          }
        }

        setResults(contentResults.slice(0, 100)); // 限制最多100条结果
      } finally {
        setSearching(false);
      }
    }, 300); // 300ms 防抖

    return () => clearTimeout(timer);
  }, [query, mode, open, allFiles, readFileContent]);

  // 切换模式或清空查询时重新搜索
  useEffect(() => {
    if (mode === 'name' && query.trim()) {
      setResults(searchByName(query));
    } else if (mode === 'name' && !query.trim()) {
      setResults([]);
    }
  }, [query, mode, searchByName]);

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleClose();
  }, [handleClose]);

  const handleResultClick = useCallback((result: SearchResult) => {
    onFileOpen?.(result.path);
    handleClose();
  }, [onFileOpen, handleClose]);

  return (
    <>
      {/* 搜索入口按钮 */}
      <button
        className="global-search__trigger"
        onClick={handleOpen}
        title="全局搜索 (Ctrl+Shift+F)"
      >
        <Search size={15} />
      </button>

      {/* 搜索覆盖层 */}
      {open && (
        <div className="global-search__overlay" onClick={handleClose}>
          <div className="global-search__panel" onClick={e => e.stopPropagation()}>
            {/* 搜索栏 */}
            <div className="global-search__input-row">
              <Search size={16} className="global-search__input-icon" />
              <input
                ref={inputRef}
                className="global-search__input"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  mode === 'name'
                    ? '搜索文件名...'
                    : '搜索文件内容...'
                }
              />
              <button className="global-search__close-btn" onClick={handleClose} title="关闭">
                <X size={16} />
              </button>
            </div>

            {/* 模式切换 */}
            <div className="global-search__modes">
              <button
                className={`global-search__mode ${mode === 'name' ? 'global-search__mode--active' : ''}`}
                onClick={() => { setMode('name'); setResults([]); }}
              >
                文件名
              </button>
              <button
                className={`global-search__mode ${mode === 'content' ? 'global-search__mode--active' : ''}`}
                onClick={() => { setMode('content'); setResults([]); }}
              >
                文件内容
              </button>
            </div>

            {/* 结果列表 */}
            <div className="global-search__results">
              {searching && (
                <div className="global-search__status">
                  <Loader2 size={14} className="global-search__spin" /> 搜索中...
                </div>
              )}
              {!searching && query.trim() && results.length === 0 && (
                <div className="global-search__status">未找到匹配的结果</div>
              )}
              {!query.trim() && (
                <div className="global-search__status">输入关键词开始搜索</div>
              )}
              {results.map((r, idx) => (
                <div
                  key={`${r.path}-${idx}`}
                  className="global-search__result-item"
                  onClick={() => handleResultClick(r)}
                >
                  <div className="global-search__result-header">
                    {r.type === 'file' ? <File size={13} /> : <FileText size={13} />}
                    <span className="global-search__result-name">{r.name}</span>
                    <span className="global-search__result-path">{r.path}</span>
                  </div>
                  {mode === 'content' && r.matches && r.matches.length > 0 && (
                    <div className="global-search__matches">
                      {r.matches.slice(0, 3).map((m, mi) => (
                        <div key={mi} className="global-search__match-line">
                          <span className="global-search__match-line-num">{m.line}</span>
                          <span className="global-search__match-text">{m.text}</span>
                        </div>
                      ))}
                      {r.matches.length > 3 && (
                        <div className="global-search__match-more">
                          还有 {r.matches.length - 3} 处匹配...
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* 底部提示 */}
            <div className="global-search__footer">
              ESC 关闭 &nbsp;|&nbsp; 点击结果打开文件
            </div>
          </div>
        </div>
      )}
    </>
  );
}
