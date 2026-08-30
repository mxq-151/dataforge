{
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');
  const JAVA = '/opt/homebrew/Cellar/openjdk@17/17.0.19/libexec/openjdk.jdk/Contents/Home/bin/java';
  const JDT = '/tmp/jdt140';
  const launcher = fs.readdirSync(path.join(JDT, 'plugins')).find(n => n.startsWith('org.eclipse.equinox.launcher_') && n.endsWith('.jar'));
  const data = '/tmp/jdt140run';
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(path.join(data, 'config'), { recursive: true });
  fs.cpSync(path.join(JDT, 'config_mac'), path.join(data, 'config'), { recursive: true });
  const args = [
    '-Declipse.application=org.eclipse.jdt.ls.core.id1',
    '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product',
    '-Dlog.protocol=true', '-Dlog.level=ALL',
    '-Xmx1G', '--add-modules=ALL-SYSTEM',
    '--add-opens', 'java.base/java.util=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '-Dfile.encoding=utf8', '-Xms100m',
    '-Dmaxverse',
    '-jar', path.join(JDT, 'plugins', launcher),
    '-configuration', path.join(data, 'config'),
    '-data', data,
  ].filter(a => a !== '-Dmaxverse');
  const child = execFile(JAVA, args, { env: { ...process.env } });
  child.stderr.on('data', d => console.log('STDERR:', d.toString().slice(0, 200)));
  // 若 10s 内未崩溃（stderr 无 Application error / exit 13）即判定可用
  let alive = true;
  child.on('exit', (code) => { alive = false; console.log('EXIT code =', code); process.exit(code === 0 ? 0 : 3); });
  setTimeout(() => {
    if (alive) { console.log('ALIVE after 10s -> Java17 兼容 OK'); child.kill('SIGKILL'); process.exit(0); }
  }, 10000);
}