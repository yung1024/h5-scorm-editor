import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const distRoot = path.join(desktopRoot, 'dist');

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  external: ['electron'],
  logLevel: 'warning',
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [path.join(desktopRoot, 'src', 'main.ts')],
    outfile: path.join(distRoot, 'main.cjs'),
  }),
  build({
    ...shared,
    entryPoints: [path.join(desktopRoot, 'src', 'preload.ts')],
    outfile: path.join(distRoot, 'preload.cjs'),
  }),
]);

process.stdout.write('桌面主进程已构建为自包含 bundle。\n');
