/**
 * commitSummary — Git 提交 AI 总结
 *
 * 通过 opencode server 的一次性临时会话生成包含业务变更信息的提交信息：
 * 1. 在系统临时目录（与两个智能体模块订阅的工作目录均不同）创建临时会话，
 *    SSE 事件按 directory 过滤后不会泄漏到任何模块的对话 UI；
 * 2. prompt 携带变更文件列表与 diff，要求 AI 输出业务维度的 conventional commit 信息；
 * 3. session.prompt 完成时直接返回最终 assistant 消息，无需监听事件流；
 * 4. 结束后删除临时会话；任何失败（服务未就绪/超时/空回复）回退到本地统计摘要。
 */

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { getAuthToken, getApiHost } from '../api/index';

/** diff 截断上限（字符），避免大 diff 撑爆模型上下文 */
const MAX_DIFF_CHARS = 30000;

/** AI 总结超时（毫秒），超时后 abort 临时会话并回退本地摘要 */
const SUMMARIZE_TIMEOUT_MS = 90_000;

/** 常见内置工具禁用清单：总结任务无需任何工具，禁用可避免权限请求悬挂 */
const DISABLED_TOOLS: Record<string, boolean> = {
  bash: false,
  read: false,
  edit: false,
  write: false,
  glob: false,
  grep: false,
  list: false,
  patch: false,
  webfetch: false,
  task: false,
  todoread: false,
  todowrite: false,
};

const SUMMARY_SYSTEM_PROMPT = [
  '你是提交信息生成器。根据用户提供的 git 变更文件列表和 diff 内容，生成一条中文提交信息。',
  '要求：',
  '1. 第一行为 conventional commit 标题：类型（feat/fix/refactor/docs/chore/test）+ 冒号 + 中文业务描述，总长不超过 50 字；',
  '2. 标题必须描述具体业务变更（新增了什么功能、修复了什么问题、调整了什么逻辑、涉及哪些表/任务），禁止只写“修改 N 个文件”“新增 M 行”等统计信息；',
  '3. 如变更较复杂，换行后用 2-4 条要点补充说明；',
  '4. 只输出提交信息本身，不要解释、不要 markdown 代码块。',
  '禁止调用任何工具，仅基于给定的 diff 总结。',
].join('\n');

export interface CommitSummaryOptions {
  /** opencode server 地址（如 http://127.0.0.1:4096） */
  serverUrl: string;
  /** 客户端权限模式（与主客户端保持一致） */
  permissionMode: string;
  /** 可选，指定总结使用的模型（覆盖服务端默认） */
  model?: { providerID: string; modelID: string } | null;
  /** 变更文件路径列表 */
  files: string[];
  /** 拼接后的 diff 文本 */
  diffs: string;
}

/** 清理 AI 输出：去掉代码块围栏、首尾引号与多余空白 */
function sanitizeSummary(text: string): string {
  let result = text.trim();
  result = result.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  result = result.trim();
  if (result.length > 2 &&
      ((result.startsWith('"') && result.endsWith('"')) ||
       (result.startsWith("'") && result.endsWith("'")))) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

/** 从 prompt 返回的 parts 中提取文本 */
function extractText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter(p => p.type === 'text' && typeof p.text === 'string')
    .map(p => (p.text as string).trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 本地统计摘要（无 AI 服务时的回退）：文件数 + 语言 + 增删行数。
 */
export function localSummary(files: string[], diffs: string): string {
  if (!files.length) return 'chore: no changes';

  const added = files.filter(f => f.includes('new') || f.includes('create') || f.includes('add'));
  const modified = files.filter(f => !added.includes(f));
  const parts: string[] = [];

  if (added.length > 0 && modified.length > 0) {
    parts.push(`新增 ${added.length} 个文件，修改 ${modified.length} 个文件`);
  } else if (added.length > 0) {
    parts.push(`新增 ${added.length} 个文件`);
  } else if (modified.length > 0) {
    parts.push(`修改 ${modified.length} 个文件`);
  }

  const exts = [...new Set(files.map(f => f.split('.').pop() || ''))];
  if (exts.length === 1 && exts[0]) {
    const langMap: Record<string, string> = { sql: 'SQL', py: 'Python', java: 'Java', scala: 'Scala', tsx: 'TypeScript', ts: 'TypeScript' };
    parts.push(langMap[exts[0]] || exts[0].toUpperCase());
  }

  if (diffs) {
    const addLines = (diffs.match(/^\+[^+]/gm) || []).length;
    const delLines = (diffs.match(/^\-[^-]/gm) || []).length;
    if (addLines > 0 || delLines > 0) {
      parts.push(`+${addLines}/-${delLines} 行`);
    }
  }

  return parts.join('，');
}

/**
 * 用 AI 生成包含业务变更信息的提交信息。
 * 失败时回退 localSummary，保证按钮始终有输出。
 */
export async function generateCommitSummary(options: CommitSummaryOptions): Promise<string> {
  const { serverUrl, permissionMode, model, files, diffs } = options;
  if (!files.length) return localSummary(files, diffs);

  let client: OpencodeClient | null = null;
  let sessionId: string | null = null;
  try {
    // 临时目录作为会话工作目录：与两个模块订阅的工作目录不同，
    // 该会话的 SSE 事件会被目录过滤规则拦截，不会污染任何对话 UI。
    let scratchDir = '/tmp';
    try {
      const { tempDir } = await import('@tauri-apps/api/path');
      scratchDir = await tempDir();
    } catch {
      // 非 Tauri 环境兜底
    }

    const token = await getAuthToken();
    client = createOpencodeClient({
      baseUrl: serverUrl,
      authToken: token ?? undefined,
      permissionMode,
      apiHost: getApiHost(),
      directory: scratchDir,
    } as any);

    const created = await client.session.create({
      directory: scratchDir,
      title: 'commit-summary',
    });
    sessionId = created.data?.id ?? null;
    if (!sessionId) throw new Error('临时会话创建失败');

    let diffText = diffs || '';
    let truncated = false;
    if (diffText.length > MAX_DIFF_CHARS) {
      diffText = diffText.slice(0, MAX_DIFF_CHARS);
      truncated = true;
    }

    const userPrompt = [
      '变更文件列表：',
      ...files.map(f => `- ${f}`),
      '',
      'diff 内容：',
      diffText || '（无 diff 内容）',
      truncated ? '\n（diff 过长已截断）' : '',
    ].join('\n');

    // 超时保护：临时会话若因权限请求等原因悬挂，abort 后回退本地摘要
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AI 总结超时')), SUMMARIZE_TIMEOUT_MS);
    });

    const result = await Promise.race([
      client.session.prompt({
        sessionID: sessionId,
        directory: scratchDir,
        parts: [{ type: 'text', text: userPrompt }],
        system: SUMMARY_SYSTEM_PROMPT,
        tools: DISABLED_TOOLS,
        ...(model ? { model } : {}),
      }),
      timeoutPromise,
    ]);

    const text = extractText((result.data?.parts ?? []) as Array<{ type: string; text?: string }>);
    const summary = sanitizeSummary(text);
    if (!summary) throw new Error('AI 返回空总结');
    return summary.slice(0, 500);
  } catch (err) {
    console.warn('[commitSummary] AI 总结失败，回退本地统计摘要:', err);
    return localSummary(files, diffs);
  } finally {
    // 清理临时会话（尽力而为）
    if (client && sessionId) {
      try {
        await client.session.abort({ sessionID: sessionId });
      } catch { /* 会话已空闲时 abort 可能报错，忽略 */ }
      try {
        await client.session.delete({ sessionID: sessionId });
      } catch { /* 忽略清理失败 */ }
    }
  }
}
