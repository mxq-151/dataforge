import React from 'react';
import ConfigParamsModal from '../../../components/editor/ConfigParamsModal';
import FolderSubmitScheduleModal from '../FolderSubmitScheduleModal';
import type { DolphinSchedulerApi } from '../../../types/dolphinscheduler';
import type { CompileConfig } from '../../../services/unifiedCompile';

/**
 * 文件夹右键动作（配置参数 / 提交调度）的当前打开状态。
 * 两个动作共用同一份目标代码文件折算结果，同一时刻最多打开一个。
 */
export type FolderAction =
  | { kind: 'configParams'; files: string[] }
  | { kind: 'submitSchedule'; folder: string; files: string[] };

export interface FolderActionContext {
  rootPath: string | null;
  /** 开发项目根目录（与单文件「提交调度」同源，一般传 projectCwd） */
  projectRoot?: string | null;
  projectId?: number;
  projectCode?: string;
  openlineageTransportUrl?: string;
  readFileContent?: (filePath: string) => Promise<string>;
  onSaveConfigParams?: (filePath: string, data: {
    dependencies: { id: string; name: string; version: string; source?: string; jarPath?: string; groupId?: string; scope?: string; autoChoose?: number | null; basePath?: string }[];
    programParams: { id: string; key: string; value: string }[];
    taskParams: { id: string; key: string; value: string }[];
  }) => void;
  dsApi?: DolphinSchedulerApi | null;
  isRealApi?: boolean;
  compileConfig?: CompileConfig | null;
}

interface FolderActionModalsProps extends FolderActionContext {
  action: FolderAction | null;
  onClose: () => void;
}

/**
 * 「配置参数」「提交调度」两个弹窗的跨模块接线：
 * 集中持有 devProject（projectId/projectCode）、OpenLineage、DolphinScheduler、
 * 编译环境等外部依赖的透传，ExplorerPanel 只负责声明动作目标。
 */
const FolderActionModals: React.FC<FolderActionModalsProps> = ({
  action,
  rootPath,
  projectRoot,
  projectId,
  projectCode,
  openlineageTransportUrl,
  readFileContent,
  onSaveConfigParams,
  dsApi,
  isRealApi,
  compileConfig,
  onClose,
}) => {
  if (!action || action.files.length === 0) return null;

  // 配置参数（批量）：文件夹右键时把同一份参数写入其下全部代码文件
  if (action.kind === 'configParams') {
    return (
      <ConfigParamsModal
        visible
        onClose={onClose}
        rootPath={rootPath || undefined}
        projectId={projectId}
        projectCode={projectCode}
        openlineageTransportUrl={openlineageTransportUrl}
        targetPaths={action.files}
        readFileContent={readFileContent}
        onSave={(data, filePath) => {
          if (filePath) onSaveConfigParams?.(filePath, data);
        }}
      />
    );
  }

  // 提交调度：文件夹右键时，按该文件夹下的代码文件自动生成任务节点后提交到调度系统
  return (
    <FolderSubmitScheduleModal
      visible
      folderPath={action.folder}
      codeFilePaths={action.files}
      // 工作流名称/展示路径的推导基准必须与单文件「提交调度」一致（projectCwd），
      // 否则相对路径口径不同会算出不一样的工作流名
      rootPath={projectRoot || rootPath || undefined}
      projectCode={projectCode}
      readFileContent={readFileContent}
      dsApi={dsApi ?? null}
      isRealApi={isRealApi}
      compileConfig={compileConfig ?? null}
      devProjectId={projectId}
      openlineageTransportUrl={openlineageTransportUrl}
      onClose={onClose}
    />
  );
};

export default FolderActionModals;
