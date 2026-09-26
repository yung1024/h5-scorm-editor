import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { Response as SuperAgentResponse } from 'superagent';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

let tempRoot: string;

const parseBinary = (response: SuperAgentResponse, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', (error: Error) => callback(error, Buffer.alloc(0)));
};

async function courseZip(options: { includeIndex?: boolean; manifest?: string } = {}) {
  const zip = new JSZip();
  if (options.includeIndex !== false) {
    zip.file('course/index.html', '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="css/style.css"><script src="js/head.js"></script></head><body class="course-page" style="min-height:100vh"><h1>原始标题</h1><div class="hero">背景区域</div><img src="images/test.png"><script src="js/course.js"></script></body></html>');
  }
  zip.file('course/css/style.css', '@import "theme/base.css";body{color:#123456}.hero{background:linear-gradient(#0004,#0004),url(../images/test.png) center/cover}');
  zip.file('course/css/theme/base.css', ':root{--course-surface:#ffffff}.course-page{background-color:var(--course-surface)}');
  zip.file('course/js/head.js', 'window.headLoaded = true;');
  zip.file('course/js/course.js', 'window.courseLoaded = true;');
  zip.file('course/images/test.png', Buffer.from('old-image'));
  if (options.manifest) zip.file('course/imsmanifest.xml', options.manifest);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function nestedScormZip() {
  const zip = new JSZip();
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="nested-course" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <organizations default="ORG"><organization identifier="ORG"><title>嵌套课程</title><item identifier="ITEM" identifierref="RES"><title>测验</title></item></organization></organizations>
  <resources><resource identifier="RES" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources>
</manifest>`;
  zip.file('imsmanifest.xml', manifest);
  zip.file('index.html', '<!doctype html><html><body><div id="loading">正在加载课程…</div><iframe id="scorm-content" src="about:blank"></iframe><script src="scorm-runtime.js"></script></body></html>');
  zip.file('scorm-runtime.js', 'const config={"scormVersion":"1.2","contentUrl":"content/index.html"};document.querySelector("#scorm-content").src=config.contentUrl;');
  zip.file('content/index.html', '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main><h1>课程A课后测试</h1><img src="images/test.png"><button id="start">开始答题</button></main><script src="questions.js"></script><script src="quiz.js"></script></body></html>');
  zip.file('content/styles.css', 'body{color:#102a43}.cover{background:url(images/test.png)}');
  zip.file('content/questions.js', 'window.questions=[{title:"第一题"}];');
  zip.file('content/quiz.js', 'document.querySelector("#start")?.addEventListener("click",()=>document.body.dataset.started="true");');
  zip.file('content/images/test.png', Buffer.from('nested-image'));
  return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), manifest };
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'h5-scorm-editor-test-'));
  process.env.COURSE_DATA_DIR = tempRoot;
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  delete process.env.COURSE_DATA_DIR;
});

describe('课程 API 完整流程', () => {
  it('桌面模式仅允许当前编辑会话修改课程', async () => {
    const editorToken = 'desktop-test-token';
    const app = createApp({ editorToken, enableCors: false });

    const config = await request(app).get('/api/desktop-config');
    expect(config.status).toBe(200);
    expect(config.body).toEqual({ desktop: true, token: editorToken });
    expect(config.headers['access-control-allow-origin']).toBeUndefined();

    const rejected = await request(app)
      .post('/api/courses/upload')
      .attach('course', await courseZip(), 'unauthorized.zip');
    expect(rejected.status).toBe(403);

    const accepted = await request(app)
      .post('/api/courses/upload')
      .set('X-H5-Editor-Token', editorToken)
      .attach('course', await courseZip(), 'authorized.zip');
    expect(accepted.status).toBe(201);
  });

  it('网页开发模式保持原有无令牌调用方式', async () => {
    const app = createApp();
    const config = await request(app).get('/api/desktop-config');
    expect(config.status).toBe(200);
    expect(config.body).toEqual({ desktop: false });

    const uploaded = await request(app)
      .post('/api/courses/upload')
      .attach('course', await courseZip(), 'web-mode.zip');
    expect(uploaded.status).toBe(201);
  });

  it('拒绝没有 index.html 的压缩包', async () => {
    const response = await request(createApp())
      .post('/api/courses/upload')
      .attach('course', await courseZip({ includeIndex: false }), 'invalid.zip');

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('index.html');
  });

  it('上传、解析、替换图片、保存并导出 SCORM 1.2', async () => {
    const app = createApp();
    const uploaded = await request(app)
      .post('/api/courses/upload')
      .attach('course', await courseZip(), '人工智能课程.zip');

    expect(uploaded.status).toBe(201);
    expect(uploaded.body.entryMode).toBe('static');
    expect(uploaded.body.launchPath).toBe('index.html');
    expect(uploaded.body.editPath).toBe('index.html');
    expect(uploaded.body.html).toContain(`/api/courses/${uploaded.body.courseId}/files/images/test.png`);
    expect(uploaded.body.css).toBe('');
    expect(uploaded.body.sourceCss).toContain(`/api/courses/${uploaded.body.courseId}/files/images/test.png`);
    expect(uploaded.body.sourceCss).toContain('--course-surface');
    expect(uploaded.body.sourceCss).toContain('#123456');
    expect(uploaded.body.htmlAttributes.lang).toBe('zh-CN');
    expect(uploaded.body.bodyAttributes.class).toBe('course-page');

    const courseId = uploaded.body.courseId as string;
    const replaced = await request(app)
      .post(`/api/courses/${courseId}/assets`)
      .field('targetPath', `/api/courses/${courseId}/files/images/test.png`)
      .attach('image', Buffer.from('new-image'), { filename: 'new.png', contentType: 'image/png' });
    expect(replaced.status).toBe(201);
    expect(replaced.body.path).toBe('images/test.png');

    const saved = await request(app)
      .put(`/api/courses/${courseId}`)
      .send({
        html: `<h1>修改后的标题</h1><img src="/api/courses/${courseId}/files/images/test.png">`,
        css: '.edited{font-size:24px}',
      });
    expect(saved.status).toBe(200);

    const exported = await request(app).get(`/api/courses/${courseId}/export`).buffer(true).parse(parseBinary);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('application/zip');
    const archive = await JSZip.loadAsync(exported.body as Buffer);
    expect(Object.keys(archive.files)).toEqual(expect.arrayContaining([
      'index.html', 'editor.css', 'css/style.css', 'css/theme/base.css', 'images/test.png', 'js/head.js', 'js/course.js', 'imsmanifest.xml',
    ]));
    const index = await archive.file('index.html')!.async('string');
    const manifest = await archive.file('imsmanifest.xml')!.async('string');
    expect(index).toContain('修改后的标题');
    expect(index).toContain('images/test.png');
    expect(index).toContain('js/head.js');
    expect(index).toContain('js/course.js');
    expect(manifest).toContain('adlcp:scormtype="sco"');
    expect(manifest).toContain('href="index.html"');
    expect(await archive.file('images/test.png')!.async('string')).toBe('new-image');
  });

  it('优先保留原有 imsmanifest.xml', async () => {
    const existing = '<?xml version="1.0"?><manifest identifier="existing"></manifest>';
    const app = createApp();
    const uploaded = await request(app)
      .post('/api/courses/upload')
      .attach('course', await courseZip({ manifest: existing }), 'existing.zip');
    const exported = await request(app).get(`/api/courses/${uploaded.body.courseId}/export`).buffer(true).parse(parseBinary);
    expect(exported.status).toBe(200);
    const archive = await JSZip.loadAsync(exported.body as Buffer);
    expect(await archive.file('imsmanifest.xml')!.async('string')).toBe(existing);
  });

  it('自动升级旧版课程元数据并重新识别嵌套正文', async () => {
    const app = createApp();
    const fixture = await nestedScormZip();
    const uploaded = await request(app)
      .post('/api/courses/upload')
      .attach('course', fixture.buffer, 'legacy.zip');
    const courseId = uploaded.body.courseId as string;
    const metaFile = path.join(tempRoot, courseId, '.course.json');
    await writeFile(metaFile, JSON.stringify({
      courseId,
      name: Buffer.from('课程A', 'utf8').toString('latin1'),
      indexPath: 'index.html',
      uploadedAt: new Date().toISOString(),
    }), 'utf8');

    const reloaded = await request(app).get(`/api/courses/${courseId}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.launchPath).toBe('index.html');
    expect(reloaded.body.editPath).toBe('content/index.html');
    expect(reloaded.body.name).toBe('课程A');
    expect(reloaded.body.html).toContain('课程A课后测试');
    const upgradedMeta = JSON.parse(await readFile(metaFile, 'utf8')) as { editPath?: string };
    expect(upgradedMeta.editPath).toBe('content/index.html');
  });

  it('识别 SCORM 启动壳并编辑嵌套正文，同时保留运行结构', async () => {
    const app = createApp();
    const fixture = await nestedScormZip();
    const uploaded = await request(app)
      .post('/api/courses/upload')
      .attach('course', fixture.buffer, '课程A_独立课后测试_SCORM12_v1.0.1.zip');

    expect(uploaded.status).toBe(201);
    expect(uploaded.body.name).toBe('课程A_独立课后测试_SCORM12_v1.0.1');
    expect(uploaded.body.launchPath).toBe('index.html');
    expect(uploaded.body.editPath).toBe('content/index.html');
    expect(uploaded.body.indexPath).toBe('content/index.html');
    expect(uploaded.body.entryMode).toBe('nested');
    expect(uploaded.body.entryReason).toBe('launcher-script');
    expect(uploaded.body.html).toContain('课程A课后测试');
    expect(uploaded.body.html).not.toContain('scorm-content');
    expect(uploaded.body.html).toContain(`/files/content/images/test.png`);
    expect(uploaded.body.sourceCss).toContain(`/files/content/images/test.png`);

    const courseId = uploaded.body.courseId as string;
    const launchPreview = await request(app).get(`/api/courses/${courseId}/preview/`);
    const contentPreview = await request(app).get(`/api/courses/${courseId}/preview/content/index.html`);
    const runtimePreview = await request(app).get(`/api/courses/${courseId}/preview/scorm-runtime.js`);
    expect(launchPreview.status).toBe(200);
    expect(launchPreview.text).toContain('scorm-content');
    expect(contentPreview.status).toBe(200);
    expect(contentPreview.text).toContain('课程A课后测试');
    expect(contentPreview.text).toContain('h5-editor-preview-bridge');
    expect(runtimePreview.status).toBe(200);
    expect(runtimePreview.text).toContain('content/index.html');

    const replaced = await request(app)
      .post(`/api/courses/${courseId}/assets`)
      .field('targetPath', `/api/courses/${courseId}/files/content/images/test.png`)
      .attach('image', Buffer.from('updated-nested-image'), { filename: 'new.png', contentType: 'image/png' });
    expect(replaced.status).toBe(201);
    expect(replaced.body.path).toBe('content/images/test.png');

    const saved = await request(app)
      .put(`/api/courses/${courseId}`)
      .send({
        html: `<main><h1>修改后的课后测试</h1><img src="/api/courses/${courseId}/files/content/images/test.png"></main>`,
        css: `.edited{background-image:url('/api/courses/${courseId}/files/content/images/test.png')}`,
      });
    expect(saved.status).toBe(200);

    const exported = await request(app).get(`/api/courses/${courseId}/export`).buffer(true).parse(parseBinary);
    const archive = await JSZip.loadAsync(exported.body as Buffer);
    expect(Object.keys(archive.files)).toEqual(expect.arrayContaining([
      'imsmanifest.xml', 'index.html', 'scorm-runtime.js', 'content/index.html', 'content/editor.css',
      'content/styles.css', 'content/questions.js', 'content/quiz.js', 'content/images/test.png',
    ]));
    const launch = await archive.file('index.html')!.async('string');
    const editedContent = await archive.file('content/index.html')!.async('string');
    const editorCss = await archive.file('content/editor.css')!.async('string');
    expect(launch).toContain('scorm-runtime.js');
    expect(launch).toContain('scorm-content');
    expect(editedContent).toContain('修改后的课后测试');
    expect(editedContent).toContain('images/test.png');
    expect(editedContent).toContain('questions.js');
    expect(editedContent).toContain('quiz.js');
    expect(editorCss).toContain('images/test.png');
    expect(editorCss).not.toContain('content/images/test.png');
    const exportedManifest = await archive.file('imsmanifest.xml')!.async('string');
    expect(exportedManifest).toContain('identifier="nested-course"');
    expect(exportedManifest).toContain('href="content/editor.css"');
    expect(await archive.file('content/images/test.png')!.async('string')).toBe('updated-nested-image');
  });

  it('保存跨交互状态的运行时文字补丁，并随 SCORM 导出', async () => {
    const app = createApp();
    const fixture = await nestedScormZip();
    const uploaded = await request(app)
      .post('/api/courses/upload')
      .attach('course', fixture.buffer, 'runtime-text.zip');
    const courseId = uploaded.body.courseId as string;

    const savedPatch = await request(app)
      .post(`/api/courses/${courseId}/runtime-patches`)
      .send({
        documentPath: 'content/index.html',
        selector: '#question-heading',
        originalText: '第一题',
        replacementText: '修改后的第一题',
        textMode: 'element',
      });
    expect(savedPatch.status).toBe(200);
    expect(savedPatch.body.patches).toHaveLength(1);

    const contentPreview = await request(app).get(`/api/courses/${courseId}/preview/content/index.html`);
    expect(contentPreview.text).toContain('h5-editor-preview-bridge');
    expect(contentPreview.text).toContain('content/index.html');

    const exported = await request(app).get(`/api/courses/${courseId}/export`).buffer(true).parse(parseBinary);
    const archive = await JSZip.loadAsync(exported.body as Buffer);
    const content = await archive.file('content/index.html')!.async('string');
    const runtime = await archive.file('h5-editor-runtime-patches.js')!.async('string');
    expect(content).toContain('../h5-editor-runtime-patches.js');
    expect(content).toContain('data-h5-document-path="content/index.html"');
    expect(runtime).toContain('修改后的第一题');
    expect(archive.file('.h5-editor-runtime-patches.json')).not.toBeNull();
    const importedAgain = await request(app).post('/api/courses/upload').attach('course', exported.body as Buffer, 'again.zip');
    expect(importedAgain.body.runtimePatches).toHaveLength(1);

    const patchId = savedPatch.body.patches[0].id as string;
    const deleted = await request(app).delete(`/api/courses/${courseId}/runtime-patches/${patchId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.patches).toEqual([]);
  });

  it('背景替换支持绝对资源 URL，并阻止覆盖非图片文件', async () => {
    const app = createApp();
    const uploaded = await request(app)
      .post('/api/courses/upload')
      .attach('course', await courseZip(), 'background.zip');
    const courseId = uploaded.body.courseId as string;
    const absolute = `http://localhost/api/courses/${courseId}/files/images/test.png`;
    const replaced = await request(app)
      .post(`/api/courses/${courseId}/assets`)
      .field('targetPath', absolute)
      .attach('image', Buffer.from('absolute-background'), { filename: 'new.png', contentType: 'image/png' });
    expect(replaced.status).toBe(201);
    expect(replaced.body.path).toBe('images/test.png');

    const rejected = await request(app)
      .post(`/api/courses/${courseId}/assets`)
      .field('targetPath', `/api/courses/${courseId}/files/index.html`)
      .attach('image', Buffer.from('bad'), { filename: 'new.png', contentType: 'image/png' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.message).toContain('不是可替换的图片');
  });
});
