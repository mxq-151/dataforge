/**
 * 执行结果 / 执行历史域（execHistory）的统一公共接口。
 *
 * 域内职责：
 *   - ExecutionResultTabs   执行结果 / 执行历史展示组件（含图表分析）
 *   - TaskExecutionService  任务集顺序执行服务（提交 / 轮询 / 取消 / 日志）
 *   - historyStore          历史持久化（SyncedStore 磁盘文件 + localStorage 迁移）
 *   - historyIsolation      按「后端 host + 用户 + 项目编码」隔离的存储键
 *
 * 消费方（useProgramRunner / EditorArea / DataExploreEditor / useOpencodeClient）
 * 一律从本入口导入，不直接深入域内文件路径。
 */

export { default } from './ExecutionResultTabs';
export { default as ExecutionResultTabs } from './ExecutionResultTabs';
export type { ResultItem, HistoryItem, TabKey } from './ExecutionResultTabs';

export { TaskExecutionService, parseSqlStatements } from './taskExecutionService';
export type { TaskDefinition, TaskItem, TaskSet, TaskStatus, TaskSetStatus } from './taskExecutionService';

export { ensureHistoryStore, readHistory, writeHistory, MAX_HISTORY_ITEMS } from './historyStore';

export { buildScopedStorageKey } from './historyIsolation';
