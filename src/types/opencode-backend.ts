/**
 * OpenCode 后端类型定义
 * 基于 @opencode-ai/sdk/v2/client 类型 + 应用自定义类型
 *
 * 设计理念：直接使用 SDK 原生的 Message → Part[] 数据模型，
 * 不再将其展平为 TranscriptItem，保留完整的结构化信息。
 */
import type {
  OpencodeClient,
  Message,
  Part,
  Session,
  Todo,
  ToolState,
  ToolPart,
  TextPart,
  ReasoningPart,
  AssistantMessage,
  UserMessage,
} from '@opencode-ai/sdk/v2/client';

// ─── 重新导出 SDK 客户端核心类型 ──────────────────────────────

export type { OpencodeClient, Message, Part, Session, Todo, ToolState, ToolPart, TextPart, ReasoningPart, AssistantMessage, UserMessage };

// ─── 消息条目（SDK 原生结构） ──────────────────────────────────
// 对应 session.messages() 返回的 Array<{ info: Message; parts: Part[] }>
// 每条消息包含元信息 (info) 和有序的内容片段列表 (parts)

export interface MessageEntry {
  info: Message;
  parts: Part[];
}

// ─── 应用配置类型 ────────────────────────────────────────────────

/** 推理强度可选值（对齐 OpenCode options.reasoningEffort） */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** 用户可配置的 LLM 模型（用于运行时切换） */
export interface LLMModelConfig {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 提供商 ID（如 openai、deepseek） */
  providerID: string;
  /** 模型 ID（如 gpt-4o、deepseek-chat） */
  modelID: string;
  /** API 密钥（留空则使用全局配置） */
  apiKey: string;
  /** 自定义 Base URL（可选） */
  baseUrl: string;
  /** 是否使用 OpenAI Responses API 调用该模型 */
  useResponsesApi: boolean;
  /** 思考强度（reasoningEffort），必选，默认 high */
  reasoningEffort: ReasoningEffort;
}

// ─── Responses API 内置支持清单 ────────────────────────────────
// 原生支持 OpenAI Responses API 的模型（按 provider 分组）。
// 这些模型在 LLM 配置弹窗中会默认勾选"使用 Responses API"且不可取消。
// DeepSeek: https://api-docs.deepseek.com/zh-cn/guides/responses_api
// Qwen:     https://help.aliyun.com/zh/model-studio/compatibility-with-openai-responses-api
//
// 注意：DeepSeek 暂从清单中移除。
// 原因：opencode 上游 issue #35689（DeepSeek silently stops executing, interleaved
// reasoning_content dropped）尚未修复。DeepSeek Responses API 端点把 reasoning 内容
// 放在 content[].type=reasoning_text，而非 OpenAI 标准的 summary 字段，导致
// @ai-sdk/openai 提取到空 text，前端 reasoning 无法显示。回到 Chat Completions
// API 后 reasoning_content 字段可被正常提取为 reasoning part。
const RESPONSES_API_SUPPORTED_MODELS: Record<string, string[]> = {
  // deepseek: ['deepseek-v4-flash'], // 待上游 #35689 修复后恢复
  qwen: [
    'qwen3-max', 'qwen3-max-2026-01-23',
    'qwen3.7-max', 'qwen3.7-max-2026-05-20', 'qwen3.7-max-2026-06-08',
    'qwen3.7-plus', 'qwen3.7-plus-2026-05-26',
    'qwen3.6-plus', 'qwen3.6-plus-2026-04-02',
    'qwen3.5-plus', 'qwen3.5-plus-2026-02-15', 'qwen3.5-plus-2026-04-20',
    'qwen3.7-flash', 'qwen3.7-flash-2026-07-15',
    'qwen3.6-flash', 'qwen3.6-flash-2026-04-16',
    'qwen3.5-flash', 'qwen3.5-flash-2026-02-23',
    'qwen3.6-35b-a3b', 'qwen3.5-397b-a17b', 'qwen3.5-122b-a10b',
    'qwen3.5-27b', 'qwen3.5-35b-a3b',
    'qwen-plus', 'qwen-flash',
    'qwen3-coder-plus', 'qwen3-coder-flash', 'qwen3-coder-next',
  ],
};

/** 判断指定 provider+modelID 是否原生支持 Responses API */
export function isResponsesApiSupported(providerID: string, modelID: string): boolean {
  const list = RESPONSES_API_SUPPORTED_MODELS[providerID.toLowerCase()];
  if (!list) return false;
  const mid = modelID.toLowerCase();
  return list.some(m => m.toLowerCase() === mid);
}

export interface OpenCodeConfig {
  /** 后端服务地址（业务 API） */
  backendHost: string;
  /** 模型名称 */
  model: string;
  /** API 提供商 */
  modelProvider: string;
  /** API 密钥 */
  apiKey: string;
  /** 自定义 Base URL（custom/ollama/lm-studio 时使用） */
  baseUrl: string;
  /** 用户配置的 LLM 模型列表（可在 AIPanel 中切换） */
  llmModels: LLMModelConfig[];
  /** JAVA_HOME 路径 */
  javaHome: string;
  /** SCALA_HOME 路径 */
  scalaHome: string;
  /** MAVEN_HOME 路径 */
  mavenHome: string;
  /** 基准工作目录（自动计算：$HOME/.dataforge/{后端host}/，无需用户配置）。
   *  项目目录见 App.tsx projectDirs：bloop/metals=code/{pc}，智能体=code/{pc}/{pc}，git={gitRepoDirName}/{pc}） */
  cwd: string;
  /** Git 仓库 URL */
  gitRepoUrl: string;
  /** Git 仓库本地目录名 */
  gitRepoDirName: string;
  /** SSH 私钥路径 */
  gitSshKeyPath: string;
  /** 权限模式：auto=每次询问, accept=全部允许, reject=全部拒绝 */
  permissionMode: 'auto' | 'accept' | 'reject';
  /** DolphinScheduler API 地址 */
  dolphinSchedulerApiUrl: string;
  /** DolphinScheduler Token */
  dolphinSchedulerToken: string;
  /** Marquez API 地址 */
  marquezApiUrl: string;
  /** OpenLineage Transport URL */
  openlineageTransportUrl: string;
  /** POM 模板 */
  pomTemplate: string;
  /** Scala 版本 */
  scalaVersion: string;
  /** Maven groupId（覆盖从包名自动推导的值，留空则按包名推导） */
  mavenGroupId: string;
  /** Maven artifactId（覆盖从包名自动推导的值，留空则按包名推导） */
  mavenArtifactId: string;
  /** 最大轮次 */
  maxTurns: number;
  /** 是否以沙箱模式运行 AI 助手（默认开启；限制文件系统写范围与进程执行，模型 API 网络不受影响） */
  enableSandbox: boolean;
  /** OpenCode 服务器地址 */
  opencodeServerUrl: string;
}

// ─── 对话记录项（旧模型，保留向后兼容） ─────────────────────────
// @deprecated 新代码应使用 MessageEntry + SDK 原生 Part 类型

export type TranscriptItemRole = 'user' | 'assistant' | 'system' | 'tool' | 'tool_result' | 'thinking' | 'log' | 'status';

export interface TranscriptItem {
  role: TranscriptItemRole;
  text: string;
  tool_name?: string;
  tool_input?: string;
  timestamp?: Date;
  status?: 'success' | 'error' | 'running' | 'completed' | 'failed' | 'in_progress' | 'pending';
  is_error?: boolean;
}

// ─── 权限请求 ────────────────────────────────────────────────────

export type ModalKind = 'permission' | 'question';

/** 提问信息（对齐 SDK v2 QuestionInfo，本地定义避免紧密耦合） */
export interface QuestionInfoLocal {
  /** 完整问题文本 */
  question: string;
  /** 简短标签（最多 30 字符） */
  header: string;
  /** 可选项 */
  options: Array<{ label: string; description: string }>;
  /** 是否多选 */
  multiple?: boolean;
  /** 是否允许自定义答案 */
  custom?: boolean;
}

export interface ModalRequest {
  kind: ModalKind;
  request_id: string;
  tool_name?: string;
  reason?: string;
  question?: string;
  /** 权限类型（如 "edit", "bash" 等） */
  permission?: string;
  /** 文件路径模式列表 */
  patterns?: string[];
  /** kind==='question' 时的提问数据（来自 question.asked 事件） */
  questions?: QuestionInfoLocal[];
}

// ─── retry 状态（对齐 SDK v2 SessionStatus.retry） ─────────────

/** retry 期间的操作卡片（如切换 provider / 查看日志） */
export interface RetryAction {
  reason: string;
  provider: string;
  title: string;
  message: string;
  label: string;
  link?: string;
}

/** retry 状态信息（来自 session.status 事件的 retry 分支） */
export interface RetryState {
  /** 重试次数（第几次重试） */
  attempt: number;
  /** 错误描述 */
  message: string;
  /** 下次重试的时间戳（ms） */
  next: number;
  /** 可选的操作卡片 */
  action?: RetryAction;
}

// ─── 日志条目 ────────────────────────────────────────────────────

export interface LogEntry {
  source: 'stdout' | 'stderr' | 'opencode';
  text: string;
  timestamp: Date;
  level?: string;
}

// ─── 选择请求（保留向后兼容） ──────────────────────────────────

export interface SelectRequest {
  title: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description: string }> | null;
  }>;
  requestId: string | number;
  threadId: string;
  turnId: string;
}

// ─── 会话状态（基于 SDK 原生 Message→Part 模型） ──────────────

export interface OpenCodeSessionState {
  /** 消息列表，每条消息包含 info(元信息) + parts(内容片段) */
  messages: MessageEntry[];
  busy: boolean;
  busyLabel: string | undefined;
  /** retry 状态（session.status 事件 type==='retry' 时设置，idle/busy 时清空） */
  retry: RetryState | null;
  ready: boolean;
  connected: boolean;
  error: string | null;
  modals: ModalRequest[];
  logs: LogEntry[];
  /** 当前服务器会话 ID（SDK 原生，由 session.create() 返回） */
  currentSessionId: string | null;
  lastFileChangeSeq: number;
  lastFileChangePaths: string[];
  /** 任务列表（来自 todo.updated 事件） */
  todos: Todo[];
}

// ─── 默认 POM 模板 ───────────────────────────────────────────────

export const DEFAULT_POM_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>{group_id}</groupId>
    <artifactId>{artifact_id}</artifactId>
    <version>1.0-SNAPSHOT</version>
    <packaging>jar</packaging>

    <properties>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
        <scala.version>{scala_version}</scala.version>
    </properties>

    <dependencies>
{deps}
    </dependencies>

    <build>
        <plugins>
{scala_plugin}            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-jar-plugin</artifactId>
                <version>3.3.0</version>
                <configuration>
                    <archive>
                        <manifest>
                            <mainClass>{main_class}</mainClass>
                        </manifest>
                    </archive>
                    <finalName>{final_name}</finalName>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
`;

// ─── 默认配置 ────────────────────────────────────────────────────

export const DEFAULT_CONFIG: OpenCodeConfig = {
  backendHost: '',
  model: '',
  modelProvider: 'deepseek',
  apiKey: '',
  baseUrl: '',
  llmModels: [],
  javaHome: '',
  scalaHome: '',
  mavenHome: '',
  cwd: '',
  gitRepoUrl: '',
  gitRepoDirName: '',
  gitSshKeyPath: '',
  permissionMode: 'auto',
  dolphinSchedulerApiUrl: '',
  dolphinSchedulerToken: '',
  marquezApiUrl: '',
  openlineageTransportUrl: '',
  pomTemplate: DEFAULT_POM_TEMPLATE,
  scalaVersion: '2.13.18',
  mavenGroupId: 'com.dataforge',
  mavenArtifactId: 'data_procs',
  maxTurns: 20,
  enableSandbox: true,
  // sidecar 本地服务地址：opencode 以本地进程方式启动，固定监听 127.0.0.1:4096，非远程地址
  opencodeServerUrl: 'http://127.0.0.1:4096',
};
