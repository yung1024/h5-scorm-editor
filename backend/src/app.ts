import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getMaintenance, updateText, updateImage, undoMaintenance, withCourseLock } from './maintenance.js';
import {
  CourseError,
  deleteRuntimePatch,
  exportScorm,
  getCourseDir,
  injectEditorBridge,
  importCourse,
  loadCourse,
  replaceImage,
  resolveCourseFile,
  resolvePreviewFile,
  saveCourse,
  upsertRuntimePatch,
} from './course-service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

export interface CreateAppOptions {
  frontendDist?: string;
  editorToken?: string;
  enableCors?: boolean;
}

function tokenMatches(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (options.enableCors !== false) app.use(cors());
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '20mb' }));

  const requireEditorToken = (request: Request, response: Response, next: NextFunction) => {
    if (!options.editorToken || tokenMatches(options.editorToken, request.get('x-h5-editor-token'))) {
      next();
      return;
    }
    response.status(403).json({ message: '桌面编辑会话已失效，请重启应用。' });
  };

  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/api/desktop-config', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ desktop: Boolean(options.editorToken), token: options.editorToken });
  });

  app.post('/api/courses/upload', requireEditorToken, upload.single('course'), async (request, response, next) => {
    try {
      if (!request.file) throw new CourseError('请选择 ZIP 课程包。');
      if (!request.file.originalname.toLowerCase().endsWith('.zip')) throw new CourseError('仅支持上传 .zip 文件。');
      response.status(201).json(await importCourse(request.file.buffer, request.file.originalname));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/courses/:courseId', requireEditorToken, async (request, response, next) => {
    try {
      response.json(await loadCourse(routeParam(request.params.courseId)));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/courses/:courseId/maintenance', requireEditorToken, async (request, response, next) => {
    try { response.json(await withCourseLock(routeParam(request.params.courseId), () => getMaintenance(routeParam(request.params.courseId)))); }
    catch (error) { next(error); }
  });

  app.put('/api/courses/:courseId/maintenance/text', requireEditorToken, async (request, response, next) => {
    try {
      const { file, id, revision, text } = request.body;
      if ([file, id, revision, text].some(value => typeof value !== 'string')) throw new CourseError('文案修改格式无效。');
      const courseId = routeParam(request.params.courseId);
      await withCourseLock(courseId, () => updateText(courseId, { file, id, revision, text }));
      response.json({ message: '文案已保存。' });
    } catch (error) { next(error); }
  });

  app.post('/api/courses/:courseId/maintenance/image', requireEditorToken, upload.single('image'), async (request, response, next) => {
    try {
      if (!request.file || typeof request.body.file !== 'string' || typeof request.body.revision !== 'string') throw new CourseError('请选择要替换的图片。');
      const courseId = routeParam(request.params.courseId);
      const buffer = request.file.buffer;
      await withCourseLock(courseId, () => updateImage(courseId, request.body.file, request.body.revision, buffer));
      response.json({ message: '图片已替换，所有使用这张图片的位置会同步更新。' });
    } catch (error) { next(error); }
  });

  app.post('/api/courses/:courseId/maintenance/undo', requireEditorToken, async (request, response, next) => {
    try {
      const courseId = routeParam(request.params.courseId);
      await withCourseLock(courseId, () => undoMaintenance(courseId));
      response.json({ message: '已撤销最近一次修改。' });
    } catch (error) { next(error); }
  });

  app.put('/api/courses/:courseId', requireEditorToken, async (request, response, next) => {
    try {
      const { html, css } = request.body as { html?: unknown; css?: unknown };
      if (typeof html !== 'string' || typeof css !== 'string') throw new CourseError('保存内容格式无效。');
      await saveCourse(routeParam(request.params.courseId), html, css);
      response.json({ message: '课程已保存。' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/courses/:courseId/assets', requireEditorToken, upload.single('image'), async (request, response, next) => {
    try {
      if (!request.file) throw new CourseError('请选择要替换的图片。');
      if (!request.file.mimetype.startsWith('image/')) throw new CourseError('只能上传图片文件。');
      response.status(201).json(await replaceImage(
        routeParam(request.params.courseId),
        typeof request.body.targetPath === 'string' ? request.body.targetPath : undefined,
        request.file,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/courses/:courseId/runtime-patches', requireEditorToken, async (request, response, next) => {
    try {
      const { id, documentPath, selector, originalText, replacementText, textMode } = request.body as Record<string, unknown>;
      if (
        (id !== undefined && typeof id !== 'string')
        || typeof documentPath !== 'string'
        || typeof selector !== 'string'
        || typeof originalText !== 'string'
        || typeof replacementText !== 'string'
        || (textMode !== 'element' && textMode !== 'direct')
      ) throw new CourseError('运行时文字修改格式无效。');
      response.json({ patches: await upsertRuntimePatch(routeParam(request.params.courseId), {
        id, documentPath, selector, originalText, replacementText, textMode,
      }) });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/courses/:courseId/runtime-patches/:patchId', requireEditorToken, async (request, response, next) => {
    try {
      response.json({ patches: await deleteRuntimePatch(
        routeParam(request.params.courseId),
        routeParam(request.params.patchId),
      ) });
    } catch (error) {
      next(error);
    }
  });

  const sendPreview = async (request: Request, response: Response, next: NextFunction, relativePath?: string) => {
    try {
      const file = await resolvePreviewFile(routeParam(request.params.courseId), relativePath);
      response.setHeader('Cache-Control', 'no-store');
      if (/\.html?$/i.test(file)) {
        const documentPath = path.relative(getCourseDir(routeParam(request.params.courseId)), file).replaceAll('\\', '/');
        response.type('html').send(injectEditorBridge(
          routeParam(request.params.courseId),
          documentPath,
          await readFile(file, 'utf8'),
        ));
        return;
      }
      response.sendFile(file, (error) => {
        if (error && !response.headersSent) next(new CourseError('课程预览资源不存在。', 404));
      });
    } catch (error) {
      next(error);
    }
  };

  app.get('/api/courses/:courseId/preview', (request, response, next) => {
    void sendPreview(request, response, next);
  });

  app.get('/api/courses/:courseId/preview/*', (request, response, next) => {
    const wildcardValue = (request.params as unknown as Record<string, string | string[]>)[0] ?? '';
    void sendPreview(request, response, next, routeParam(wildcardValue));
  });

  app.get('/api/courses/:courseId/files/*', async (request, response, next) => {
    try {
      const wildcardValue = (request.params as unknown as Record<string, string | string[]>)[0] ?? '';
      const file = resolveCourseFile(routeParam(request.params.courseId), routeParam(wildcardValue));
      response.setHeader('Cache-Control', 'no-store');
      response.sendFile(file, (error) => {
        if (error && !response.headersSent) next(new CourseError('课程资源不存在。', 404));
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/courses/:courseId/export', requireEditorToken, async (request, response, next) => {
    try {
      const result = await exportScorm(routeParam(request.params.courseId));
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`);
      response.send(result.buffer);
    } catch (error) {
      next(error);
    }
  });

  const frontendDist = options.frontendDist ?? path.resolve(process.cwd(), '../frontend/dist');
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get('*', (_request, response) => response.sendFile(path.join(frontendDist, 'index.html')));
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      response.status(413).json({ message: '课程包不能超过 100 MB。' });
      return;
    }
    const status = error instanceof CourseError ? error.status : 500;
    const message = error instanceof Error ? error.message : '服务器处理失败。';
    if (status >= 500) console.error(error);
    response.status(status).json({ message });
  });

  return app;
}
