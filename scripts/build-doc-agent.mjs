/**
 * 打包 agentkit/* → resources/<outDir>（随安装包分发的自包含产物）。
 *
 * 当前两套：
 *   agentkit/req-doc → resources/docagent   （需求文档）
 *   agentkit/dw-dev  → resources/dwagent    （数仓设计 + 作业代码）
 * outDir / stateDir 由各自的 kit.json 声明；新增套件只需加目录与 kit.json，不改脚本。
 *
 * 为什么用 esbuild 打成自包含 js：
 * opencode 只能从 `<cwd>/.opencode/{tool,plugin}/*.{js,ts}` 加载工具与插件，
 * 而用户工作区没有 node_modules——`zod`、`@opencode-ai/plugin` 都无法从工作区解析。
 * opencode 自己只会为 `.opencode` 目录后台安装 `@opencode-ai/plugin`（网络依赖、
 * 异步、版本随安装源漂移），不能作为 zod 的依赖来源。所以除 `node:*` 外全部内联。
 *
 * 产物布局 = 工作区 `.opencode` 子树的镜像（fs/ 下的路径会被 1:1 复制过去）：
 *   resources/<outDir>/
 *     manifest.json          版本 + stateDir + 每个文件 sha256（物化与防篡改校验的事实源）
 *     fs/tool/*.js           工具 entry
 *     fs/tool/chunks/*.js    tool 之间共享的 zod 运行时（splitting 产物）
 *     fs/plugin/guard.js     写盘闸（仅 req-doc）
 *     fs/agent/*.md          agent（frontmatter + prompt 全文）
 *     fs/command/*.md        command
 *
 * 用 splitting 而不是每个 entry 各带一份 zod：文件数与体积都可控。
 * chunks 放在 tool/ 子目录里，opencode 的 `{tool,tools}/*.{js,ts}` 是非递归 glob，
 * 不会把 chunk 误注册成工具。
 *
 * 不生成 sourcemap：安装包体积优先；guard 属安全边界，不宜以可读源形式随包分发。
 */
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const kitRoot = path.join(root, 'agentkit');

function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function copyMd(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const file of listFiles(fromDir, '.md')) {
    fs.copyFileSync(file, path.join(toDir, path.basename(file)));
  }
}

async function bundle(entryDir, toDir) {
  const entryPoints = listFiles(entryDir, '.ts');
  if (entryPoints.length === 0) return;
  fs.mkdirSync(toDir, { recursive: true });
  await build({
    entryPoints,
    outdir: toDir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // 只外置 Node 内建模块；zod / @opencode-ai/plugin / lib 全部内联
    external: ['node:*'],
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    minify: true,
    keepNames: true,
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'warning',
  });
}

function discoverKits() {
  if (!fs.existsSync(kitRoot)) throw new Error(`缺少 agentkit 目录：${kitRoot}`);
  return fs
    .readdirSync(kitRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(kitRoot, entry.name, 'kit.json')))
    .map((entry) => {
      const srcDir = path.join(kitRoot, entry.name);
      const kit = JSON.parse(fs.readFileSync(path.join(srcDir, 'kit.json'), 'utf8'));
      if (!kit.kit || !kit.kitVersion) throw new Error(`${entry.name}/kit.json 缺少 kit 或 kitVersion`);
      return { srcDir, kit, outDir: path.join(root, 'resources', kit.outDir) };
    })
    .sort((a, b) => a.kit.kit.localeCompare(b.kit.kit));
}

async function buildKit({ srcDir, kit, outDir }) {
  const fsDir = path.join(outDir, 'fs');
  const tag = `[${kit.outDir ?? kit.kit}]`;

  // 全量重建，避免套件删文件后安装包残留旧产物
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(fsDir, { recursive: true });

  await bundle(path.join(srcDir, 'tool'), path.join(fsDir, 'tool'));
  await bundle(path.join(srcDir, 'plugin'), path.join(fsDir, 'plugin'));
  copyMd(path.join(srcDir, 'agent'), path.join(fsDir, 'agent'));
  copyMd(path.join(srcDir, 'command'), path.join(fsDir, 'command'));

  const files = walk(fsDir)
    .map((file) => {
      const content = fs.readFileSync(file);
      return {
        path: path.relative(fsDir, file).split(path.sep).join('/'),
        sha256: sha256(content),
        size: content.byteLength,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) throw new Error(`${kit.kit}: 构建产物为空，检查源目录`);
  const entryCount = files.filter((file) => !file.path.includes('/chunks/')).length;

  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(
      {
        kit: kit.kit,
        kitVersion: kit.kitVersion,
        stateDir: kit.stateDir ?? `.${kit.kit.replace(/[^a-z0-9]/g, '')}`,
        builtAt: new Date().toISOString(),
        files,
      },
      null,
      2,
    )}\n`,
  );

  const total = files.reduce((sum, file) => sum + file.size, 0);
  console.log(
    `${tag} ${kit.kit}@${kit.kitVersion} → ${path.relative(root, outDir)}：` +
      `${entryCount} 个文件 + ${files.length - entryCount} 个共享 chunk，${(total / 1024).toFixed(1)} KB`,
  );
}

async function main() {
  const kits = discoverKits();
  if (kits.length === 0) throw new Error('agentkit 下没有任何套件');
  for (const kit of kits) await buildKit(kit);
}

main().catch((error) => {
  console.error('[agentkit] 构建失败:', error);
  process.exit(1);
});
