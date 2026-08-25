// jsdom 缺失的 API 兼容垫片，使 monaco-editor 能在测试环境加载
if (typeof document !== 'undefined') {
  if (!document.queryCommandSupported) {
    (document as any).queryCommandSupported = () => false;
  }
  if (!document.execCommand) {
    (document as any).execCommand = () => false;
  }
}
if (typeof navigator !== 'undefined') {
  if (!navigator.clipboard) {
    (navigator as any).clipboard = {
      writeText: async () => {},
      readText: async () => '',
    };
  }
}
if (typeof globalThis !== 'undefined') {
  const g = globalThis as any;
  if (!g.CSS || !g.CSS.escape) {
    g.CSS = g.CSS || {};
    g.CSS.escape = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => '\\' + c);
  }
}
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    (window as any).matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
  }
}
