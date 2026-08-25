import { useState, useCallback, useEffect } from 'react';
import { FileNode } from '../types';
import { generateId, generateFileHeader } from '../utils';
import { isWindows as checkIsWindows } from '../utils/pathUtils';
import { homeDir } from '@tauri-apps/api/path';

const getPlatformFallbackWorkspace = (): string => {
  const isWin = checkIsWindows();
  const isMac = navigator.platform?.includes('Mac') || navigator.userAgent.includes('Mac');

  if (isWin) {
    return 'C:\\Users\\.dataforge';
  }

  if (isMac) {
    return '/Users/.dataforge';
  }

  return '/home/.dataforge';
};

const DEFAULT_WORKSPACE = getPlatformFallbackWorkspace();

let cachedWorkspace: string | null = null;

export const getPlatformDefaultWorkspace = async (): Promise<string> => {
  if (cachedWorkspace) {
    return cachedWorkspace;
  }

  try {
    const home = await homeDir();
    const separator = home.includes('\\') ? '\\' : '/';
    cachedWorkspace = `${home}${separator}.dataforge`;
    return cachedWorkspace;
  } catch (error) {
    console.warn('[FS] 无法获取用户主目录，使用回退方案:', error);
    cachedWorkspace = DEFAULT_WORKSPACE;
    return cachedWorkspace;
  }
};

interface FileSystemAPI {
  readDir: (path: string) => Promise<any[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  createDir: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  removeFile: (path: string) => Promise<void>;
  removeDir: (path: string) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
}

let fsAPI: FileSystemAPI | null = null;

export const initFileSystemAPI = async (): Promise<FileSystemAPI> => {

  if (fsAPI) {
    return fsAPI;
  }

  try {
    const hasTauriGlobal = '__TAURI__' in window;
    const hasTauriInternals = '__TAURI_INTERNALS__' in window;
    const isTauri = hasTauriGlobal || hasTauriInternals;

    if (!isTauri) {
      return createWebFSAPI();
    }

    const [fsModule] = await Promise.all([
      import('@tauri-apps/plugin-fs'),
    ]);

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
    };

    return fsAPI;
  } catch (error) {
    console.error('❌ [FS] 初始化 Tauri FS API 失败，回退到 Web FS:', error);
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
  };
}
const useFileSystem = (initialPath?: string) => {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [apiReady, setApiReady] = useState(false);

  useEffect(() => {
    initializeFileSystem();
  }, []);

  const initializeFileSystem = async () => {
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

    try {
      setIsLoading(true);
      const api = await initFileSystemAPI();
      const workspacePath = await getPlatformDefaultWorkspace();

      setRootPath(workspacePath);
      const tree = await buildFileTree(workspacePath, api);
      setFileTree(tree);
    } catch (error) {
      console.error('❌ [openDefaultFolder] 打开默认文件夹失败:', error);
    } finally {
      setIsLoading(false);
    }
  }, [buildFileTree]);

  const openFolder = useCallback(async (customPath?: string) => {
    try {
      setIsLoading(true);
      const api = await initFileSystemAPI();
      const defaultPath = await getPlatformDefaultWorkspace();
      const targetPath = customPath || defaultPath;

      setRootPath(targetPath);
      const tree = await buildFileTree(targetPath, api);
      setFileTree(tree);
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
      await refreshTree();
      return true;
    } catch (error) {
      console.error('删除失败:', error);
      return false;
    }
  }, [apiReady, refreshTree]);

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

      // 刷新文件树以反映重命名
      await refreshTree();
      return true;
    } catch (error) {
      console.error('重命名失败:', error);
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
    renameNode,
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

export default useFileSystem;