import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const projectRoot = path.resolve(desktopRoot, '..');
const resourcesRoot = path.resolve(desktopRoot, 'resources');

if (path.dirname(resourcesRoot) !== desktopRoot) {
  throw new Error('桌面资源目录校验失败。');
}

await rm(resourcesRoot, { recursive: true, force: true });
await mkdir(resourcesRoot, { recursive: true });
await cp(path.join(projectRoot, 'frontend', 'dist'), path.join(resourcesRoot, 'frontend'), { recursive: true });
await mkdir(path.join(resourcesRoot, 'backend'), { recursive: true });
await build({
  entryPoints: [path.join(projectRoot, 'backend', 'dist', 'app.js')],
  outfile: path.join(resourcesRoot, 'backend', 'app.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  packages: 'bundle',
  logLevel: 'warning',
});

process.stdout.write('桌面运行资源已准备完成（后端已自包含）。\n');
