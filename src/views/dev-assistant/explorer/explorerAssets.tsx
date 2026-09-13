import {
  FolderOpen,
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FileCode,
  FileJson,
  FileText,
  Image,
} from 'lucide-react';
import type { IconMap, ExplorerConfig } from 'react-file-navigator';

export const iconMap: IconMap = {
  default: <File size={16} style={{ color: '#cccccc' }} />,
  folderCollapsed: (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <ChevronRight size={14} style={{ color: '#858585', marginRight: 2 }} />
      <Folder size={16} style={{ color: '#dcb67a' }} />
    </span>
  ),
  folderExpanded: (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <ChevronDown size={14} style={{ color: '#858585', marginRight: 2 }} />
      <FolderOpen size={16} style={{ color: '#dcb67a' }} />
    </span>
  ),
  ts: <FileCode size={16} style={{ color: '#519aba' }} />,
  tsx: <FileCode size={16} style={{ color: '#519aba' }} />,
  js: <FileCode size={16} style={{ color: '#519aba' }} />,
  jsx: <FileCode size={16} style={{ color: '#519aba' }} />,
  json: <FileJson size={16} style={{ color: '#f5de50' }} />,
  md: <FileText size={16} style={{ color: '#cccccc' }} />,
  txt: <FileText size={16} style={{ color: '#cccccc' }} />,
  png: <Image size={16} style={{ color: '#a07c3c' }} />,
  jpg: <Image size={16} style={{ color: '#a07c3c' }} />,
  jpeg: <Image size={16} style={{ color: '#a07c3c' }} />,
  gif: <Image size={16} style={{ color: '#a07c3c' }} />,
  svg: <Image size={16} style={{ color: '#a07c3c' }} />,
  sql: <FileCode size={16} style={{ color: '#e2c08d' }} />,
  py: <FileCode size={16} style={{ color: '#4EC9B0' }} />,
  java: <FileCode size={16} style={{ color: '#b8383d' }} />,
  scala: <FileCode size={16} style={{ color: '#de3423' }} />,
  css: <FileCode size={16} style={{ color: '#563d7c' }} />,
  scss: <FileCode size={16} style={{ color: '#c6538c' }} />,
  html: <FileCode size={16} style={{ color: '#e34c26' }} />,
  xml: <FileCode size={16} style={{ color: '#f26522' }} />,
  yml: <FileText size={16} style={{ color: '#cb171e' }} />,
  yaml: <FileText size={16} style={{ color: '#cb171e' }} />,
  sh: <FileText size={16} style={{ color: '#89e051' }} />,
};

export const explorerConfig: ExplorerConfig = {
  label: '',
  fontColor: '#cccccc',
  accentColor: '#094771',
  fontSize: '13px',
  iconSize: '16px',
  disableActions: true,
  rename: 'None' as any,
  delete: 'None' as any,
};
