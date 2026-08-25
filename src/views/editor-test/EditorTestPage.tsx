import { useCallback, useEffect, useRef, useState } from 'react';
import EditorArea from '../../components/editor/EditorArea';
import type { StatusBarInfo, Tab } from '../../types';
import { generateId } from '../../utils';
import { initFileSystemAPI } from '../../hooks/useFileSystem';
import './EditorTestPage.css';

/** 默认打开的测试文件 */
const DEFAULT_FILE_PATH = '/Users/mxq/.dataforge/localhost_8082/admin/warehouse/test_project/procs/ads/ads_ad_campaign_report_calc_f.scala';

/** 从文件名推导默认语言，作为 statusInfo / 编辑器语言兜底 */
const getTabLanguage = (name: string): string => {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'java') return 'java';
  if (ext === 'scala') return 'scala';
  if (ext === 'sql') return 'sql';
  if (ext === 'py') return 'python';
  if (ext === 'md') return 'markdown';
  return 'javascript';
};

const getBaseName = (filePath: string): string => {
  return filePath.split(/[/\\]/).pop() || filePath;
};

/** 判断当前是否运行在 Tauri 内（有真实文件系统） */
const isTauriEnv = (): boolean => {
  return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
};

/**
 * 读取本地文件内容。
 * - Tauri 环境：走 plugin-fs（真实磁盘）。
 * - 纯浏览器（无 Tauri）：initFileSystemAPI 会退化为 localStorage 虚拟文件系统，读不到
 *   磁盘文件，改为通过 Vite dev server 的 /__testfile__/ 中间件读取（见 vite.config.ts）。
 */
const readLocalFile = async (filePath: string): Promise<{ ok: boolean; content?: string; error?: string }> => {
  if (isTauriEnv()) {
    try {
      const api = await initFileSystemAPI();
      const data = await api.readFile(filePath);
      return { ok: true, content: new TextDecoder().decode(data) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    const resp = await fetch('/__testfile__/?path=' + encodeURIComponent(filePath));
    if (!resp.ok) {
      const text = (await resp.text()).slice(0, 200);
      return { ok: false, error: `HTTP ${resp.status}: ${text}` };
    }
    return { ok: true, content: await resp.text() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * 编辑器模块测试页：无需登录即可访问（App.tsx 根据 URL 参数或应用内入口路由到本页）。
 * 用于单独调试 src/components/editor 下的 EditorArea / TabBar 等组件，
 * 默认打开指定测试文件。
 */
const EditorTestPage: React.FC<{ onExit?: () => void }> = ({ onExit }) => {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState<Record<string, string>>({});
  const [pathInput, setPathInput] = useState<string>(DEFAULT_FILE_PATH);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadingRef = useRef<Set<string>>(new Set());

  const openFile = useCallback(async (filePath: string): Promise<void> => {
    if (!filePath.trim()) return;
    const normalized = filePath.trim();
    setLoadError(null);

    const existing = tabs.find(t => t.path === normalized);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const newTab: Tab = {
      id: generateId().toString(),
      name: getBaseName(normalized),
      path: normalized,
      isModified: false,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);

    if (loadingRef.current.has(newTab.id)) return;
    loadingRef.current.add(newTab.id);
    try {
      const { ok, content, error } = await readLocalFile(normalized);
      if (!ok) throw new Error(error || '未知错误');
      setEditorContent(prev => ({ ...prev, [newTab.id]: content || '' }));
    } catch (err) {
      console.error('[EditorTestPage] 读取文件失败:', err);
      setEditorContent(prev => ({ ...prev, [newTab.id]: '' }));
      setLoadError(`读取文件失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      loadingRef.current.delete(newTab.id);
    }
  }, [tabs]);

  // 默认打开测试文件
  useEffect(() => {
    openFile(DEFAULT_FILE_PATH);
    // 仅挂载时打开一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTabClose = useCallback((id: string) => {
    setTabs(prev => {
      const target = prev.find(t => t.id === id);
      if (target) setEditorContent(prevC => { const next = { ...prevC }; delete next[id]; return next; });
      return prev.filter(t => t.id !== id);
    });
    setActiveTabId(prev => (prev === id ? null : prev));
  }, []);

  const handleChange = useCallback((value: string, tabId: string | null) => {
    if (!tabId) return;
    setEditorContent(prev => ({ ...prev, [tabId]: value }));
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, isModified: true } : t));
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId);
  const language = activeTab ? getTabLanguage(activeTab.name) : 'javascript';

  const statusInfo: StatusBarInfo = {
    line: 1,
    column: 1,
    encoding: 'UTF-8',
    spaces: 2,
    eol: '\n',
  };

  return (
    <div className="editor-test-page">
      <div className="editor-test-page__toolbar">
        <span className="editor-test-page__title">编辑器测试页</span>
        <input
          className="editor-test-page__path"
          value={pathInput}
          onChange={e => setPathInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') openFile(pathInput); }}
          placeholder="输入文件绝对路径后回车 / 点击打开"
          spellCheck={false}
        />
        <button className="editor-test-page__open" onClick={() => openFile(pathInput)}>打开</button>
        {onExit && (
          <button className="editor-test-page__exit" onClick={onExit}>返回</button>
        )}
      </div>
      {loadError && <div className="editor-test-page__error">{loadError}</div>}
      <EditorArea
        tabs={tabs}
        activeTabId={activeTabId}
        onTabSelect={setActiveTabId}
        onTabClose={handleTabClose}
        value={activeTabId ? editorContent[activeTabId] || '' : ''}
        onChange={handleChange}
        statusInfo={statusInfo}
        language={language}
      />
    </div>
  );
};

export default EditorTestPage;
