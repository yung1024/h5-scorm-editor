import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { AnyNode } from 'domhandler';
import path from 'node:path';
import * as cheerio from 'cheerio';
import ts from 'typescript';
import { CourseError, getCourseDir, resolveCourseFile } from './course-service.js';

const historyDir = '.h5-editor-history';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type TextItem = { id: string; file: string; section: string; text: string; revision: string; kind: 'page' | 'data' };
type EditableItem = TextItem & { replace: (value: string) => string };
type History = { id: string; file: string; label: string; after: string; createdAt: string };
const queues = new Map<string, Promise<unknown>>();

// Serialize edits and undo operations so a stale panel cannot overwrite another save.
export async function withCourseLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(id, current);
  try { return await current; } finally { if (queues.get(id) === current) queues.delete(id); }
}

async function filesIn(courseId: string, current = ''): Promise<string[]> {
  const entries = await readdir(resolveCourseFile(courseId, current));
  const result: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const file = path.posix.join(current, name);
    const info = await lstat(resolveCourseFile(courseId, file));
    if (info.isDirectory()) result.push(...await filesIn(courseId, file));
    else if (info.isFile()) result.push(file);
  }
  return result.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

const dataFile = (file: string) => /(?:^|\/)(?:course-data|questions)\.js$/i.test(file);
const contentScript = (file: string) => /\.js$/i.test(file) && !/(?:^|\/)(?:scorm-runtime|h5-editor-runtime-patches)\.js$/i.test(file);
const hasWords = (text: string) => /[\p{L}]/u.test(text) && text.trim().length > 0;
const machineField = /^(?:id|type|key|src|href|url|image|images|poster|icon|class|className|number|answer|correct|value|storageKey|progressKey)$/i;

function htmlItems(source: string, file: string, revision: string, fragment = false) {
  const $ = cheerio.load(source, undefined, !fragment);
  const items: Array<{ text: string; section: string; replace: (text: string) => string }> = [];
  const title = $('title').text() || $('h1').first().text() || path.posix.basename(file);
  function walk(node: AnyNode) {
    if (node.type === 'script' || node.type === 'style' || ('tagName' in node && /^(script|style|noscript|svg)$/i.test(String(node.tagName)))) return;
    if (node.type === 'text') {
      const original = node.data;
      if (!hasWords(original)) return;
      items.push({ text: original.trim(), section: title.trim(), replace: value => {
        node.data = (original.match(/^\s*/)?.[0] ?? '') + value + (original.match(/\s*$/)?.[0] ?? '');
        return $.html();
      } });
    }
    if ('children' in node) for (const child of node.children) walk(child as typeof node);
  }
  walk($.root()[0]);
  return items;
}

function extract(source: string, file: string): EditableItem[] {
  const revision = digest(source);
  if (/\.html?$/i.test(file)) return htmlItems(source, file, revision).map((item, index) => ({
    ...item, file, revision, kind: 'page', id: `html:${index}`,
  }));
  if (!contentScript(file)) return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const result: EditableItem[] = [];
  function visit(node: ts.Node, labels: string[] = [], field = '') {
    if (!dataFile(file) && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))) {
      const literal = node.text;
      // Expose only static text enclosed by HTML tags, leaving expressions, attributes and logic intact.
      for (const match of literal.matchAll(/>([^<>]+)</g)) {
        const raw = match[1];
        const $ = cheerio.load(raw, undefined, false);
        const text = $.text().trim();
        if (!hasWords(text)) continue;
        const offset = match.index! + 1;
        const start = node.getStart(ast), end = node.getEnd();
        result.push({ id: `template:${start}:${offset}`, file, revision, kind: 'data', section: '页面固定文案', text,
          replace: value => {
            const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const updated = literal.slice(0, offset) + (raw.match(/^\s*/)?.[0] ?? '') + escaped + (raw.match(/\s*$/)?.[0] ?? '') + literal.slice(offset + raw.length);
            const token = ts.isStringLiteral(node) ? JSON.stringify(updated).replace(/</g, '\\u003c')
              : (ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? '}' : '`')
                + updated.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
                + (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? '${' : '`');
            return source.slice(0, start) + token + source.slice(end);
          },
        });
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const title = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'title');
      if (title && ts.isPropertyAssignment(title) && ts.isStringLiteral(title.initializer)) labels = [...labels, title.initializer.text];
    }
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(ast).replace(/^["']|["']$/g, '');
      if (!machineField.test(key)) visit(node.initializer, labels, key);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text;
      if (!hasWords(text) || /(?:\.(?:png|jpe?g|webp|svg|gif|ico|mp4|mp3|html|css|js)(?:[?#].*)?$)|^(?:https?:|#|data:)/i.test(text)) return;
      // Only literal values in data containers; never expose executable expressions or property names.
      if (!ts.isArrayLiteralExpression(node.parent) && !(ts.isPropertyAssignment(node.parent) && node.parent.initializer === node)) return;
      const start = node.getStart(ast), end = node.getEnd();
      const replace = (value: string) => source.slice(0, start) + JSON.stringify(value).replace(/</g, '\\u003c') + source.slice(end);
      if (/<\/?[a-z][^>]*>/i.test(text)) {
        htmlItems(text, file, revision, true).forEach((part, index) => result.push({
          id: `js:${start}:${index}`, file, revision, kind: 'data', text: part.text,
          section: labels.join(' / ') || '课程文案', replace: value => replace(part.replace(value)),
        }));
      } else result.push({ id: `js:${start}`, file, revision, kind: 'data', text,
        section: labels.join(' / ') || (field === 'title' ? '课程标题' : '课程文案'), replace });
      return;
    }
    ts.forEachChild(node, child => visit(child, labels, field));
  }
  visit(ast);
  return result;
}

async function history(courseId: string): Promise<History[]> {
  try { return JSON.parse(await readFile(resolveCourseFile(courseId, `${historyDir}/index.json`), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function commit(courseId: string, file: string, before: Buffer, after: Buffer, label: string) {
  if (digest(before) === digest(after)) return;
  const records = await history(courseId);
  const record: History = { id: randomUUID(), file, label, after: digest(after), createdAt: new Date().toISOString() };
  await mkdir(resolveCourseFile(courseId, historyDir), { recursive: true });
  await writeFile(resolveCourseFile(courseId, `${historyDir}/${record.id}.bin`), before);
  await writeFile(resolveCourseFile(courseId, file), after);
  await writeFile(resolveCourseFile(courseId, `${historyDir}/index.json`), JSON.stringify([...records, record]));
}

export async function getMaintenance(courseId: string) {
  getCourseDir(courseId);
  const files = await filesIn(courseId);
  const texts: TextItem[] = [];
  const pages: Array<{ file: string; title: string }> = [];
  const images: Array<{ file: string; url: string; revision: string }> = [];
  for (const file of files) {
    if (/\.html?$/i.test(file) || contentScript(file)) {
      const source = await readFile(resolveCourseFile(courseId, file), 'utf8');
      if (/\.html?$/i.test(file)) pages.push({ file, title: cheerio.load(source)('title').text() || file });
      texts.push(...extract(source, file).map(({ replace: _replace, ...item }) => item));
    }
    if (/\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i.test(file)) images.push({
      file, url: `/api/courses/${courseId}/files/${file.split('/').map(encodeURIComponent).join('/')}`,
      revision: digest(await readFile(resolveCourseFile(courseId, file))),
    });
  }
  const records = await history(courseId);
  return { texts, pages, images, lastChange: records.at(-1) ?? null };
}

export async function updateText(courseId: string, input: { file: string; id: string; revision: string; text: string }) {
  if (input.text.length > 30000) throw new CourseError('文案不能超过 30000 字符。');
  const source = await readFile(resolveCourseFile(courseId, input.file), 'utf8');
  if (digest(source) !== input.revision) throw new CourseError('此内容已有新修改，请刷新列表后重试。', 409);
  const item = extract(source, input.file).find(item => item.id === input.id);
  if (!item) throw new CourseError('找不到这段可编辑文案。', 404);
  await commit(courseId, input.file, Buffer.from(source), Buffer.from(item.replace(input.text)), `修改文案：${item.text.slice(0, 45)}`);
}

export async function updateImage(courseId: string, file: string, revision: string, buffer: Buffer) {
  const extension = path.extname(file).toLowerCase();
  const valid = (extension === '.png' && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    || (['.jpg', '.jpeg'].includes(extension) && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    || (extension === '.webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')
    || (extension === '.gif' && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6)))
    || (extension === '.svg' && /<svg[\s>]/i.test(buffer.toString('utf8').slice(0, 1000)));
  if (!valid) throw new CourseError('图片格式与目标不符，请使用 PNG、JPG、WebP，或同格式的 GIF、SVG。');
  const original = await readFile(resolveCourseFile(courseId, file));
  if (digest(original) !== revision) throw new CourseError('图片已有新修改，请刷新列表后重试。', 409);
  await commit(courseId, file, original, buffer, `替换图片：${path.basename(file)}`);
}

export async function undoMaintenance(courseId: string) {
  const records = await history(courseId);
  const record = records.at(-1);
  if (!record) throw new CourseError('没有可撤销的修改。');
  const file = resolveCourseFile(courseId, record.file);
  if (digest(await readFile(file)) !== record.after) throw new CourseError('该文件已在其他模式修改，不能直接撤销。', 409);
  await writeFile(file, await readFile(resolveCourseFile(courseId, `${historyDir}/${record.id}.bin`)));
  await writeFile(resolveCourseFile(courseId, `${historyDir}/index.json`), JSON.stringify(records.slice(0, -1)));
}
