import { api } from '@electron-forge/core';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const packageJson = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
const version = String(packageJson.version);
const releaseRoot = path.join(desktopRoot, 'releases', `v${version}`);

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

if (await pathExists(releaseRoot)) {
  throw new Error(`发布目录已存在：${releaseRoot}\n请递增 desktop/package.json 版本号后重新构建，以免覆盖历史安装包。`);
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'h5-scorm-editor-make-'));
const temporaryOutput = path.join(temporaryRoot, 'out');
const temporaryIcon = path.join(temporaryRoot, 'icon.ico');

try {
  await copyFile(path.join(desktopRoot, 'assets', 'icon.ico'), temporaryIcon);
  process.env.H5_SCORM_ICON_PATH = temporaryIcon;

  const results = await api.make({
    dir: desktopRoot,
    outDir: temporaryOutput,
    interactive: false,
    platform: 'win32',
    arch: 'x64',
  });

  const artifacts = results.flatMap((result) => result.artifacts ?? []);
  if (artifacts.length === 0) throw new Error('安装包构建未生成任何交付物。');

  await mkdir(releaseRoot, { recursive: true });
  for (const artifact of artifacts) {
    const target = path.join(releaseRoot, path.basename(artifact));
    const artifactStat = await stat(artifact);
    if (artifactStat.isDirectory()) {
      await cp(artifact, target, { recursive: true });
    } else {
      await copyFile(artifact, target);
    }
  }

  await writeFile(path.join(releaseRoot, 'build-info.json'), `${JSON.stringify({
    productName: packageJson.productName,
    version,
    platform: 'win32',
    arch: 'x64',
    createdAt: new Date().toISOString(),
    artifacts: artifacts.map((artifact) => path.basename(artifact)),
  }, null, 2)}\n`, 'utf8');

  process.stdout.write(`Windows 安装包已生成：${releaseRoot}\n`);
} finally {
  delete process.env.H5_SCORM_ICON_PATH;
  if (path.dirname(path.resolve(temporaryRoot)) !== path.resolve(os.tmpdir()) || !path.basename(temporaryRoot).startsWith('h5-scorm-editor-make-')) throw new Error('临时打包目录校验失败。');
  await rm(temporaryRoot, { recursive: true, force: true });
}
