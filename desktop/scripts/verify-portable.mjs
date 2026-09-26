import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const sourcePackage = path.resolve(
  process.env.H5_SCORM_PORTABLE_SOURCE
    || path.join(desktopRoot, 'out', 'H5 SCORM Editor-win32-x64'),
);
const courseZip = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'h5-scorm-editor-portable-'));
const isolatedPackage = path.join(temporaryRoot, 'application');
const isolatedUserData = path.join(temporaryRoot, 'user-data');
const readyFile = path.join(temporaryRoot, 'ready.json');
let child;

async function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(readyFile, 'utf8'));
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('隔离桌面程序在 30 秒内未完成启动。');
}

try {
  await stat(path.join(sourcePackage, 'H5SCORMEditor.exe'));
  if (courseZip) await stat(courseZip);
  await cp(sourcePackage, isolatedPackage, { recursive: true });

  const childEnvironment = {
    ...process.env,
    H5_SCORM_TEST_HEADLESS: '1',
    H5_SCORM_TEST_READY_FILE: readyFile,
    H5_SCORM_USER_DATA_DIR: isolatedUserData,
    NODE_PATH: '',
  };
  delete childEnvironment.NODE_OPTIONS;
  delete childEnvironment.ELECTRON_RUN_AS_NODE;

  child = spawn(path.join(isolatedPackage, 'H5SCORMEditor.exe'), [], {
    env: childEnvironment,
    stdio: 'ignore',
    windowsHide: true,
  });

  const { origin } = await waitForReady();
  const rootResponse = await fetch(`${origin}/`);
  const configResponse = await fetch(`${origin}/api/desktop-config`);
  const config = await configResponse.json();
  const unauthorizedResponse = await fetch(`${origin}/api/courses/not-found`);
  const report = {
    isolatedFromProject: !isolatedPackage.startsWith(desktopRoot),
    rootStatus: rootResponse.status,
    desktopSession: config.desktop === true && typeof config.token === 'string' && config.token.length === 64,
    unauthorizedStatus: unauthorizedResponse.status,
    courseRegression: null,
  };

  if (courseZip) {
    const form = new FormData();
    form.append('course', new Blob([await readFile(courseZip)], { type: 'application/zip' }), path.basename(courseZip));
    const uploadResponse = await fetch(`${origin}/api/courses/upload`, {
      method: 'POST',
      headers: { 'X-H5-Editor-Token': config.token },
      body: form,
    });
    const uploaded = await uploadResponse.json();
    if (!uploadResponse.ok) throw new Error(uploaded.message || '真实 SCORM 导入失败。');

    const maintenanceUrl = `${origin}/api/courses/${uploaded.courseId}/maintenance`;
    const maintenance = await (await fetch(maintenanceUrl, { headers: { 'X-H5-Editor-Token': config.token } })).json();
    const candidate = maintenance.texts?.[0];
    if (!candidate) throw new Error('独立桌面包未能识别可编辑文案。');
    const maintenanceSave = await fetch(`${maintenanceUrl}/text`, {
      method: 'PUT', headers: { 'X-H5-Editor-Token': config.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...candidate, text: `${candidate.text}（验证）` }),
    });
    if (!maintenanceSave.ok) throw new Error('独立桌面包文案保存失败。');
    const maintenanceUndo = await fetch(`${maintenanceUrl}/undo`, { method: 'POST', headers: { 'X-H5-Editor-Token': config.token } });
    if (!maintenanceUndo.ok) throw new Error('独立桌面包文案撤销失败。');

    const exportResponse = await fetch(`${origin}/api/courses/${uploaded.courseId}/export`, {
      headers: { 'X-H5-Editor-Token': config.token },
    });
    const exportBuffer = await exportResponse.arrayBuffer();
    const archive = await JSZip.loadAsync(exportBuffer);
    const names = Object.keys(archive.files);
    report.courseRegression = {
      uploadStatus: uploadResponse.status,
      exportStatus: exportResponse.status,
      launchPath: uploaded.launchPath,
      editPath: uploaded.editPath,
      hasManifest: names.includes('imsmanifest.xml'),
      hasLauncher: names.includes(uploaded.launchPath),
      hasEditableEntry: names.includes(uploaded.editPath),
      exportedBytes: exportBuffer.byteLength,
      maintenanceTextCount: maintenance.texts.length,
      maintenanceImageCount: maintenance.images.length,
      maintenanceSaveStatus: maintenanceSave.status,
      maintenanceUndoStatus: maintenanceUndo.status,
    };
  }

  const passed = report.rootStatus === 200
    && report.desktopSession
    && report.unauthorizedStatus === 403
    && (!report.courseRegression
      || (report.courseRegression.uploadStatus === 201
        && report.courseRegression.exportStatus === 200
        && report.courseRegression.hasManifest
        && report.courseRegression.hasLauncher
        && report.courseRegression.hasEditableEntry));
  if (!passed) throw new Error(`隔离回归未通过：${JSON.stringify(report)}`);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (child?.pid) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // The application might already have exited; cleanup still continues.
    }
  }
  if (path.dirname(path.resolve(temporaryRoot)) !== path.resolve(os.tmpdir()) || !path.basename(temporaryRoot).startsWith('h5-scorm-editor-portable-')) throw new Error('临时验证目录校验失败。');
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}
