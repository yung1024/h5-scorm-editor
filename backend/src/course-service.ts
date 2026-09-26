import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import JSZip from 'jszip';

export class CourseError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export interface CoursePayload {
  courseId: string;
  name: string;
  html: string;
  css: string;
  sourceCss: string;
  htmlAttributes: Record<string, string>;
  bodyAttributes: Record<string, string>;
  indexPath: string;
  launchPath: string;
  editPath: string;
  entryMode: 'static' | 'nested';
  entryReason: string;
  previewUrl: string;
  runtimePatches: RuntimeTextPatch[];
}

export interface RuntimeTextPatch {
  id: string;
  documentPath: string;
  selector: string;
  originalText: string;
  replacementText: string;
  textMode: 'element' | 'direct';
}

interface CourseMeta {
  courseId: string;
  name: string;
  indexPath: string;
  launchPath: string;
  editPath: string;
  entryMode: 'static' | 'nested';
  entryReason: string;
  uploadedAt: string;
}

type StoredCourseMeta = Partial<CourseMeta> & Pick<CourseMeta, 'courseId' | 'name' | 'uploadedAt'>;

const dataRoot = () => path.resolve(process.env.COURSE_DATA_DIR ?? path.join(process.cwd(), 'data', 'courses'));
const runtimePatchesFile = '.h5-editor-runtime-patches.json';
const runtimeScriptName = 'h5-editor-runtime-patches.js';

function normalizeZipPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new CourseError('压缩包中包含无效文件路径。');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new CourseError('压缩包中包含不安全的文件路径。');
  }
  return parts.join('/');
}

function assertCourseId(courseId: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(courseId)) throw new CourseError('课程不存在。', 404);
}

export function getCourseDir(courseId: string): string {
  assertCourseId(courseId);
  return path.join(dataRoot(), courseId);
}

export function resolveCourseFile(courseId: string, relativePath: string): string {
  const root = getCourseDir(courseId);
  const decoded = decodeURIComponent(relativePath).replaceAll('\\', '/').replace(/^\/+/, '');
  const resolved = path.resolve(root, decoded);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new CourseError('文件路径无效。');
  }
  return resolved;
}

function assetUrl(courseId: string, relativePath: string): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  return `/api/courses/${courseId}/files/${encoded}`;
}

function isLocalReference(value: string): boolean {
  return Boolean(value) && !/^(?:[a-z]+:|\/\/|#|data:|blob:)/i.test(value);
}

function resolveReference(fromFile: string, reference: string): string {
  const [clean] = reference.split(/[?#]/, 1);
  if (clean.startsWith('/')) return path.posix.normalize(clean.replace(/^\/+/, ''));
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean)).replace(/^\.\//, '');
}

function rewriteCssUrls(css: string, cssPath: string, courseId: string): string {
  return css.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (match, quote: string, value: string) => {
    const trimmed = value.trim();
    if (!isLocalReference(trimmed)) return match;
    return `url(${quote}${assetUrl(courseId, resolveReference(cssPath, trimmed))}${quote})`;
  });
}

function rewriteSrcset(value: string, htmlPath: string, courseId: string): string {
  return value.split(',').map((candidate) => {
    const match = /^\s*(\S+)(\s+.*)?$/.exec(candidate);
    if (!match || !isLocalReference(match[1])) return candidate;
    return `${assetUrl(courseId, resolveReference(htmlPath, match[1]))}${match[2] ?? ''}`;
  }).join(',');
}

async function readCssBundle(courseId: string, cssPath: string, visited = new Set<string>()): Promise<string> {
  if (visited.has(cssPath)) return '';
  visited.add(cssPath);
  const css = await readFile(resolveCourseFile(courseId, cssPath), 'utf8');
  const pattern = /@import\s+(?:url\(\s*)?(['"]?)([^'"\)\s]+)\1\s*\)?\s*([^;]*);/gi;
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(css))) {
    parts.push(rewriteCssUrls(css.slice(cursor, match.index), cssPath, courseId));
    const reference = match[2]?.trim() ?? '';
    if (reference && isLocalReference(reference)) {
      try {
        const imported = await readCssBundle(courseId, resolveReference(cssPath, reference), visited);
        const media = match[3]?.trim();
        parts.push(media ? `@media ${media}{\n${imported}\n}` : imported);
      } catch {
        parts.push(rewriteCssUrls(match[0], cssPath, courseId));
      }
    } else {
      parts.push(match[0]);
    }
    cursor = pattern.lastIndex;
  }
  parts.push(rewriteCssUrls(css.slice(cursor), cssPath, courseId));
  return parts.join('');
}

function normalizeRuntimePatch(value: unknown): RuntimeTextPatch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const patch = value as Partial<RuntimeTextPatch>;
  if (
    typeof patch.id !== 'string'
    || typeof patch.selector !== 'string'
    || typeof patch.originalText !== 'string'
    || typeof patch.replacementText !== 'string'
  ) return undefined;
  return {
    id: patch.id,
    documentPath: typeof patch.documentPath === 'string' ? patch.documentPath : '',
    selector: patch.selector,
    originalText: patch.originalText,
    replacementText: patch.replacementText,
    textMode: patch.textMode === 'direct' ? 'direct' : 'element',
  };
}

export async function getRuntimePatches(courseId: string): Promise<RuntimeTextPatch[]> {
  try {
    const stored = JSON.parse(await readFile(resolveCourseFile(courseId, runtimePatchesFile), 'utf8')) as unknown;
    return Array.isArray(stored)
      ? stored.map(normalizeRuntimePatch).filter((patch): patch is RuntimeTextPatch => Boolean(patch))
      : [];
  } catch {
    return [];
  }
}

function createRuntimePatchScript(patches: RuntimeTextPatch[]): string {
  const serialized = JSON.stringify(patches).replace(/<\//g, '<\\/');
  return `(() => {
  const documentPath = document.currentScript?.dataset.h5DocumentPath || '';
  const patches = ${serialized}.filter((patch) => patch.documentPath === documentPath);
  const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
  const directTextNodes = (element) => Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE);
  const currentText = (element, patch) => patch.textMode === 'direct'
    ? normalize(directTextNodes(element).map((node) => node.nodeValue).join(' '))
    : normalize(element.textContent);
  let applying = false;
  const apply = () => {
    if (applying) return;
    applying = true;
    try {
      document.querySelectorAll('[data-h5-runtime-patch-id]').forEach((element) => {
        const patch = patches.find((item) => item.id === element.dataset.h5RuntimePatchId);
        if (!patch || currentText(element, patch) !== normalize(patch.replacementText)) {
          delete element.dataset.h5RuntimePatchId;
          delete element.dataset.h5RuntimeOriginalText;
          delete element.dataset.h5RuntimeTextMode;
        }
      });
      patches.forEach((patch) => {
        let elements = [];
        try { elements = Array.from(document.querySelectorAll(patch.selector)); } catch { return; }
        elements.forEach((element) => {
          if (currentText(element, patch) !== normalize(patch.originalText)) return;
          if (patch.textMode === 'direct') {
            const nodes = directTextNodes(element);
            if (!nodes.length) return;
            nodes[0].nodeValue = patch.replacementText;
            nodes.slice(1).forEach((node) => { node.nodeValue = ''; });
          } else {
            element.textContent = patch.replacementText;
          }
          element.dataset.h5RuntimePatchId = patch.id;
          element.dataset.h5RuntimeOriginalText = patch.originalText;
          element.dataset.h5RuntimeTextMode = patch.textMode;
        });
      });
    } finally {
      applying = false;
    }
  };
  const start = () => {
    apply();
    if (!document.body) return;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; apply(); });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start, { once: true }) : start();
})();\n`;
}

async function writeRuntimePatchFiles(
  courseId: string,
  patches: RuntimeTextPatch[],
  documents = new Set(patches.map((patch) => patch.documentPath)),
): Promise<void> {
  await readMeta(courseId);
  await writeFile(resolveCourseFile(courseId, runtimePatchesFile), JSON.stringify(patches, null, 2), 'utf8');
  await writeFile(resolveCourseFile(courseId, runtimeScriptName), createRuntimePatchScript(patches), 'utf8');

  for (const documentPath of documents) {
    if (!/\.html?$/i.test(documentPath) || !await courseFileExists(courseId, documentPath)) continue;
    const indexFile = resolveCourseFile(courseId, documentPath);
    const source = await readFile(indexFile, 'utf8');
    const $ = cheerio.load(source);
    const documentDir = path.posix.dirname(documentPath) === '.' ? '' : path.posix.dirname(documentPath);
    const scriptReference = path.posix.relative(documentDir, runtimeScriptName) || runtimeScriptName;
    $('script[data-h5-runtime-patches]').remove();
    $('body').append(`\n<script src="${scriptReference}" data-h5-runtime-patches="true" data-h5-document-path="${documentPath}"></script>`);
    await writeFile(indexFile, $.html(), 'utf8');
  }
}

export async function upsertRuntimePatch(
  courseId: string,
  input: Omit<RuntimeTextPatch, 'id'> & { id?: string },
): Promise<RuntimeTextPatch[]> {
  await readMeta(courseId);
  const selector = input.selector.trim();
  const documentPath = normalizeZipPath(input.documentPath);
  const originalText = input.originalText.replace(/\s+/g, ' ').trim();
  const replacementText = input.replacementText.trim();
  if (!/\.html?$/i.test(documentPath) || !await courseFileExists(courseId, documentPath)) {
    throw new CourseError('文字所在页面不存在。');
  }
  if (!selector || !originalText || !replacementText) throw new CourseError('请选择文字并填写替换内容。');
  if (selector.length > 1000 || originalText.length > 5000 || replacementText.length > 5000) {
    throw new CourseError('文字补丁内容过长。');
  }
  const patches = await getRuntimePatches(courseId);
  const index = patches.findIndex((patch) => patch.id === input.id || (
    patch.documentPath === documentPath && patch.selector === selector
    && patch.originalText === originalText && patch.textMode === input.textMode
  ));
  const patch: RuntimeTextPatch = {
    id: index >= 0 ? patches[index].id : randomUUID(),
    documentPath,
    selector,
    originalText,
    replacementText,
    textMode: input.textMode === 'direct' ? 'direct' : 'element',
  };
  if (index >= 0) patches[index] = patch;
  else patches.push(patch);
  await writeRuntimePatchFiles(courseId, patches);
  return patches;
}

export async function deleteRuntimePatch(courseId: string, patchId: string): Promise<RuntimeTextPatch[]> {
  const existing = await getRuntimePatches(courseId);
  const patches = existing.filter((patch) => patch.id !== patchId);
  await writeRuntimePatchFiles(courseId, patches, new Set(existing.map((patch) => patch.documentPath)));
  return patches;
}

export function injectEditorBridge(courseId: string, documentPath: string, source: string): string {
  const bridge = `<script data-h5-editor-preview-bridge>(() => {
    const courseId = ${JSON.stringify(courseId)};
    const documentPath = ${JSON.stringify(documentPath)};
    let picking = false;
    const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const selectorFor = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((item) => item.tagName === current.tagName) : [];
        parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : ''));
        current = current.parentElement;
        if (current?.id) { parts.unshift('#' + CSS.escape(current.id)); break; }
      }
      return parts.join(' > ');
    };
    const candidateAt = (event) => {
      const blocked = /^(HTML|BODY|SCRIPT|STYLE|INPUT|TEXTAREA|SELECT|OPTION|VIDEO|AUDIO|CANVAS|SVG)$/;
      for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
        if (!(element instanceof HTMLElement) || blocked.test(element.tagName)) continue;
        const direct = normalize(Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.nodeValue).join(' '));
        if (direct) return { element, text: direct, textMode: 'direct' };
        if (!element.children.length && normalize(element.textContent)) return { element, text: normalize(element.textContent), textMode: 'element' };
      }
      return null;
    };
    const directTextNodes = (element) => Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE);
    const applyTextPatch = (patch) => {
      if (!patch || patch.documentPath !== documentPath) return;
      let elements = [];
      try { elements = Array.from(document.querySelectorAll(patch.selector)); } catch { return; }
      elements.forEach((element) => {
        const nodes = directTextNodes(element);
        const current = patch.textMode === 'direct'
          ? normalize(nodes.map((node) => node.nodeValue).join(' '))
          : normalize(element.textContent);
        if (current !== normalize(patch.originalText) && element.dataset.h5RuntimePatchId !== patch.id) return;
        if (patch.textMode === 'direct') {
          if (!nodes.length) return;
          nodes[0].nodeValue = patch.replacementText;
          nodes.slice(1).forEach((node) => { node.nodeValue = ''; });
        } else {
          element.textContent = patch.replacementText;
        }
        element.dataset.h5RuntimePatchId = patch.id;
        element.dataset.h5RuntimeOriginalText = patch.sourceOriginalText || patch.originalText;
        element.dataset.h5RuntimeTextMode = patch.textMode;
      });
    };
    const removeTextPatch = (patch) => {
      if (!patch || patch.documentPath !== documentPath) return;
      let elements = [];
      try { elements = Array.from(document.querySelectorAll(patch.selector)); } catch { return; }
      elements.forEach((element) => {
        const nodes = directTextNodes(element);
        const current = patch.textMode === 'direct'
          ? normalize(nodes.map((node) => node.nodeValue).join(' '))
          : normalize(element.textContent);
        if (current !== normalize(patch.replacementText) && element.dataset.h5RuntimePatchId !== patch.id) return;
        if (patch.textMode === 'direct') {
          if (!nodes.length) return;
          nodes[0].nodeValue = patch.originalText;
          nodes.slice(1).forEach((node) => { node.nodeValue = ''; });
        } else {
          element.textContent = patch.originalText;
        }
        delete element.dataset.h5RuntimePatchId;
        delete element.dataset.h5RuntimeOriginalText;
        delete element.dataset.h5RuntimeTextMode;
      });
    };
    const notifyReady = () => window.top.postMessage({ source: 'h5-scorm-editor-bridge', type: 'ready', courseId, documentPath }, '*');
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.source !== 'h5-scorm-editor-host' || message.courseId !== courseId) return;
      if (message.type === 'set-pick-mode') {
        picking = Boolean(message.enabled);
        document.documentElement.classList.toggle('h5-editor-picking', picking);
        document.querySelectorAll('iframe').forEach((frame) => frame.contentWindow?.postMessage(message, '*'));
      }
      if (message.type === 'apply-text-patch') {
        applyTextPatch(message.patch);
        document.querySelectorAll('iframe').forEach((frame) => frame.contentWindow?.postMessage(message, '*'));
      }
      if (message.type === 'remove-text-patch') {
        removeTextPatch(message.patch);
        document.querySelectorAll('iframe').forEach((frame) => frame.contentWindow?.postMessage(message, '*'));
      }
    });
    document.addEventListener('click', (event) => {
      if (!picking) return;
      const candidate = candidateAt(event);
      if (!candidate) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      document.querySelectorAll('[data-h5-editor-picked]').forEach((element) => element.removeAttribute('data-h5-editor-picked'));
      candidate.element.dataset.h5EditorPicked = 'true';
      const originalText = candidate.element.dataset.h5RuntimeOriginalText || candidate.text;
      window.top.postMessage({
        source: 'h5-scorm-editor-bridge', type: 'text-selected', courseId, documentPath,
        selector: selectorFor(candidate.element), originalText,
        currentText: candidate.text, tagName: candidate.element.tagName.toLowerCase(),
        textMode: candidate.element.dataset.h5RuntimeTextMode || candidate.textMode,
        patchId: candidate.element.dataset.h5RuntimePatchId || undefined,
      }, '*');
    }, true);
    const style = document.createElement('style');
    style.textContent = '.h5-editor-picking *{cursor:crosshair!important}[data-h5-editor-picked]{outline:3px solid #635bff!important;outline-offset:3px!important}';
    document.head.appendChild(style);
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', notifyReady, { once: true }) : notifyReady();
  })();</script>`;
  if (/<\/body\s*>/i.test(source)) return source.replace(/<\/body\s*>/i, `${bridge}</body>`);
  return `${source}\n${bridge}`;
}

function restoreCourseUrls(content: string, courseId: string, fromFile: string): string {
  const prefix = `/api/courses/${courseId}/files/`;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(new RegExp(`${escapedPrefix}([^'"\\s)<>]+)`, 'g'), (_match, encodedPath: string) => {
    try {
      const coursePath = decodeURIComponent(encodedPath).split(/[?#]/, 1)[0];
      return path.posix.relative(path.posix.dirname(fromFile), coursePath) || path.posix.basename(coursePath);
    } catch {
      return encodedPath.split(/[?#]/, 1)[0];
    }
  });
}

function decodeUploadName(originalName: string): string {
  const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
  const originalHasCjk = /[\u3400-\u9fff]/u.test(originalName);
  const decodedHasCjk = /[\u3400-\u9fff]/u.test(decoded);
  if (!decoded.includes('\uFFFD') && decodedHasCjk && !originalHasCjk) return decoded;
  return originalName;
}

function manifestLaunchPath(source: string, manifestPath: string): string | undefined {
  const $ = cheerio.load(source, { xmlMode: true });
  let fallback: string | undefined;
  let sco: string | undefined;
  $('resource').each((_, element) => {
    const attributes = element.attribs ?? {};
    const href = attributes.href;
    if (!href) return;
    fallback ??= href;
    const scormType = Object.entries(attributes)
      .find(([key]) => key.toLowerCase().endsWith('scormtype'))?.[1];
    if (scormType?.toLowerCase() === 'sco') sco ??= href;
  });
  const reference = sco ?? fallback;
  if (!reference || !isLocalReference(reference)) return undefined;
  return resolveReference(manifestPath, reference);
}

function htmlReferences(source: string): string[] {
  const references = new Set<string>();
  const patterns = [
    /["']?(?:content|launch|course|start)(?:Url|URL|Href|Path)["']?\s*[:=]\s*["']([^"']+\.html?(?:[?#][^"']*)?)["']/gi,
    /(?:\.src|setAttribute\(\s*["']src["']\s*,)\s*[=(,]?\s*["']([^"']+\.html?(?:[?#][^"']*)?)["']/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      if (match[1] && isLocalReference(match[1])) references.add(match[1]);
    }
  }
  return [...references];
}

async function detectEditableEntry(
  courseId: string,
  launchPath: string,
  htmlFiles: string[],
): Promise<Pick<CourseMeta, 'editPath' | 'entryMode' | 'entryReason'>> {
  const launchSource = await readFile(resolveCourseFile(courseId, launchPath), 'utf8');
  const $ = cheerio.load(launchSource);
  const available = new Map(htmlFiles.map((file) => [file.toLowerCase(), file]));

  const findTarget = (reference: string) => {
    const resolved = resolveReference(launchPath, reference);
    const actual = available.get(resolved.toLowerCase());
    return actual && actual !== launchPath ? actual : undefined;
  };

  for (const frame of $('iframe[src]').toArray()) {
    const src = $(frame).attr('src') ?? '';
    if (!src || /^about:/i.test(src) || !isLocalReference(src)) continue;
    const target = findTarget(src);
    if (target) return { editPath: target, entryMode: 'nested', entryReason: 'iframe-src' };
  }

  for (const reference of htmlReferences(launchSource)) {
    const target = findTarget(reference);
    if (target) return { editPath: target, entryMode: 'nested', entryReason: 'inline-script' };
  }

  for (const script of $('script[src]').toArray()) {
    const src = $(script).attr('src') ?? '';
    if (!src || !isLocalReference(src)) continue;
    try {
      const scriptPath = resolveReference(launchPath, src);
      const scriptSource = await readFile(resolveCourseFile(courseId, scriptPath), 'utf8');
      for (const reference of htmlReferences(scriptSource)) {
        const target = findTarget(reference);
        if (target) return { editPath: target, entryMode: 'nested', entryReason: 'launcher-script' };
      }
    } catch {
      // Optional or remote-like launch helpers must not block importing the course.
    }
  }

  const visibleBody = $('body').clone();
  visibleBody.find('script, style, noscript, iframe, object, embed').remove();
  const visibleText = visibleBody.text().replace(/\s+/g, ' ').trim();
  if ($('iframe').length && visibleText.length < 200) {
    const fallback = htmlFiles
      .filter((file) => file !== launchPath && path.posix.basename(file).toLowerCase() === 'index.html')
      .sort((a, b) => {
        const score = (value: string) => /(^|\/)(content|course|story_content|html5)(\/|$)/i.test(value) ? 0 : 1;
        return score(a) - score(b) || a.split('/').length - b.split('/').length;
      })[0];
    if (fallback) return { editPath: fallback, entryMode: 'nested', entryReason: 'wrapper-fallback' };
  }

  return { editPath: launchPath, entryMode: 'static', entryReason: 'launch-page' };
}

async function readMeta(courseId: string): Promise<CourseMeta> {
  try {
    const stored = JSON.parse(await readFile(resolveCourseFile(courseId, '.course.json'), 'utf8')) as StoredCourseMeta;
    const name = decodeUploadName(stored.name);
    const launchPath = stored.launchPath ?? stored.indexPath ?? 'index.html';
    let editPath = stored.editPath ?? stored.indexPath ?? launchPath;
    let entryMode = stored.entryMode ?? (editPath === launchPath ? 'static' : 'nested');
    let entryReason = stored.entryReason ?? 'legacy-course';

    if (!stored.launchPath || !stored.editPath) {
      const files = await listFiles(getCourseDir(courseId));
      const detected = await detectEditableEntry(courseId, launchPath, files.filter((file) => /\.html?$/i.test(file)));
      editPath = detected.editPath;
      entryMode = detected.entryMode;
      entryReason = detected.entryReason;
    }

    const meta: CourseMeta = {
      ...stored,
      courseId: stored.courseId,
      name,
      uploadedAt: stored.uploadedAt,
      indexPath: stored.indexPath ?? launchPath,
      launchPath,
      editPath,
      entryMode,
      entryReason,
    };
    if (!stored.launchPath || !stored.editPath || name !== stored.name) {
      await writeFile(resolveCourseFile(courseId, '.course.json'), JSON.stringify(meta, null, 2), 'utf8');
    }
    return meta;
  } catch {
    throw new CourseError('课程不存在或已被清理。', 404);
  }
}

export async function importCourse(buffer: Buffer, originalName: string): Promise<CoursePayload> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    throw new CourseError('无法读取 ZIP 文件，请确认文件未损坏。');
  }

  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  const safeFiles = files.map((entry) => ({ entry, safePath: normalizeZipPath(entry.name) }));
  const indexes = safeFiles
    .filter(({ safePath }) => path.posix.basename(safePath).toLowerCase() === 'index.html')
    .sort((a, b) => a.safePath.split('/').length - b.safePath.split('/').length);

  if (!indexes.length) throw new CourseError('不是有效 H5 课程：压缩包中未找到 index.html。');

  const manifests = safeFiles
    .filter(({ safePath }) => path.posix.basename(safePath).toLowerCase() === 'imsmanifest.xml')
    .sort((a, b) => a.safePath.split('/').length - b.safePath.split('/').length);
  const packageAnchor = manifests[0]?.safePath ?? indexes[0].safePath;
  const packageRoot = path.posix.dirname(packageAnchor);
  const rootPrefix = packageRoot === '.' ? '' : `${packageRoot}/`;
  const courseId = randomUUID();
  const courseDir = getCourseDir(courseId);
  await mkdir(courseDir, { recursive: true });

  const extractedFiles: string[] = [];
  for (const { entry, safePath } of safeFiles) {
    if (rootPrefix && !safePath.startsWith(rootPrefix)) continue;
    const relativePath = rootPrefix ? safePath.slice(rootPrefix.length) : safePath;
    if (!relativePath || relativePath.startsWith('__MACOSX/')) continue;
    const target = resolveCourseFile(courseId, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await entry.async('nodebuffer'));
    extractedFiles.push(relativePath);
  }

  const relativeIndexes = extractedFiles
    .filter((file) => path.posix.basename(file).toLowerCase() === 'index.html')
    .sort((a, b) => a.split('/').length - b.split('/').length);
  const manifestPath = extractedFiles.find((file) => path.posix.basename(file).toLowerCase() === 'imsmanifest.xml');
  let launchPath: string | undefined;
  if (manifestPath) {
    const source = await readFile(resolveCourseFile(courseId, manifestPath), 'utf8');
    const candidate = manifestLaunchPath(source, manifestPath);
    if (candidate && extractedFiles.some((file) => file.toLowerCase() === candidate.toLowerCase())) {
      launchPath = extractedFiles.find((file) => file.toLowerCase() === candidate.toLowerCase());
    }
  }
  launchPath ??= relativeIndexes[0];
  if (!launchPath) throw new CourseError('不是有效 H5 课程：无法确定课程启动页。');

  const htmlFiles = extractedFiles.filter((file) => /\.html?$/i.test(file));
  const entry = await detectEditableEntry(courseId, launchPath, htmlFiles);

  const meta: CourseMeta = {
    courseId,
    name: path.basename(decodeUploadName(originalName), path.extname(originalName)) || 'course',
    indexPath: launchPath,
    launchPath,
    ...entry,
    uploadedAt: new Date().toISOString(),
  };
  await writeFile(resolveCourseFile(courseId, '.course.json'), JSON.stringify(meta, null, 2), 'utf8');
  return loadCourse(courseId);
}

export async function loadCourse(courseId: string): Promise<CoursePayload> {
  const meta = await readMeta(courseId);
  const indexFile = resolveCourseFile(courseId, meta.editPath);
  const source = await readFile(indexFile, 'utf8');
  const $ = cheerio.load(source);
  const sourceStyles: string[] = [];
  const editableStyles: string[] = [];

  for (const element of $('head style, head link[rel="stylesheet"]').toArray()) {
    if (element.tagName === 'style') {
      sourceStyles.push(rewriteCssUrls($(element).html() ?? '', meta.editPath, courseId));
      continue;
    }
    const href = $(element).attr('href') ?? '';
    if (!isLocalReference(href)) continue;
    const cssPath = resolveReference(meta.editPath, href);
    try {
      const css = await readCssBundle(courseId, cssPath);
      if ($(element).attr('data-h5-scorm-editor') === 'true') editableStyles.push(css);
      else sourceStyles.push(css);
    } catch {
      // Keep the original link in index.html; a missing optional stylesheet must not block editing.
    }
  }

  const body = $('body');
  body.find('[src], [poster]').each((_, element) => {
    for (const attribute of ['src', 'poster']) {
      const value = $(element).attr(attribute);
      if (value && isLocalReference(value)) {
        $(element).attr(attribute, assetUrl(courseId, resolveReference(meta.editPath, value)));
      }
    }
  });
  body.find('[style]').each((_, element) => {
    const value = $(element).attr('style');
    if (value) $(element).attr('style', rewriteCssUrls(value, meta.editPath, courseId));
  });
  const bodyStyle = body.attr('style');
  if (bodyStyle) body.attr('style', rewriteCssUrls(bodyStyle, meta.editPath, courseId));
  body.find('[srcset]').each((_, element) => {
    const value = $(element).attr('srcset');
    if (value) $(element).attr('srcset', rewriteSrcset(value, meta.editPath, courseId));
  });
  body.find('[data-src]').each((_, element) => {
    const value = $(element).attr('data-src');
    if (value && isLocalReference(value)) $(element).attr('data-src', assetUrl(courseId, resolveReference(meta.editPath, value)));
  });
  body.find('svg image').each((_, element) => {
    for (const attribute of ['href', 'xlink:href']) {
      const value = $(element).attr(attribute);
      if (value && isLocalReference(value)) $(element).attr(attribute, assetUrl(courseId, resolveReference(meta.editPath, value)));
    }
  });

  return {
    courseId,
    name: meta.name,
    html: body.html() ?? '',
    css: editableStyles.join('\n\n'),
    sourceCss: sourceStyles.join('\n\n'),
    htmlAttributes: $('html').attr() ?? {},
    bodyAttributes: body.attr() ?? {},
    indexPath: meta.editPath,
    launchPath: meta.launchPath,
    editPath: meta.editPath,
    entryMode: meta.entryMode,
    entryReason: meta.entryReason,
    previewUrl: `/api/courses/${courseId}/preview/`,
    runtimePatches: await getRuntimePatches(courseId),
  };
}

export async function saveCourse(courseId: string, html: string, css: string): Promise<void> {
  const meta = await readMeta(courseId);
  const indexFile = resolveCourseFile(courseId, meta.editPath);
  const editorCssPath = path.posix.join(
    path.posix.dirname(meta.editPath) === '.' ? '' : path.posix.dirname(meta.editPath),
    'editor.css',
  );
  const source = await readFile(indexFile, 'utf8');
  const $ = cheerio.load(source);
  const restoredHtml = restoreCourseUrls(html, courseId, meta.editPath);
  const restoredCss = restoreCourseUrls(css, courseId, editorCssPath);
  const bodyScripts = $('body script').toArray().map((element) => $.html(element));
  const editedBody = cheerio.load(`<body>${restoredHtml}</body>`, undefined, false);
  editedBody('script').remove();

  $('body').html(editedBody('body').html() ?? editedBody.html());
  if (bodyScripts.length) $('body').append(`\n${bodyScripts.join('\n')}`);
  $('[data-h5-scorm-editor]').remove();
  $('head').append('<link rel="stylesheet" href="editor.css" data-h5-scorm-editor="true">');
  await writeFile(resolveCourseFile(courseId, editorCssPath), restoredCss, 'utf8');
  await writeFile(indexFile, $.html(), 'utf8');
}

export async function replaceImage(
  courseId: string,
  targetPath: string | undefined,
  file: { buffer: Buffer; originalname: string },
): Promise<{ path: string; url: string }> {
  const meta = await readMeta(courseId);
  const proxyPrefix = `/api/courses/${courseId}/files/`;
  let normalizedTarget = targetPath;
  if (normalizedTarget && /^[a-z]+:/i.test(normalizedTarget)) {
    try { normalizedTarget = new URL(normalizedTarget).pathname; } catch { /* Keep the original validation path. */ }
  }
  let relativePath = normalizedTarget?.startsWith(proxyPrefix) ? normalizedTarget.slice(proxyPrefix.length) : normalizedTarget;
  if (!relativePath || !isLocalReference(relativePath)) {
    const extension = path.extname(file.originalname).toLowerCase() || '.png';
    const editDir = path.posix.dirname(meta.editPath) === '.' ? '' : path.posix.dirname(meta.editPath);
    relativePath = path.posix.join(editDir, `images/replacement-${Date.now()}${extension}`);
  }
  relativePath = decodeURIComponent(relativePath).split(/[?#]/, 1)[0].replace(/^\/+/, '');
  const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico']);
  if (!allowedExtensions.has(path.posix.extname(relativePath).toLowerCase())) {
    throw new CourseError('目标文件不是可替换的图片资源。');
  }
  const destination = resolveCourseFile(courseId, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, file.buffer);
  return { path: relativePath.replaceAll('\\', '/'), url: assetUrl(courseId, relativePath.replaceAll('\\', '/')) };
}

async function listFiles(root: string, current = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.course.json' || entry.name === '.h5-editor-history') continue;
    const relative = path.posix.join(current.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(root, relative));
    else result.push(relative);
  }
  return result;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  })[character] ?? character);
}

function createManifest(name: string, files: string[], launchPath: string): string {
  const fileEntries = files
    .filter((file) => file !== 'imsmanifest.xml')
    .map((file) => `      <file href="${escapeXml(file)}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="h5-scorm-editor-${randomUUID()}" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>${escapeXml(name)}</title>
      <item identifier="ITEM-1" identifierref="RES-1">
        <title>${escapeXml(name)}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="${escapeXml(launchPath)}">
${fileEntries}
    </resource>
  </resources>
</manifest>`;
}

export async function exportScorm(courseId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const meta = await readMeta(courseId);
  const root = getCourseDir(courseId);
  const files = await listFiles(root);
  const zip = new JSZip();

  for (const file of files) zip.file(file, await readFile(path.join(root, file)));
  if (!files.includes('imsmanifest.xml')) zip.file('imsmanifest.xml', createManifest(meta.name, files, meta.launchPath));
  else {
    const original = await readFile(path.join(root, 'imsmanifest.xml'), 'utf8');
    const $ = cheerio.load(original, { xmlMode: true });
    const resources = $('resource');
    const matching = resources.filter((_, element) => ($(element).attr('href') ?? '').split(/[?#]/)[0] === meta.launchPath).first();
    const resource = matching.length ? matching : resources.length === 1 ? resources.first() : undefined;
    if (resource?.length) {
      const listed = new Set(resource.find('file').map((_, element) => $(element).attr('href')).get());
      const missing = files.filter(file => file !== 'imsmanifest.xml' && !listed.has(file));
      if (missing.length) {
        for (const file of missing) resource.append(`\n<file href="${escapeXml(file)}"/>`);
        zip.file('imsmanifest.xml', $.xml());
      }
    }
  }

  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }),
    fileName: /_v\d+\.\d+\.\d+$/.test(meta.name)
      ? `${meta.name.replace(/_v(\d+)\.(\d+)\.(\d+)$/, (_, major, minor, patch) => `_v${major}.${minor}.${Number(patch) + 1}`)}.zip`
      : `${meta.name}_scorm_v1.0.0.zip`,
  };
}

export async function resolvePreviewFile(courseId: string, requestedPath?: string): Promise<string> {
  const meta = await readMeta(courseId);
  const relativePath = requestedPath?.replace(/^\/+/, '') || meta.launchPath;
  if (!await courseFileExists(courseId, relativePath)) throw new CourseError('课程预览资源不存在。', 404);
  return resolveCourseFile(courseId, relativePath);
}

export async function courseFileExists(courseId: string, relativePath: string): Promise<boolean> {
  try {
    return (await stat(resolveCourseFile(courseId, relativePath))).isFile();
  } catch {
    return false;
  }
}
