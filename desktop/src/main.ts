import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, session, type WebContents } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';

const currentDir = __dirname;
const applicationRoot = path.resolve(currentDir, '..');
const frontendDist = path.join(applicationRoot, 'resources', 'frontend');
const backendModuleUrl = pathToFileURL(path.join(applicationRoot, 'resources', 'backend', 'app.cjs')).href;
const userDataOverride = process.env.H5_SCORM_USER_DATA_DIR;
const isHeadlessVerification = process.env.H5_SCORM_TEST_HEADLESS === '1';

if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

let mainWindow: BrowserWindow | null = null;
let internalServer: Server | null = null;
let internalOrigin = '';

type BackendModule = {
  createApp(options: {
    frontendDist: string;
    editorToken: string;
    enableCors: boolean;
  }): {
    listen(port: number, host: string, callback: () => void): Server;
  };
};

type ImportedBackendModule = Partial<BackendModule> & { default?: Partial<BackendModule> };

async function startInternalServer(): Promise<string> {
  const courseDataDir = path.join(app.getPath('userData'), 'courses');
  await mkdir(courseDataDir, { recursive: true });
  process.env.COURSE_DATA_DIR = courseDataDir;

  const backendModule = await import(backendModuleUrl) as ImportedBackendModule;
  const createApp = backendModule.createApp ?? backendModule.default?.createApp;
  if (!createApp) throw new Error('桌面课程服务未正确打包。');
  const editorToken = randomBytes(32).toString('hex');
  const expressApp = createApp({ frontendDist, editorToken, enableCors: false });

  internalServer = await new Promise<Server>((resolve, reject) => {
    const server = expressApp.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });

  const address = internalServer.address() as AddressInfo | null;
  if (!address) throw new Error('无法确定桌面服务端口。');
  internalOrigin = `http://127.0.0.1:${address.port}`;
  const readyFile = process.env.H5_SCORM_TEST_READY_FILE;
  if (readyFile) {
    await writeFile(readyFile, `${JSON.stringify({ origin: internalOrigin, pid: process.pid })}\n`, 'utf8');
  }
  console.log(`[desktop] Internal editor ready at ${internalOrigin}`);
  return internalOrigin;
}

function isInternalNavigation(targetUrl: string): boolean {
  try {
    return new URL(targetUrl).origin === internalOrigin;
  } catch {
    return false;
  }
}

function secureWebContents(contents: WebContents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, targetUrl) => {
    if (!isInternalNavigation(targetUrl)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function registerDownloadDialog() {
  session.defaultSession.on('will-download', (event, item) => {
    const options = {
      title: '导出 SCORM 课程包',
      defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
      filters: [{ name: 'SCORM ZIP 课程包', extensions: ['zip'] }],
    };
    const savePath = mainWindow
      ? dialog.showSaveDialogSync(mainWindow, options)
      : dialog.showSaveDialogSync(options);
    if (!savePath) {
      event.preventDefault();
      return;
    }
    item.setSavePath(savePath);
  });
}

async function createMainWindow() {
  const editorUrl = await startInternalServer();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  registerDownloadDialog();

  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#e9eef5',
    title: 'H5 SCORM Editor',
    icon: path.join(applicationRoot, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(currentDir, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  secureWebContents(mainWindow.webContents);
  if (!isHeadlessVerification) mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(editorUrl);
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function stopInternalServer() {
  internalServer?.close();
  internalServer = null;
}

if (squirrelStartup) {
  app.quit();
} else {
  app.setAppUserModelId('com.internal.h5scormeditor');
  const hasSingleInstanceLock = app.requestSingleInstanceLock();

  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', focusMainWindow);
    app.whenReady()
      .then(createMainWindow)
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : '桌面应用启动失败。';
        await dialog.showMessageBox({ type: 'error', title: 'H5 SCORM Editor', message });
        app.quit();
      });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
      else focusMainWindow();
    });
    app.on('before-quit', stopInternalServer);
    app.on('window-all-closed', () => app.quit());
  }
}
