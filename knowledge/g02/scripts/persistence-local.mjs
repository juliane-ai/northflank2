import { spawn } from 'node:child_process';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// npm loads .env. Only persistence variables cross into this diagnostic container.
const action = process.argv[2] || 'validate';
if (!['validate', 'probe', 'mirror'].includes(action)) throw new Error('Expected validate, probe or mirror');
const root = fileURLToPath(new URL('..', import.meta.url));
const mountArgs = ['--mount', `type=bind,src=${resolve(root, 'scripts/persistence/persist.py')},dst=/app/scripts/persistence/persist.py,readonly`];
if (action === 'mirror') {
  // A fixed ignored destination prevents accidental writes into active application data.
  for (const path of [resolve(root, 'data'), resolve(root, 'data/cloud-mirror')]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) {
      throw new Error('Cloud mirror destination must not contain symlinks');
    }
  }
  mountArgs.push('--mount', `type=bind,src=${resolve(root, 'data/cloud-mirror')},dst=/mirror`);
}
const keys = Object.keys(process.env).filter(key => key.startsWith('PERSIST_'));
const child = spawn('docker', ['run', '--rm', '--memory', '128m', '--memory-swap', '128m',
  ...keys.flatMap(key => ['-e', key]), ...mountArgs, '--entrypoint', 'python3',
  'okx-copy-research:webdav-local', '/app/scripts/persistence/persist.py', action,
  ...(action === 'mirror' ? ['/mirror'] : [])],
{ stdio: 'inherit' });
child.on('error', () => { console.error('无法启动 Docker 诊断容器'); process.exitCode = 1; });
child.on('exit', code => {
  process.exitCode = code ?? 1;
  if (code === 0 && action === 'mirror') console.log(`云端查看副本：${resolve(root, 'data/cloud-mirror/README.md')}`);
});
