import { useState, useCallback, useEffect, useRef } from 'react';
import { FileNode } from '../types';
import { generateId, generateFileHeader } from '../utils';
import { notifyWatchedFilesChanges, WatchChangeType, pathToUri } from '../services/lsp';
import { getBaseName, getDirName, isPathUnder, joinPath, toRelativePath } from '../utils/pathUtils';
import { TRASH_DIR_NAME, formatTrashStamp, uniqueTrashName } from '../utils/rollbackSafety';
import { ensureTrashIgnored } from '../utils/workspaceTrash';

// 纯函数实现已迁至 utils/workspacePath，此处 re-export 保持既有引用可用
export { getPlatformDefaultWorkspace } from '../utils/workspacePath';
import { getPlatformDefaultWorkspace, DEFAULT_WORKSPACE } from '../utils/workspacePath';

interface FileSystemAPI {
  readDir: (path: string) => Promise<any[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  createDir: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  removeFile: (path: string) => Promise<void>;
  removeDir: (path: string) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  copy: (src: string, dest: string) => Promise<void>;
}

let fsAPI: FileSystemAPI | null = null;

export const initFileSystemAPI = async (): Promise<FileSystemAPI> => {

  if (fsAPI) {
    return fsAPI;
  }

  try {
    const fsModule = await import('../bridge/fs');

    try {
      const workspacePath = await getPlatformDefaultWorkspace();
      await fsModule.mkdir(workspacePath, { recursive: true });
    } catch (e) {
      console.warn(`⚠️ [FS] 工作区目录创建失败（可能已存在）:`, e);
    }

    fsAPI = {
      readDir: async (path: string) => {
        try {
          const entries = await fsModule.readDir(path);
          return entries.map(entry => ({
            name: entry.name,
            isDirectory: entry.isDirectory,
            isFile: entry.isFile,
          }));
        } catch (error) {
          console.error(`❌ [FS] 读取目录失败 ${path}:`, error);
          return [];
        }
      },

      readFile: async (path: string) => {
        try {
          const content = await fsModule.readFile(path);
          return content;
        } catch (error) {
          console.error(`❌ [FS] 读取文件失败 ${path}:`, error);
          return new Uint8Array(0);
        }
      },

      writeFile: async (path: string, data: Uint8Array) => {
        await fsModule.writeFile(path, data);
        console.log(`✅ [FS] 文件写入成功: ${path}`);
      },

      createDir: async (path: string) => {
        await fsModule.mkdir(path, { recursive: true });
        console.log(`✅ [FS] 目录创建成功: ${path}`);
      },

      exists: async (path: string) => {
        try {
          return await fsModule.exists(path);
        } catch {
          return false;
        }
      },

      removeFile: async (path: string) => {
        await fsModule.remove(path);
      },

      removeDir: async (path: string) => {
        await fsModule.remove(path, { recursive: true });
      },

      rename: async (oldPath: string, newPath: string) => {
        await fsModule.rename(oldPath, newPath);
      },

      copy: async (src: string, dest: string) => {
        await fsModule.copy(src, dest);
      },
    };

    return fsAPI;
  } catch (error) {
    console.error('❌ [FS] 初始化文件系统桥失败，回退到 Web FS:', error);
    return createWebFSAPI();
  }
};

function createWebFSAPI(): FileSystemAPI {
  const storageKey = 'dataforge_fs';

  let fileSystemData: Record<string, { type: 'file' | 'folder'; content?: string; children?: string[] }> = {};

  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      fileSystemData = JSON.parse(stored);
    }
  } catch (e) {
    console.error('❌ [FS] 读取本地存储失败:', e);
  }

  const saveToStorage = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(fileSystemData));
    } catch (e) {
      console.error('❌ [FS] 保存到本地存储失败:', e);
    }
  };

  const ensureWorkspaceExists = () => {
    if (!fileSystemData[DEFAULT_WORKSPACE]) {
      fileSystemData[DEFAULT_WORKSPACE] = { type: 'folder', children: [] };

      const defaultFiles = [
        { path: `${DEFAULT_WORKSPACE}/src`, type: 'folder' as const },
        { path: `${DEFAULT_WORKSPACE}/src/components`, type: 'folder' as const },
        { path: `${DEFAULT_WORKSPACE}/src/components/App.tsx`,
          type: 'file' as const,
          content: `import React from 'react';\n\nconst App: React.FC = () => {\n  return (\n    <div className=\"app\">\n      <h1>Hello World</h1>\n    </div>\n  );\n};\n\nexport default App;\n` },
        { path: `${DEFAULT_WORKSPACE}/src/index.tsx`,
          type: 'file' as const,
          content: `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './components/App';\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);\n` },
        { path: `${DEFAULT_WORKSPACE}/package.json`,
          type: 'file' as const,
          content: `{\n  "name": "my-project",\n  "version": "1.0.0",\n  "scripts": {\n    "dev": "vite",\n    "build": "tsc && vite build"\n  }\n}\n` },
        { path: `${DEFAULT_WORKSPACE}/README.md`,
          type: 'file' as const,
          content: `# My Project\n\nWelcome to my project!\n` },
      ];

      defaultFiles.forEach(file => {
        if (file.type === 'folder') {
          fileSystemData[file.path] = { type: 'folder', children: [] };

          const parentPath = file.path.substring(0, file.path.lastIndexOf('/'));
          if (parentPath && fileSystemData[parentPath]) {
            if (!fileSystemData[parentPath].children) {
              fileSystemData[parentPath].children = [];
            }
            fileSystemData[parentPath].children!.push(file.path);
          }
        } else {
          fileSystemData[file.path] = { type: 'file', content: file.content };

          const parentPath = file.path.substring(0, file.path.lastIndexOf('/'));
          if (parentPath && fileSystemData[parentPath]) {
            if (!fileSystemData[parentPath].children) {
              fileSystemData[parentPath].children = [];
            }
            fileSystemData[parentPath].children!.push(file.path);
          }
        }
      });

      saveToStorage();
    } else {
      console.log(`ℹ️ [FS] 工作区已存在: ${DEFAULT_WORKSPACE}`);
    }
  };

  ensureWorkspaceExists();

  return {
    readDir: async (path: string): Promise<any[]> => {
      const dir = fileSystemData[path];
      if (!dir || dir.type !== 'folder') {
        throw new Error(`目录不存在: ${path}`);
      }

      const children = dir.children || [];
      return children.map(childPath => ({
        name: childPath.split(/[/\\]/).pop(),
        isDirectory: fileSystemData[childPath]?.type === 'folder',
        isFile: fileSystemData[childPath]?.type === 'file',
        children: fileSystemData[childPath]?.children,
      }));
    },

    readFile: async (path: string): Promise<Uint8Array> => {
      const file = fileSystemData[path];
      if (!file || file.type !== 'file') {
        throw new Error(`文件不存在: ${path}`);
      }

      const encoder = new TextEncoder();
      return encoder.encode(file.content || '');
    },

    writeFile: async (path: string, data: Uint8Array): Promise<void> => {
      const decoder = new TextDecoder();
      const content = decoder.decode(data);

      const isNewFile = !fileSystemData[path];

      fileSystemData[path] = { type: 'file', content };

      if (isNewFile) {
        const parentPath = path.substring(0, path.lastIndexOf(/[/\\]/.test(path) ? path.match(/[/\\]/)![0] : '/'));
        if (parentPath && fileSystemData[parentPath]) {
          if (!fileSystemData[parentPath].children) {
            fileSystemData[parentPath].children = [];
          }
          fileSystemData[parentPath].children!.push(path);
        }
      }

      saveToStorage();
    },

    createDir: async (path: string): Promise<void> => {
      fileSystemData[path] = { type: 'folder', children: [] };

      const parentPath = path.substring(0, path.lastIndexOf(/[/\\]/.test(path) ? path.match(/[/\\]/)![0] : '/'));
      if (parentPath && fileSystemData[parentPath]) {
        if (!fileSystemData[parentPath].children) {
          fileSystemData[parentPath].children = [];
        }
        fileSystemData[parentPath].children!.push(path);
      }

      saveToStorage();
    },

    exists: async (path: string): Promise<boolean> => {
      return !!fileSystemData[path];
    },

    removeFile: async (path: string): Promise<void> => {
      if (!fileSystemData[path] || fileSystemData[path].type !== 'file') {
        throw new Error(`文件不存在: ${path}`);
      }
      delete fileSystemData[path];
      const parentPath = path.substring(0, path.lastIndexOf(/[/\\]/.test(path) ? path.match(/[/\\]/)![0] : '/'));
      if (parentPath && fileSystemData[parentPath]) {
        fileSystemData[parentPath].children = (fileSystemData[parentPath].children || []).filter(c => c !== path);
      }
      saveToStorage();
    },

    removeDir: async (path: string): Promise<void> => {
      if (!fileSystemData[path] || fileSystemData[path].type !== 'folder') {
        throw new Error(`目录不存在: ${path}`);
      }
      const removeRecursive = (dirPath: string) => {
        const dir = fileSystemData[dirPath];
        if (dir && dir.children) {
          for (const childPath of dir.children) {
            if (fileSystemData[childPath]?.type === 'folder') {
              removeRecursive(childPath);
            }
            delete fileSystemData[childPath];
          }
        }
        delete fileSystemData[dirPath];
      };
      removeRecursive(path);
      const parentPath = path.substring(0, path.lastIndexOf(/[/\\]/.test(path) ? path.match(/[/\\]/)![0] : '/'));
      if (parentPath && fileSystemData[parentPath]) {
        fileSystemData[parentPath].children = (fileSystemData[parentPath].children || []).filter(c => c !== path);
      }
      saveToStorage();
    },

    rename: async (oldPath: string, newPath: string): Promise<void> => {
      if (!fileSystemData[oldPath]) {
        throw new Error(`文件或目录不存在: ${oldPath}`);
      }

      // 复制数据到新路径
      fileSystemData[newPath] = { ...fileSystemData[oldPath] };

      // 如果是文件夹，递归更新所有子路径
      const updateChildPaths = (oldBase: string, newBase: string) => {
        const entry = fileSystemData[oldBase];
        if (entry?.type === 'folder' && entry.children) {
          const newChildren: string[] = [];
          for (const childPath of entry.children) {
            const newChildPath = childPath.replace(oldBase, newBase);
            newChildren.push(newChildPath);
            fileSystemData[newChildPath] = fileSystemData[childPath];
            delete fileSystemData[childPath];
            // 递归处理嵌套文件夹
            if (fileSystemData[newChildPath]?.type === 'folder') {
              updateChildPaths(childPath, newChildPath);
            }
          }
          fileSystemData[newBase].children = newChildren;
        }
      };

      updateChildPaths(oldPath, newPath);

      // 删除旧路径数据
      delete fileSystemData[oldPath];

      // 更新父目录的 children 引用
      const parentPath = oldPath.substring(0, oldPath.lastIndexOf(/[/\\]/.test(oldPath) ? oldPath.match(/[/\\]/)![0] : '/'));
      if (parentPath && fileSystemData[parentPath]) {
        fileSystemData[parentPath].children = (fileSystemData[parentPath].children || []).map(c => c === oldPath ? newPath : c);
      }

      saveToStorage();
    },

    copy: async (src: string, dest: string): Promise<void> => {
      if (!fileSystemData[src]) {
        throw new Error(`文件或目录不存在: ${src}`);
      }

      // 复制（保留源不变）：
      const copyInto = (from: string, to: string) => {
        fileSystemData[to] = { ...fileSystemData[from] };
        const entry = fileSystemData[from];
        if (entry?.type === 'folder' && entry.children) {
          const newChildren: string[] = [];
          for (const childPath of entry.children) {
            const newChildPath = childPath.replace(from, to);
            newChildren.push(newChildPath);
            copyInto(childPath, newChildPath);
          }
          fileSystemData[to].children = newChildren;
        }
      };
      copyInto(src, dest);

      // 在父目录中登记（若父目录是已知 folder 且未包含该子路径）
      const parentPath = dest.substring(0, dest.lastIndexOf(/[/\\]/.test(dest) ? dest.match(/[/\\]/)![0] : '/'));
      if (parentPath && fileSystemData[parentPath]?.type === 'folder') {
        const children = fileSystemData[parentPath].children || [];
        if (!children.includes(dest)) {
          fileSystemData[parentPath].children = [...children, dest];
        }
      }

      saveToStorage();
    },
  };
}
const useFileSystem = (initialPath?: string) => {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [apiReady, setApiReady] = useState(false);

  // 目录请求序号：openFolder / openDefaultFolder 均为异步流程，可能因 initialPath 异步就绪而
  // 并发执行（如先触发的 openDefaultFolder 与后触发的 openFolder 交错完成）。只有「最新一次」
  // 请求才允许最终提交 rootPath/fileTree，否则旧请求会把新设的正确路径覆盖回默认工作区
  // （表现为换用户后文件浏览器仍停留在 ~/.dataforge，需手动刷新）。
  const latestDirSeqRef = useRef(0);

  useEffect(() => {
    console.log(`[FS][debug] useFileSystem effect fired, initialPath=`, initialPath);
    initializeFileSystem();
    // initialPath 由父级异步计算（如 baseWorkspace 需等登录后异步加载，projectCwd 才可得）。
    // 首次挂载时 initialPath 可能为 undefined，此时会误开默认工作区（~/.dataforge）且不随用户/
    // 项目自动纠正。将 initialPath 加入依赖，一旦其变为有效目录立即重新初始化，确保文件浏览器
    // 根目录始终指向正确的项目根 src/{pc}，避免换用户登录后仍停留在上一个会话的默认目录。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  const initializeFileSystem = async () => {
    console.log(`[FS][debug] initializeFileSystem start, initialPath=`, initialPath, 'current rootPath=', rootPath);
    try {
      setIsLoading(true);
      await initFileSystemAPI();
      if (initialPath) {
        await openFolder(initialPath);
      } else {
        await openDefaultFolder();
      }
      setApiReady(true);
    } catch (error) {
      console.error('❌ [useFileSystem] 初始化文件系统失败:', error);
    } finally {
      setIsLoading(false);
    }
    console.log(`[FS][debug] initializeFileSystem done, initialPath=`, initialPath, 'rootPath=', rootPath);
  };

  const buildFileTree = useCallback(async (dirPath: string, api: FileSystemAPI): Promise<FileNode[]> => {
    try {
      const entries = await api.readDir(dirPath);
      const nodes: FileNode[] = [];

      for (const entry of entries) {
        if (!entry.name?.startsWith('.')) {
          const nodePath = `${dirPath}${dirPath.endsWith('/') || dirPath.endsWith('\\') ? '' : '/'}${entry.name}`;
          const node: FileNode = {
            id: generateId().toString(),
            name: entry.name,
            type: entry.isDirectory ? 'folder' : 'file',
            path: nodePath,
          };

          if (entry.isDirectory) {
            node.children = await buildFileTree(nodePath, api);
          }

          nodes.push(node);
        }
      }
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      console.error(`❌ [buildFileTree] 构建文件树失败 ${dirPath}:`, error);
      return [];
    }
  }, []);

  const openDefaultFolder = useCallback(async () => {
    console.log(`[FS][debug] openDefaultFolder called, target=getPlatformDefaultWorkspace`);
    const seq = ++latestDirSeqRef.current;
    try {
      setIsLoading(true);
      const api = await initFileSystemAPI();
      const workspacePath = await getPlatformDefaultWorkspace();
      // 期间若已有更新的目录请求（如 initialPath 变为正确路径触发的 openFolder），放弃提交，
      // 避免把刚设好的正确根目录覆盖回默认工作区。
      if (seq !== latestDirSeqRef.current) {
        console.log(`[FS][debug] openDefaultFolder superseded (seq=${seq}), skip setRootPath`);
        return;
      }
      setRootPath(workspacePath);
      const tree = await buildFileTree(workspacePath, api);
      if (seq === latestDirSeqRef.current) {
        setFileTree(tree);
      }
      console.log(`[FS][debug] openDefaultFolder done, rootPath=`, workspacePath, 'fileCount=', tree.length);
    } catch (error) {
      console.error('❌ [openDefaultFolder] 打开默认文件夹失败:', error);
    } finally {
      setIsLoading(false);
    }
  }, [buildFileTree]);

  const openFolder = useCallback(async (customPath?: string) => {
    console.log(`[FS][debug] openFolder called, customPath=`, customPath);
    const seq = ++latestDirSeqRef.current;
    try {
      setIsLoading(true);
      const api = await initFileSystemAPI();
      const defaultPath = await getPlatformDefaultWorkspace();
      const targetPath = customPath || defaultPath;

      setRootPath(targetPath);
      const tree = await buildFileTree(targetPath, api);
      // 仅最新一次请求可以写入文件树
      if (seq === latestDirSeqRef.current) {
        setFileTree(tree);
      }
      console.log(`[FS][debug] openFolder done, targetPath=`, targetPath, 'fileCount=', tree.length);
    } catch (error) {
      console.error('打开文件夹失败:', error);
    } finally {
      setIsLoading(false);
    }
  }, [buildFileTree]);

  const readFileContent = useCallback(async (filePath: string): Promise<string> => {
    try {
      const api = await initFileSystemAPI();
      const content = await api.readFile(filePath);
      return new TextDecoder().decode(content);
    } catch (error) {
      console.error('读取文件内容失败:', error);
      return '';
    }
  }, []);

  const readFile = useCallback(async (filePath: string): Promise<Uint8Array> => {
    try {
      const api = await initFileSystemAPI();
      return await api.readFile(filePath);
    } catch (error) {
      console.error('读取文件失败:', error);
      return new Uint8Array(0);
    }
  }, []);

  const refreshTree = useCallback(async (): Promise<FileNode[]> => {
    if (!rootPath) return [];
    try {
      const api = await initFileSystemAPI();
      const tree = await buildFileTree(rootPath, api);
      setFileTree(tree);
      return tree;
    } catch (error) {
      console.error('刷新文件树失败:', error);
      return [];
    }
  }, [rootPath, buildFileTree]);

  const createFile = useCallback(async (
    parentPath: string,
    fileName: string,
    content?: string
  ): Promise<FileNode | null> => {
    if (!apiReady) {
      return null;
    }

    try {
      const api = await initFileSystemAPI();
      const newPath = `${parentPath}${parentPath.endsWith('/') || parentPath.endsWith('\\') ? '' : '/'}${fileName}`;

      const encoder = new TextEncoder();
      const defaultContent = content || generateFileHeader(newPath, rootPath || undefined) || `// ${fileName}\n// New file\n// Start coding here...\n`;
      const contentData = encoder.encode(defaultContent);

      await api.writeFile(newPath, contentData);

      // 通知 JDT.LS / Metals：新文件（含其父目录）已创建，及时收敛包/类结构，
      // 清除因工程模型陈旧导致的 "declared package does not match expected package" 诊断
      notifyWatchedFilesChanges([
        { uri: pathToUri(newPath), type: WatchChangeType.Created },
        { uri: pathToUri(parentPath), type: WatchChangeType.Created },
      ]);

      const newNode: FileNode = {
        id: generateId().toString(),
        name: fileName,
        type: 'file',
        path: newPath,
      };

      setFileTree(prev => addToTree(prev, parentPath, newNode));
      await refreshTree();

      return newNode;
    } catch (error) {
      console.error('创建文件失败:', error);
      return null;
    }
  }, [apiReady, rootPath, refreshTree]);

  const createFolder = useCallback(async (
    parentPath: string,
    folderName: string
  ): Promise<FileNode | null> => {
    if (!apiReady) {
      console.warn('⚠️ [createFolder] API 未就绪，跳过执行');
      return null;
    }

    try {
      const api = await initFileSystemAPI();
      const newPath = `${parentPath}${parentPath.endsWith('/') || parentPath.endsWith('\\') ? '' : '/'}${folderName}`;

      await api.createDir(newPath);

      // 通知 JDT.LS / Metals：新目录已创建（新包目录会改变 Java/Scala 的包结构）
      notifyWatchedFilesChanges([
        { uri: pathToUri(newPath), type: WatchChangeType.Created },
      ]);

      const newNode: FileNode = {
        id: generateId().toString(),
        name: folderName,
        type: 'folder',
        path: newPath,
        children: [],
      };

      setFileTree(prev => addToTree(prev, parentPath, newNode));
      await refreshTree();

      return newNode;
    } catch (error) {
      console.error('❌ [createFolder] 创建文件夹失败:', error);
      return null;
    }
  }, [apiReady, refreshTree]);

  const saveFile = useCallback(async (filePath: string, content: string): Promise<boolean> => {
    try {
      const api = await initFileSystemAPI();
      const encoder = new TextEncoder();
      await api.writeFile(filePath, encoder.encode(content));
      return true;
    } catch (error) {
      console.error('保存文件失败:', error);
      return false;
    }
  }, []);

  const deleteNode = useCallback(async (nodePath: string, nodeType: 'file' | 'folder'): Promise<boolean> => {
    if (!apiReady) {
      console.warn('⚠️ [deleteNode] API 未就绪，跳过执行');
      return false;
    }

    try {
      const api = await initFileSystemAPI();
      if (nodeType === 'file') {
        await api.removeFile(nodePath);
      } else {
        await api.removeDir(nodePath);
      }
      setFileTree(prev => removeFromTree(prev, nodePath));
      // 通知 JDT.LS / Metals：文件/目录已删除
      notifyWatchedFilesChanges([{ uri: pathToUri(nodePath), type: WatchChangeType.Deleted }]);
      await refreshTree();
      return true;
    } catch (error) {
      console.error('删除失败:', error);
      return false;
    }
  }, [apiReady, refreshTree]);

  /**
   * 把文件/目录移入工作区回收站，而不是直接删除。
   *
   * 事故背景（2026-09-13）：回滚功能用 fs.remove 直删磁盘文件，无备份、无日志，
   * 一次异常（空）快照就抹掉了 test_project 整个工作区（71 个已提交文件）。
   * 回收站把「删除」降级为「移动到 <root>/.dataforge-trash/<批次>/<原相对路径>」，
   * 误操作可原样移回，且批次目录本身就是一份可事后审计的现场记录。
   *
   * 目录名以 `.` 开头，buildFileTree 会跳过，因此不会出现在文件树里；
   * 同批次路径冲突由 uniqueTrashName 追加 `-1`/`-2` 解决。
   *
   * @param batch 批次目录名，同一批操作传入同一个值以便归拢；缺省按当前时间新建
   * @returns 移入回收站后的绝对路径；文件不存在或失败返回 null
   */
  const trashNode = useCallback(async (
    nodePath: string,
    nodeType: 'file' | 'folder',
    batch?: string
  ): Promise<string | null> => {
    if (!apiReady || !rootPath) {
      console.warn('⚠️ [trashNode] API 或 rootPath 未就绪，跳过执行');
      return null;
    }

    try {
      const api = await initFileSystemAPI();
      if (!(await api.exists(nodePath))) {
        return null;
      }

      // 先让回收站对 git 隐身，再落盘（否则 untracked 条目会污染 git status、让自动同步跳过）
      await ensureTrashIgnored(rootPath);
      const batchDir = joinPath(rootPath, TRASH_DIR_NAME, batch || formatTrashStamp());
      await api.createDir(batchDir);

      // 保留原相对路径（含子目录），便于人工辨认；不在 rootPath 下时退化为文件名
      const rel = isPathUnder(nodePath, rootPath)
        ? toRelativePath(nodePath, rootPath)
        : getBaseName(nodePath);

      const taken = new Set<string>();
      let candidate = uniqueTrashName(rel, taken);
      while (await api.exists(joinPath(batchDir, candidate))) {
        taken.add(candidate);
        candidate = uniqueTrashName(rel, taken);
      }

      const target = joinPath(batchDir, candidate);
      await api.createDir(getDirName(target));
      await api.rename(nodePath, target);

      setFileTree(prev => removeFromTree(prev, nodePath));
      // 通知 JDT.LS / Metals：文件/目录已从原位置消失
      notifyWatchedFilesChanges([{ uri: pathToUri(nodePath), type: WatchChangeType.Deleted }]);
      console.log(`🗑️ [trash] ${nodeType} ${nodePath} → ${target}`);
      return target;
    } catch (error) {
      console.error('移入回收站失败:', error);
      return null;
    }
  }, [apiReady, rootPath]);

  const renameNode = useCallback(async (
    oldPath: string,
    newName: string,
    _nodeType: 'file' | 'folder'
  ): Promise<boolean> => {
    if (!apiReady) {
      console.warn('⚠️ [renameNode] API 未就绪，跳过执行');
      return false;
    }

    if (!newName.trim()) {
      return false;
    }

    try {
      const api = await initFileSystemAPI();
      // 构建新路径：取旧路径的父目录 + 新名称
      const separator = oldPath.includes('/') ? '/' : '\\';
      const parentPath = oldPath.substring(0, oldPath.lastIndexOf(separator));
      const newPath = `${parentPath}${separator}${newName.trim()}`;

      await api.rename(oldPath, newPath);

      // 通知 JDT.LS / Metals：原路径删除 + 新路径创建（包/类归属可能随重命名变化）
      notifyWatchedFilesChanges([
        { uri: pathToUri(oldPath), type: WatchChangeType.Deleted },
        { uri: pathToUri(newPath), type: WatchChangeType.Created },
      ]);

      // 刷新文件树以反映重命名
      await refreshTree();
      return true;
    } catch (error) {
      console.error('重命名失败:', error);
      return false;
    }
  }, [apiReady, refreshTree]);

  const moveNode = useCallback(async (
    srcPath: string,
    targetDirPath: string,
    nodeType: 'file' | 'folder'
  ): Promise<boolean> => {
    if (!apiReady) {
      console.warn('⚠️ [moveNode] API 未就绪，跳过执行');
      return false;
    }

    if (!srcPath.trim() || !targetDirPath.trim()) {
      return false;
    }

    try {
      const api = await initFileSystemAPI();
      const srcName = srcPath.split(/[/\\]/).pop() || '';
      if (!srcName) return false;

      const separator = targetDirPath.includes('\\') ? '\\' : '/';
      const targetBase = targetDirPath.replace(/[\\/]+$/, '');
      const newPath = `${targetBase}${separator}${srcName}`;

      // 防御：目标位置与原路径相同，无需移动
      if (newPath === srcPath) return false;

      // 防御：文件夹不能移动到自身或其子目录内（避免循环）
      if (nodeType === 'folder') {
        const prefix = newPath.endsWith(separator) ? newPath : newPath + separator;
        if (srcPath === newPath || srcPath.startsWith(prefix)) return false;
      }

      await api.rename(srcPath, newPath);

      // 通知 JDT.LS / Metals：原路径删除 + 新路径创建（跨目录移动改变包归属）
      notifyWatchedFilesChanges([
        { uri: pathToUri(srcPath), type: WatchChangeType.Deleted },
        { uri: pathToUri(newPath), type: WatchChangeType.Created },
      ]);

      // 刷新文件树以反映移动
      await refreshTree();
      return true;
    } catch (error) {
      console.error('移动失败:', error);
      return false;
    }
  }, [apiReady, refreshTree]);

  const copyNode = useCallback(async (
    srcPath: string,
    targetDirPath: string,
    nodeType: 'file' | 'folder'
  ): Promise<boolean> => {
    if (!apiReady) {
      console.warn('⚠️ [copyNode] API 未就绪，跳过执行');
      return false;
    }

    if (!srcPath.trim() || !targetDirPath.trim()) {
      return false;
    }

    try {
      const api = await initFileSystemAPI();
      const srcName = srcPath.split(/[/\\]/).pop() || '';
      if (!srcName) return false;

      const separator = targetDirPath.includes('\\') ? '\\' : '/';
      const targetBase = targetDirPath.replace(/[\\/]+$/, '');

      // 防御：文件夹不能复制到自身或其子目录内（避免无限嵌套）
      if (nodeType === 'folder') {
        const tPrefix = targetBase.endsWith(separator) ? targetBase : targetBase + separator;
        if (targetBase === srcPath || srcPath.startsWith(tPrefix)) return false;
      }

      // 目标已存在同名时自动追加"副本"后缀，避免覆盖
      let destPath = `${targetBase}${separator}${srcName}`;
      let counter = 1;
      while (await api.exists(destPath)) {
        destPath = `${targetBase}${separator}${makeCopyName(srcName, counter)}`;
        counter++;
      }

      await api.copy(srcPath, destPath);

      // 通知 JDT.LS / Metals：复制产生了新文件/目录
      notifyWatchedFilesChanges([
        { uri: pathToUri(destPath), type: WatchChangeType.Created },
      ]);

      // 刷新文件树以反映复制结果
      await refreshTree();
      return true;
    } catch (error) {
      console.error('复制失败:', error);
      return false;
    }
  }, [apiReady, refreshTree]);

  return {
    rootPath,
    fileTree,
    isLoading,
    openFolder,
    readFile,
    readFileContent,
    createFile,
    createFolder,
    saveFile,
    deleteNode,
    trashNode,
    renameNode,
    moveNode,
    copyNode,
    refreshTree,
    setFileTree,
  };
};

function addToTree(
  nodes: FileNode[],
  targetParentPath: string,
  newNode: FileNode
): FileNode[] {
  return nodes.map(node => {
    if (node.path === targetParentPath && node.type === 'folder') {
      return {
        ...node,
        children: [...(node.children || []), newNode].sort((a, b) => {
          if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
      };
    }

    if (node.children) {
      return {
        ...node,
        children: addToTree(node.children, targetParentPath, newNode),
      };
    }

    return node;
  });
}

function removeFromTree(nodes: FileNode[], targetPath: string): FileNode[] {
  return nodes
    .filter(node => node.path !== targetPath)
    .map(node => {
      if (node.children) {
        return {
          ...node,
          children: removeFromTree(node.children, targetPath),
        };
      }
      return node;
    });
}

/** 生成副本文件名：保留扩展名，形如 a.ts → "a (副本).ts"、"a (副本 2).ts" */
function makeCopyName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  const suffix = n === 1 ? ' (副本)' : ` (副本 ${n})`;
  return `${base}${suffix}${ext}`;
}

export default useFileSystem;