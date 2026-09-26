import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import JSZip from 'jszip';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { exportScorm, getCourseDir } from '../src/course-service.js';

let tempRoot: string;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const page = '<!doctype html><html><head><title>第二章</title></head><body><p>这是<strong>原始重点</strong>说明。</p><img src="images/test.png"><script>window.keep = "保持脚本";</script></body></html>';
const data = 'window.COURSE={id:"course-id",title:"课程标题",chapters:[{id:"chapter-2",title:"第二章标题",blocks:[{type:"quiz",question:"原始问题",options:["选项一","选项二"],answer:1,feedback:"<strong>反馈重点</strong>请重新选择"}]}]};';
const renderer = 'window.render = () => `<h1>${window.COURSE.title}</h1><p>固定介绍文案</p><b>${1+2}</b>`;';
async function fixture() {
  const zip = new JSZip();
  zip.file('index.html', '<html><body><iframe src="chapter.html"></iframe></body></html>');
  zip.file('chapter.html', page);
  zip.file('assets/course-data.js', data);
  zip.file('assets/course.js', renderer);
  zip.file('images/test.png', png);
  zip.file('imsmanifest.xml', '<manifest identifier="retain-me"><organizations><organization identifier="ORG"><title>课程</title></organization></organizations><resources><resource identifier="R" href="index.html"><file href="index.html"/></resource></resources></manifest>');
  const response = await request(createApp()).post('/api/courses/upload').attach('course', await zip.generateAsync({ type: 'nodebuffer' }), '课程_v1.0.9.zip');
  expect(response.status).toBe(201);
  return response.body.courseId as string;
}
beforeAll(async () => { tempRoot = await mkdtemp(path.join(os.tmpdir(), 'maintenance-test-')); process.env.COURSE_DATA_DIR = tempRoot; });
afterAll(async () => { await rm(tempRoot, { recursive: true, force: true }); delete process.env.COURSE_DATA_DIR; });
const read = (id: string, file: string) => readFile(path.join(getCourseDir(id), file), 'utf8');

describe('跨章节文案与图片维护', () => {
  it('索引各页面和动态数据，不暴露脚本标识及答案；静态编辑保留嵌套结构并支持精确撤销', async () => {
    const id = await fixture(), app = createApp();
    const listing = await request(app).get(`/api/courses/${id}/maintenance`);
    expect(listing.body.pages).toHaveLength(2);
    expect(listing.body.images).toHaveLength(1);
    const strings = listing.body.texts.map((item: { text: string }) => item.text);
    expect(strings).toEqual(expect.arrayContaining(['原始重点', '课程标题', '原始问题', '选项一', '反馈重点', '固定介绍文案']));
    expect(strings).not.toEqual(expect.arrayContaining(['course-id']));
    expect(strings).not.toContain('quiz');
    expect(strings).not.toContain('保持脚本');
    const item = listing.body.texts.find((item: { text: string }) => item.text === '原始重点');
    expect((await request(app).put(`/api/courses/${id}/maintenance/text`).send({ ...item, text: '修改后的重点 <安全文字>' })).status).toBe(200);
    const saved = await read(id, 'chapter.html');
    expect(saved).toContain('<strong>修改后的重点 &lt;安全文字&gt;</strong>');
    expect(saved).toContain('window.keep = "保持脚本";');
    expect(saved).toContain('<img src="images/test.png">');
    expect((await request(app).put(`/api/courses/${id}/maintenance/text`).send({ ...item, text: '过时修改' })).status).toBe(409);
    expect((await request(app).post(`/api/courses/${id}/maintenance/undo`)).status).toBe(200);
    expect(await read(id, 'chapter.html')).toBe(page);
  });

  it('动态数据与模板按字符串保存，特殊字符不执行，导出后仍可再次编辑', async () => {
    const id = await fixture(), app = createApp();
    const listing = await request(app).get(`/api/courses/${id}/maintenance`);
    const title = listing.body.texts.find((item: { text: string }) => item.text === '第二章标题');
    const replacement = '新标题 "引号"\n反斜线\\与 ${alert(1)}';
    expect((await request(app).put(`/api/courses/${id}/maintenance/text`).send({ ...title, text: replacement })).status).toBe(200);
    const context = { window: {} as { COURSE: { chapters: Array<{ title: string; blocks: Array<{ answer: number }> }> }; render: () => string } };
    runInNewContext(await read(id, 'assets/course-data.js'), context);
    expect(context.window.COURSE.chapters[0].title).toBe(replacement);
    expect(context.window.COURSE.chapters[0].blocks[0].answer).toBe(1);
    const template = listing.body.texts.find((item: { text: string }) => item.text === '固定介绍文案');
    expect((await request(app).put(`/api/courses/${id}/maintenance/text`).send({ ...template, text: '新介绍 `模板` ${不会执行} <标签>' })).status).toBe(200);
    runInNewContext(await read(id, 'assets/course.js'), context);
    expect(context.window.render()).toContain('新介绍 `模板` ${不会执行} &lt;标签&gt;');
    expect(context.window.render()).toContain('<b>3</b>');
    const exported = await exportScorm(id);
    expect(exported.fileName).toBe('课程_v1.0.10.zip');
    const zip = await JSZip.loadAsync(exported.buffer);
    expect(Object.keys(zip.files).some(file => file.includes('.h5-editor-history'))).toBe(false);
    expect(await zip.file('imsmanifest.xml')!.async('string')).toContain('identifier="retain-me"');
    expect(await zip.file('imsmanifest.xml')!.async('string')).toContain('href="assets/course-data.js"');
    const again = await request(app).post('/api/courses/upload').attach('course', exported.buffer, exported.fileName);
    const reloaded = await request(app).get(`/api/courses/${again.body.courseId}/maintenance`);
    expect(reloaded.body.texts.some((item: { text: string }) => item.text === replacement)).toBe(true);
  });

  it('图片验证格式、检测冲突并支持撤销，修改端点保护桌面会话', async () => {
    const id = await fixture(), app = createApp();
    const listing = await request(app).get(`/api/courses/${id}/maintenance`);
    const item = listing.body.images[0];
    const endpoint = `/api/courses/${id}/maintenance/image`;
    const wrong = await request(app).post(endpoint).field('file', item.file).field('revision', item.revision).attach('image', Buffer.from('not png'), 'bad.jpg');
    expect(wrong.status).toBe(400);
    const changed = Buffer.concat([png, Buffer.from('new-image')]);
    expect((await request(app).post(endpoint).field('file', item.file).field('revision', item.revision).attach('image', changed, 'new.png')).status).toBe(200);
    expect(await readFile(path.join(getCourseDir(id), item.file))).toEqual(changed);
    expect((await request(app).post(endpoint).field('file', item.file).field('revision', item.revision).attach('image', png, 'old.png')).status).toBe(409);
    expect((await request(app).post(`/api/courses/${id}/maintenance/undo`)).status).toBe(200);
    expect(await readFile(path.join(getCourseDir(id), item.file))).toEqual(png);
    const secure = createApp({ editorToken: 'protected' });
    expect((await request(secure).get(`/api/courses/${id}/maintenance`)).status).toBe(403);
    expect((await request(secure).put(`/api/courses/${id}/maintenance/text`).send({})).status).toBe(403);
    expect((await request(secure).post(`/api/courses/${id}/maintenance/undo`)).status).toBe(403);
  });
});
