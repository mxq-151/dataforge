// @vitest-environment node
/**
 * Maven 调用命令行构造单测。
 *
 * 背景（回归 bug）：Windows 下 mvn 是 `mvn.cmd`，必须经 cmd.exe 包装执行，而 Node 在
 * `shell: true` 时只是把 file 与 args 用空格**裸拼**、不做任何转义（即 DEP0190 警告的语义）。
 * 于是 mavenHome 含空格时（如 `C:\Program Files\apache-maven-3.9.9`）命令行会被 cmd.exe
 * 在空格处截断，报 "'C:\Program' is not recognized as an internal or external command"。
 * 修复方式是自行拼好带引号的命令行并以单个字符串交给 shell。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCmdCommandLine, needsCmdShell, quoteCmdArg, runMvn } from './maven';

const isWindows = process.platform === 'win32';

describe('quoteCmdArg', () => {
  it('普通参数原样返回（不引入多余引号）', () => {
    expect(quoteCmdArg('bloop:bloopInstall')).toBe('bloop:bloopInstall');
    expect(quoteCmdArg('-q')).toBe('-q');
    expect(quoteCmdArg('-DskipTests')).toBe('-DskipTests');
  });

  it('含空格的路径整体加双引号', () => {
    expect(quoteCmdArg('C:\\Program Files\\apache-maven\\bin\\mvn.cmd')).toBe(
      '"C:\\Program Files\\apache-maven\\bin\\mvn.cmd"',
    );
  });

  it('空串转成 ""，内部双引号成对转义', () => {
    expect(quoteCmdArg('')).toBe('""');
    expect(quoteCmdArg('-Dx=a "b"')).toBe('"-Dx=a ""b"""');
  });

  it('含 cmd 元字符（&|<>^()）时加引号', () => {
    expect(quoteCmdArg('a&b')).toBe('"a&b"');
    expect(quoteCmdArg('-Dprop=a|b')).toBe('"-Dprop=a|b"');
  });
});

describe('buildCmdCommandLine', () => {
  it('把 bin 与 args 逐个转义后拼成单条命令行', () => {
    expect(buildCmdCommandLine('C:\\Program Files\\mvn\\bin\\mvn.cmd', ['bloop:bloopInstall', '-q'])).toBe(
      '"C:\\Program Files\\mvn\\bin\\mvn.cmd" bloop:bloopInstall -q',
    );
  });
});

describe('needsCmdShell', () => {
  it('仅 Windows 下的 .cmd/.bat 需要 shell 包装', () => {
    expect(needsCmdShell('C:\\m\\bin\\mvn.cmd')).toBe(isWindows);
    expect(needsCmdShell('C:\\m\\bin\\mvn.bat')).toBe(isWindows);
    expect(needsCmdShell('/usr/local/bin/mvn')).toBe(false);
    expect(needsCmdShell('C:\\Java\\bin\\javac.exe')).toBe(false);
  });
});

// ─── 端到端：真实 spawn 一个「路径含空格的 .cmd」 ──────────────────
// 用假的 mvn.cmd 复现原始报错场景，断言修复后能正常执行且参数完整送达。

const tmpRoot = path.join(os.tmpdir(), `df mvn test ${process.pid}`);
const fakeMvnDir = path.join(tmpRoot, 'Program Files', 'fake-maven', 'bin');
const fakeMvn = path.join(fakeMvnDir, 'mvn.cmd');

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe('runMvn（Windows .cmd 经 cmd.exe 包装）', () => {
  it('[win32] 路径含空格时不再被截断成 C:\\Program', async () => {
    if (!isWindows) return; // 非 Windows 无此场景
    fs.mkdirSync(fakeMvnDir, { recursive: true });
    fs.writeFileSync(fakeMvn, '@echo off\r\necho ARGS=[%*]\r\nexit /b 0\r\n', 'utf8');

    const r = await runMvn(fakeMvn, ['bloop:bloopInstall', '-q'], tmpRoot, {});

    expect(r.spawnError).toBeUndefined();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ARGS=[bloop:bloopInstall -q]');
    expect(r.stderr).not.toContain('is not recognized');
  });

  it('[win32] 非零退出码能如实回传', async () => {
    if (!isWindows) return;
    fs.mkdirSync(fakeMvnDir, { recursive: true });
    fs.writeFileSync(fakeMvn, '@echo off\r\nexit /b 3\r\n', 'utf8');

    const r = await runMvn(fakeMvn, ['bloop:bloopInstall'], tmpRoot, {});
    expect(r.code).toBe(3);
  });
});
