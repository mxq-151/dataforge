// @vitest-environment node
/**
 * docAgentKit 物化语义测试：只覆盖「不破坏用户工作区」这部分契约。
 * 用真实的 resources/docagent 产物（而非 mock），确保 manifest 与构建脚本一致。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_KITS,
  KIT_NAME,
  cleanupWorkspaceKit,
  ensureUserKitLink,
  materializeDocAgentKit,
  materializeKitInto,
  materializeUserKit,
  readKitManifest,
  readKitState,
  resolveDocAgentSourceDir,
  resolveKitSourceDir,
  resolveUserKitDir,
} from './docAgentKit';

const repoRoot = path.resolve(__dirname, '../..');
const sourceDir = path.join(repoRoot, 'resources', 'docagent');

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'docagent-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function listTree(dir: string, root = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listTree(full, root) : [path.relative(root, full).split(path.sep).join('/')];
  });
}

describe('materializeDocAgentKit', () => {
  it('构建产物与 manifest 一一对应', () => {
    const manifest = readKitManifest(sourceDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.kit).toBe(KIT_NAME);
    const onDisk = listTree(path.join(sourceDir, 'fs')).sort();
    expect(manifest!.files.map((file) => file.path).sort()).toEqual(onDisk);
  });

  it('首次物化写入全部文件并记录 state', () => {
    const result = materializeDocAgentKit(sourceDir, workspace, { appVersion: '0.1.0' });
    expect(result.ok).toBe(true);
    expect(result.repaired).toEqual([]);

    const written = listTree(path.join(workspace, '.opencode')).sort();
    expect(written).toContain('tool/submit-metrics-batch.js');
    expect(written).toContain('plugin/guard.js');
    expect(written).toContain('agent/doc-orchestrator.md');
    expect(written).toContain('command/write-req.md');
    expect(written).toContain('.docagent/state.json');

    const state = readKitState(path.join(workspace, '.opencode'));
    expect(state?.kitVersion).toBe(readKitManifest(sourceDir)!.kitVersion);
    expect(Object.keys(state!.files)).toHaveLength(readKitManifest(sourceDir)!.files.length);
  });

  it('二次物化零写入（幂等）', () => {
    materializeDocAgentKit(sourceDir, workspace, { appVersion: '0.1.0' });
    const target = path.join(workspace, '.opencode', 'tool', 'validate-json.js');
    const before = fs.statSync(target).mtimeMs;

    const second = materializeDocAgentKit(sourceDir, workspace, { appVersion: '0.1.0' });
    expect(second.ok).toBe(true);
    expect(second.updated).toEqual([]);
    expect(second.repaired).toEqual([]);
    expect(fs.statSync(target).mtimeMs).toBe(before);
  });

  it('用户改过的受管文件会被恢复并单独标记', () => {
    materializeDocAgentKit(sourceDir, workspace, { appVersion: '0.1.0' });
    const target = path.join(workspace, '.opencode', 'plugin', 'guard.js');
    fs.writeFileSync(target, '// tampered\n');

    const result = materializeDocAgentKit(sourceDir, workspace, { appVersion: '0.1.0' });
    expect(result.repaired).toEqual(['plugin/guard.js']);
    expect(fs.readFileSync(target, 'utf8')).not.toContain('tampered');
  });

  it('不删除、不覆盖清单外的用户文件', () => {
    const userTool = path.join(workspace, '.opencode', 'tool', 'my-own.ts');
    fs.mkdirSync(path.dirname(userTool), { recursive: true });
    fs.writeFileSync(userTool, 'export default {}\n');
    const userDoc = path.join(workspace, 'docs', '我的_开发需求.md');
    fs.mkdirSync(path.dirname(userDoc), { recursive: true });
    fs.writeFileSync(userDoc, '# 手写文档\n');

    const result = materializeDocAgentKit(sourceDir, workspace, { appVersion: '0.1.0' });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(userTool, 'utf8')).toBe('export default {}\n');
    expect(fs.readFileSync(userDoc, 'utf8')).toBe('# 手写文档\n');
    expect(fs.existsSync(path.join(workspace, '.work'))).toBe(false);
  });

  it('升级到新版本时清理旧文件；用户改过的旧文件保留', () => {
    materializeDocAgentKit(sourceDir, workspace, { appVersion: '0.1.0' });

    // 造一个「上一版存在、这一版已移除」的受管文件
    const retired = path.join(workspace, '.opencode', 'tool', 'retired.js');
    const retiredUntouched = path.join(workspace, '.opencode', 'tool', 'retired2.js');
    fs.writeFileSync(retired, 'old\n');
    fs.writeFileSync(retiredUntouched, 'old\n');
    const state = readKitState(path.join(workspace, '.opencode'))!;
    state.files['tool/retired.js'] = crypto.createHash('sha256').update('whatever\n').digest('hex');
    state.files['tool/retired2.js'] = crypto.createHash('sha256').update('old\n').digest('hex');
    fs.writeFileSync(path.join(workspace, '.opencode', '.docagent', 'state.json'), JSON.stringify(state));

    const result = materializeDocAgentKit(sourceDir, workspace, { appVersion: '0.2.0' });
    expect(result.removed).toContain('tool/retired2.js');
    expect(fs.existsSync(retiredUntouched)).toBe(false);
    expect(result.kept).toContain('tool/retired.js');
    expect(fs.existsSync(retired)).toBe(true);
  });

  it('清单路径越界时拒绝写入', () => {
    const fakeSource = fs.mkdtempSync(path.join(os.tmpdir(), 'docagent-src-'));
    fs.mkdirSync(path.join(fakeSource, 'fs'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeSource, 'manifest.json'),
      JSON.stringify({
        kit: KIT_NAME,
        kitVersion: '9.9.9',
        builtAt: new Date().toISOString(),
        files: [{ path: '../../escape.js', sha256: 'x', size: 1 }],
      }),
    );
    const result = materializeDocAgentKit(fakeSource, workspace);
    expect(result.warnings.some((warning) => warning.includes('非法路径'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '..', 'escape.js'))).toBe(false);
    fs.rmSync(fakeSource, { recursive: true, force: true });
  });

  it('套件副本缺失时降级而不是抛错', () => {
    const result = materializeDocAgentKit(path.join(workspace, 'missing'), workspace);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source-missing');
  });

  it('resolveDocAgentSourceDir 区分打包态与开发态', () => {
    expect(resolveDocAgentSourceDir(true, '/app', '/app/Resources')).toBe(path.join('/app/Resources', 'docagent'));
    expect(resolveDocAgentSourceDir(false, '/repo', '/electron')).toBe(path.join('/repo', 'resources', 'docagent'));
  });
});

describe('用户作用域（~/.dataforge/agents）', () => {
  it('物化到 ~/.dataforge/agents 并建立 ~/.opencode 软链', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'docagent-home-'));
    const { materialized, link } = materializeUserKit(sourceDir, home, { appVersion: '0.1.0' });

    expect(materialized.ok).toBe(true);
    expect(resolveUserKitDir(home)).toBe(path.join(home, '.dataforge', 'agents'));
    expect(fs.existsSync(path.join(home, '.dataforge', 'agents', 'plugin', 'guard.js'))).toBe(true);
    expect(link.method).toBe('root-link');
    expect(fs.lstatSync(path.join(home, '.opencode')).isSymbolicLink()).toBe(true);

    // 链接指向后，opencode 的 glob 就能从 ~/.opencode 扫到四类产物
    const linked = path.join(home, '.opencode');
    for (const sub of ['agent', 'tool', 'plugin', 'command']) {
      expect(fs.existsSync(path.join(linked, sub))).toBe(true);
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('已是正确软链时幂等复用', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'docagent-home-'));
    materializeUserKit(sourceDir, home, { appVersion: '0.1.0' });
    const { link } = materializeUserKit(sourceDir, home, { appVersion: '0.1.0' });
    expect(link.method).toBe('already');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('~/.opencode 是真实目录时不接管，只为缺失的子目录建链', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'docagent-home-'));
    fs.mkdirSync(path.join(home, '.opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.opencode', 'notes.md'), 'mine\n');

    const { link } = materializeUserKit(sourceDir, home, { appVersion: '0.1.0' });
    expect(link.method).toBe('sub-links');
    expect(fs.readFileSync(path.join(home, '.opencode', 'notes.md'), 'utf8')).toBe('mine\n');
    expect(fs.lstatSync(path.join(home, '.opencode', 'agent')).isSymbolicLink()).toBe(true);
    expect(ensureUserKitLink(home, resolveUserKitDir(home)).method).toBe('none'); // 子链已建立后仍报 none/conflict
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('用户改写 agent 模板不会被覆盖；改写 guard 会被强制修复', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'docagent-home-'));
    materializeUserKit(sourceDir, home, { appVersion: '0.1.0' });
    const kitDir = resolveUserKitDir(home);
    const agentFile = path.join(kitDir, 'agent', 'chapter-writer.md');
    const guardFile = path.join(kitDir, 'plugin', 'guard.js');
    fs.writeFileSync(agentFile, '---\nmode: subagent\n---\n我自己的版本\n');
    fs.writeFileSync(guardFile, '// tampered\n');

    const { materialized } = materializeUserKit(sourceDir, home, { appVersion: '0.1.0' });
    expect(materialized.overrides).toContain('agent/chapter-writer.md');
    expect(fs.readFileSync(agentFile, 'utf8')).toContain('我自己的版本');
    expect(materialized.repaired).toContain('plugin/guard.js');
    expect(fs.readFileSync(guardFile, 'utf8')).not.toContain('tampered');
    expect(readKitState(kitDir)?.overrides).toContain('agent/chapter-writer.md');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('迁移：清掉工作区旧副本里未改动的受管文件', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'docagent-home-'));
    materializeDocAgentKit(sourceDir, workspace, { appVersion: '0.1.0' });
    const userTool = path.join(workspace, '.opencode', 'tool', 'my-own.ts');
    fs.writeFileSync(userTool, 'export default {}\n');

    const removed = cleanupWorkspaceKit(workspace);
    expect(removed).toContain('tool/submit-chapter.js');
    expect(fs.existsSync(path.join(workspace, '.opencode', 'tool', 'submit-chapter.js'))).toBe(false);
    expect(fs.readFileSync(userTool, 'utf8')).toBe('export default {}\n');
    expect(fs.existsSync(path.join(workspace, '.opencode', '.docagent'))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('materializeKitInto 对同一目录重复调用不重复写入', () => {
    const target = path.join(workspace, 'kit');
    materializeKitInto(sourceDir, target);
    const again = materializeKitInto(sourceDir, target);
    expect(again.updated).toEqual([]);
    expect(again.repaired).toEqual([]);
  });
});

describe('多套件共存（req-doc + dw-dev + task-diag）', () => {
  const dwSource = path.join(repoRoot, 'resources', 'dwagent');
  const diagSource = path.join(repoRoot, 'resources', 'diagagent');

  it('三套 kit 的 dirName/stateDir 与构建产物一致', () => {
    const req = readKitManifest(path.join(repoRoot, 'resources', 'docagent'))!;
    const dw = readKitManifest(dwSource)!;
    const diag = readKitManifest(diagSource)!;
    expect(AGENT_KITS.map((kit) => kit.dirName)).toEqual(['docagent', 'dwagent', 'diagagent']);
    expect(req.kit).toBe('req-doc');
    expect(dw.kit).toBe('dw-dev');
    expect(dw.files.some((file) => file.path.startsWith('tool/dw-'))).toBe(true);
    expect(dw.files.some((file) => file.path === 'agent/dw-orchestrator.md')).toBe(true);
    expect(dw.files.some((file) => file.path === 'command/dw-design.md')).toBe(true);
    expect(diag.kit).toBe('task-diag');
    expect(diag.files.some((file) => file.path === 'agent/diag-orchestrator.md')).toBe(true);
    expect(diag.files.some((file) => file.path === 'tool/diag-collect-logs.js')).toBe(true);
    expect(diag.files.some((file) => file.path === 'plugin/guard.js')).toBe(true);
    expect(diag.files.some((file) => file.path === 'command/diag-spark-failed.md')).toBe(true);
  });

  it('两套物化到同一用户目录时状态隔离、文件共存', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-home-'));
    try {
      const first = materializeUserKit(sourceDir, home, { appVersion: '0.1.0' });
      const second = materializeUserKit(dwSource, home, { appVersion: '0.1.0', stateDir: '.dwagent' });
      const third = materializeUserKit(diagSource, home, { appVersion: '0.1.0', stateDir: '.diagagent' });
      expect(first.materialized.ok).toBe(true);
      expect(second.materialized.ok).toBe(true);
      expect(third.materialized.ok).toBe(true);

      const userDir = resolveUserKitDir(home);
      expect(readKitState(userDir, '.docagent')?.kit).toBe('req-doc');
      expect(readKitState(userDir, '.dwagent')?.kit).toBe('dw-dev');
      expect(readKitState(userDir, '.diagagent')?.kit).toBe('task-diag');
      expect(fs.existsSync(path.join(userDir, 'tool', 'finalize-doc.js'))).toBe(true);
      expect(fs.existsSync(path.join(userDir, 'tool', 'dw-finalize-design.js'))).toBe(true);
      expect(fs.existsSync(path.join(userDir, 'tool', 'diag-collect-logs.js'))).toBe(true);

      // 第二套不把自己的 state 写进 .docagent
      const firstState = readKitState(userDir, '.docagent')!;
      expect(Object.keys(firstState.files).some((file) => file.includes('dw-'))).toBe(false);
      // 链接已存在时复用，不重复创建
      expect(second.link.method === 'already' || second.link.method === 'root-link').toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('清理 dw-dev 不会误删 req-doc 的文件', () => {
    const target = path.join(workspace, '.opencode');
    materializeKitInto(sourceDir, target, { stateDir: '.docagent' });
    materializeKitInto(dwSource, target, { stateDir: '.dwagent' });

    const removed = cleanupWorkspaceKit(workspace, '.dwagent');
    expect(removed).toContain('tool/dw-finalize-code.js');
    expect(fs.existsSync(path.join(target, 'tool', 'dw-finalize-code.js'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'tool', 'finalize-doc.js'))).toBe(true);
    expect(readKitState(target, '.docagent')?.kit).toBe('req-doc');
    expect(readKitState(target, '.dwagent')).toBeNull();
  });

  it('resolveKitSourceDir 按 dirName 映射打包/开发路径', () => {
    expect(resolveKitSourceDir(true, '/app', '/res', 'dwagent')).toBe(path.join('/res', 'dwagent'));
    expect(resolveKitSourceDir(false, '/app', '/res', 'dwagent')).toBe(path.join('/app', 'resources', 'dwagent'));
    expect(resolveDocAgentSourceDir(true, '/app', '/res')).toBe(path.join('/res', 'docagent'));
  });
});
