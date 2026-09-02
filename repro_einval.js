const { spawn } = require('node:child_process');
const bin = 'C:/Users/57803/Desktop/apache-maven-3.9.16/bin/mvn.cmd';
try {
  const cp = spawn(bin, ['-v'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  cp.on('error', (e) => console.log('ASYNC ERROR:', e.code, e.errno, e.message));
  cp.on('close', (c) => console.log('CLOSE:', c));
} catch (e) {
  console.log('SYNC THROW:', e.code, e.errno, e.message);
}
