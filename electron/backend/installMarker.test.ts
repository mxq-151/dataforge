// @vitest-environment node
/**
 * 安装标记的纯逻辑测试。
 *
 * 跑在 node 环境：被测代码是主进程的，只用字符串路径与注入的 fs 端口，
 * 不依赖 DOM，也不依赖 Electron —— 行为与真实运行环境一致。
 *
 * 最要紧的一条不变量在最后：**任何读写都不得触碰应用包内的文件**。
 * 旧实现往包内写 .df-install-token，直接把代码签名的密封资源清单写坏
 * （codesign：a sealed resource is missing or invalid / file added），
 * 进而让 macOS 钥匙串 ACL 校验失败、每次启动都索要登录钥匙串密码。
 */
import { describe, it, expect } from 'vitest';
import {
  LEGACY_MARKER_FILE_NAME,
  MARKER_FILE_NAME,
  MARKER_VERSION,
  fingerprintOf,
  readInstallMarker,
  resolveBundleRoot,
  writeInstallMarker,
  type MarkerFsPort,
  type MarkerPaths,
  type MarkerStat,
} from './installMarker';

const BUNDLE = '/Applications/DataForge.app';
const USER_DATA = '/Users/x/Library/Application Support/dataforge-electron';
const MARKER_FILE = `${USER_DATA}/${MARKER_FILE_NAME}`;
const LEGACY_FILE = `${BUNDLE}/Contents/Resources/app/${LEGACY_MARKER_FILE_NAME}`;

const paths = (over: Partial<MarkerPaths> = {}): MarkerPaths => ({
  markerFile: MARKER_FILE,
  legacyFile: LEGACY_FILE,
  bundleRoot: BUNDLE,
  ...over,
});

const INSTALL_A: MarkerStat = { ino: 4242, birthtimeMs: 1_700_000_000_000 };
/** 重装：同一路径下的新目录，inode 与创建时间都变了 */
const INSTALL_B: MarkerStat = { ino: 5353, birthtimeMs: 1_800_000_000_000 };

interface FakeFs extends MarkerFsPort {
  files: Map<string, string>;
  /** 所有被写过的路径（用于「不许写应用包」的断言） */
  writes: string[];
  mkdirs: string[];
}

function makeFs(initial: Record<string, string> = {}, stats: Record<string, MarkerStat> = { [BUNDLE]: INSTALL_A }): FakeFs {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const mkdirs: string[] = [];
  return {
    files,
    writes,
    mkdirs,
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: async (p, data) => {
      writes.push(p);
      files.set(p, data);
    },
    mkdir: async (p) => {
      mkdirs.push(p);
    },
    stat: async (p) => {
      const st = stats[p];
      if (!st) throw new Error(`ENOENT: ${p}`);
      return st;
    },
  };
}

const markerOf = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: MARKER_VERSION, token: 'tok-old', fingerprint: fingerprintOf(INSTALL_A), ...over });

describe('fingerprintOf', () => {
  it('取 (inode, 创建时间) 并向下取整，重装后必然不同', () => {
    expect(fingerprintOf(INSTALL_A)).toBe('4242:1700000000000');
    expect(fingerprintOf({ ino: 4242.9, birthtimeMs: 1_700_000_000_000.7 })).toBe('4242:1700000000000');
    expect(fingerprintOf(INSTALL_A)).not.toBe(fingerprintOf(INSTALL_B));
  });
});

describe('resolveBundleRoot', () => {
  it('macOS 从 .app/Contents/MacOS/<exe> 上溯到 .app', () => {
    expect(resolveBundleRoot(`${BUNDLE}/Contents/MacOS/DataForge`, 'darwin')).toBe(BUNDLE);
  });

  it('macOS dev 的 execPath 也能解析到 Electron.app（函数级正确性；dev 实际不参与指纹判定）', () => {
    expect(
      resolveBundleRoot('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', 'darwin'),
    ).toBe('/repo/node_modules/electron/dist/Electron.app');
  });

  it('macOS 但不在 .app 内 → 可执行文件所在目录', () => {
    expect(resolveBundleRoot('/usr/local/bin/dataforge', 'darwin')).toBe('/usr/local/bin');
  });

  it('Windows / Linux 取安装目录', () => {
    expect(resolveBundleRoot('C:/Program Files/DataForge/DataForge.exe', 'win32')).toBe('C:/Program Files/DataForge');
    expect(resolveBundleRoot('/opt/DataForge/dataforge', 'linux')).toBe('/opt/DataForge');
  });
});

describe('readInstallMarker', () => {
  it('全新安装：无任何标记 → null（渲染层据此要求同意协议）', async () => {
    expect(await readInstallMarker(makeFs(), paths())).toBeNull();
  });

  it('同一次安装内反复启动：指纹一致 → 复用既有 token', async () => {
    const fs = makeFs({ [MARKER_FILE]: markerOf() });
    expect(await readInstallMarker(fs, paths())).toBe('tok-old');
    expect(await readInstallMarker(fs, paths())).toBe('tok-old');
  });

  it('指纹变化（重装/替换安装包）→ null，且不删旧标记（等用户重新同意后覆盖）', async () => {
    const fs = makeFs({ [MARKER_FILE]: markerOf() }, { [BUNDLE]: INSTALL_B });
    expect(await readInstallMarker(fs, paths())).toBeNull();
    expect(fs.files.get(MARKER_FILE)).toBe(markerOf());
  });

  it('重新同意后写入新 token，此后复用新 token', async () => {
    const fs = makeFs({ [MARKER_FILE]: markerOf() }, { [BUNDLE]: INSTALL_B });
    const token = await writeInstallMarker(fs, paths());
    expect(token).toBeTruthy();
    expect(token).not.toBe('tok-old');
    expect(await readInstallMarker(fs, paths())).toBe(token);
  });

  it('bundleRoot 为 null（dev 不参与指纹判定）→ 不写指纹、读取时保守放行', async () => {
    const dev = paths({ bundleRoot: null });
    const fs = makeFs();
    const token = await writeInstallMarker(fs, dev);
    expect(token).toBeTruthy();
    expect(JSON.parse(fs.files.get(MARKER_FILE) ?? '{}').fingerprint).toBeUndefined();
    expect(await readInstallMarker(fs, dev)).toBe(token);
    // dev 写下的标记（无指纹）不该在打包态被判成重装 —— 两种运行方式互不打扰
    expect(await readInstallMarker(fs, paths())).toBe(token);
  });

  it('拿不到当前指纹（stat 失败）→ 保守放行，不把每次启动都变成协议页', async () => {
    const fs = makeFs({ [MARKER_FILE]: markerOf() }, {});
    expect(await readInstallMarker(fs, paths())).toBe('tok-old');
  });

  it('历史形态：标记文件是裸 token（非 JSON）→ 按 token 处理', async () => {
    const fs = makeFs({ [MARKER_FILE]: '  legacy-plain-token\n' });
    expect(await readInstallMarker(fs, paths())).toBe('legacy-plain-token');
  });

  it('记录里缺 token / 空文件 / 结构不对 → null', async () => {
    expect(await readInstallMarker(makeFs({ [MARKER_FILE]: JSON.stringify({ version: MARKER_VERSION }) }), paths())).toBeNull();
    expect(await readInstallMarker(makeFs({ [MARKER_FILE]: '   ' }), paths())).toBeNull();
    expect(await readInstallMarker(makeFs({ [MARKER_FILE]: '[]' }), paths())).toBeNull();
  });

  it('版本不兼容 → null（fail-close，最坏只是让用户再同意一次）', async () => {
    const fs = makeFs({ [MARKER_FILE]: markerOf({ version: MARKER_VERSION + 1 }) });
    expect(await readInstallMarker(fs, paths())).toBeNull();
  });
});

describe('readInstallMarker：旧实现（标记在应用包内）的只读迁移', () => {
  const legacyInstalled = () => makeFs({ [LEGACY_FILE]: 'tok-legacy' });

  it('读到包内旧标记 → 放行，并迁移到 userData（含指纹）', async () => {
    const fs = legacyInstalled();
    expect(await readInstallMarker(fs, paths())).toBe('tok-legacy');

    const migrated = JSON.parse(fs.files.get(MARKER_FILE) ?? '{}');
    expect(migrated.token).toBe('tok-legacy');
    expect(migrated.fingerprint).toBe(fingerprintOf(INSTALL_A));
    expect(migrated.version).toBe(MARKER_VERSION);
  });

  it('迁移后不再依赖包内文件（包被替换/标记被删也不影响）', async () => {
    const fs = legacyInstalled();
    await readInstallMarker(fs, paths());
    fs.files.delete(LEGACY_FILE);
    expect(await readInstallMarker(fs, paths())).toBe('tok-legacy');
  });

  it('迁移写入失败 → 本次仍放行，不抛错（下次启动重试）', async () => {
    const fs = legacyInstalled();
    fs.mkdir = async () => {
      throw new Error('EACCES');
    };
    expect(await readInstallMarker(fs, paths())).toBe('tok-legacy');
    expect(fs.files.has(MARKER_FILE)).toBe(false);
  });

  it('包内没有旧标记、userData 也没有 → null', async () => {
    expect(await readInstallMarker(makeFs(), paths())).toBeNull();
  });
});

describe('writeInstallMarker', () => {
  it('写入成功返回 token，且落盘的是带版本与指纹的记录', async () => {
    const fs = makeFs();
    const token = await writeInstallMarker(fs, paths());
    expect(token).toBeTruthy();
    const rec = JSON.parse(fs.files.get(MARKER_FILE) ?? '{}');
    expect(rec).toMatchObject({ version: MARKER_VERSION, token, fingerprint: fingerprintOf(INSTALL_A) });
    expect(fs.mkdirs).toEqual([USER_DATA]);
  });

  it('拿不到指纹时仍写入（指纹留空 → 读取侧保守放行）', async () => {
    const fs = makeFs({}, {});
    const token = await writeInstallMarker(fs, paths());
    expect(token).toBeTruthy();
    expect(JSON.parse(fs.files.get(MARKER_FILE) ?? '{}').token).toBe(token);
  });

  it('写入失败 → 返回 null（调用方降级，不阻塞进入）', async () => {
    const fs = makeFs();
    fs.writeFile = async () => {
      throw new Error('ENOSPC');
    };
    expect(await writeInstallMarker(fs, paths())).toBeNull();
  });
});

describe('不变量：安装标记全程不写应用包', () => {
  it('读 + 迁移 + 写 都只写 userData 下的标记文件，绝不写包内路径', async () => {
    const fs = makeFs({ [LEGACY_FILE]: 'tok-legacy' });
    await readInstallMarker(fs, paths());
    await writeInstallMarker(fs, paths());
    await readInstallMarker(fs, paths());

    expect(fs.writes.length).toBeGreaterThan(0);
    for (const p of [...fs.writes, ...fs.mkdirs]) {
      expect(p.startsWith(BUNDLE)).toBe(false);
    }
    expect(fs.writes.every((p) => p === MARKER_FILE)).toBe(true);
    // 包内旧标记保持原样（只读）
    expect(fs.files.get(LEGACY_FILE)).toBe('tok-legacy');
  });
});
