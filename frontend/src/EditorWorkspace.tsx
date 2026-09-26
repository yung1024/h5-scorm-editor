import { useEffect, useRef, useState } from 'react';
import grapesjs, { type Component, type Editor } from 'grapesjs';
import {
  ChevronDown,
  FileSearch,
  ImagePlus,
  Layers3,
  LoaderCircle,
  Monitor,
  MousePointer2,
  Navigation,
  PanelRight,
  Pencil,
  Play,
  Redo2,
  RefreshCw,
  ScanText,
  ShieldCheck,
  Smartphone,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import { removeRuntimeTextPatch, replaceCourseImage, saveRuntimeTextPatch } from './api';
import type { CoursePayload, Notice, RuntimeTextPatch, RuntimeTextSelection } from './types';

interface EditorWorkspaceProps {
  course: CoursePayload | null;
  onEditorReady: (editor: Editor) => void;
  onDirtyChange: (dirty: boolean) => void;
  onNotice: (notice: Notice) => void;
  onBeforePreview: () => Promise<boolean>;
}

type WorkspaceMode = 'edit' | 'interact' | 'preview';
type BackgroundLayer = 'element' | 'before' | 'after';

interface SelectedBackground {
  source: string;
  layer: BackgroundLayer;
}

function selectedImageSource(component: Component | null): string | undefined {
  if (!component || component.get('type') !== 'image') return undefined;
  return component.getAttributes().src;
}

function extractFirstCssUrl(value: string): string | undefined {
  const match = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(value);
  return match?.[2]?.trim() || undefined;
}

function selectedBackground(component: Component | null): SelectedBackground | null {
  const element = component?.getEl();
  const view = element?.ownerDocument.defaultView;
  if (!element || !view) return null;
  for (const layer of ['element', 'before', 'after'] as const) {
    const pseudo = layer === 'element' ? null : `::${layer}`;
    try {
      const source = extractFirstCssUrl(view.getComputedStyle(element, pseudo).backgroundImage);
      if (source) return { source, layer };
    } catch {
      // Some embedded engines reject pseudo-element computed styles; the element layer remains usable.
    }
  }
  return null;
}

function installSourceStyles(editor: Editor, course: CoursePayload, revision: number) {
  const document = editor.Canvas.getDocument();
  if (!document) return;
  document.getElementById('h5-course-source-styles')?.remove();
  const style = document.createElement('style');
  style.id = 'h5-course-source-styles';
  const sourceCss = course.sourceCss ?? '';
  const assetPrefix = `/api/courses/${course.courseId}/files/`;
  style.textContent = sourceCss.replace(
    new RegExp(`(${assetPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^'"\\s\\)]+)(?:\\?[^'"\\s\\)]*)?`, 'g'),
    `$1?editorRevision=${revision}`,
  );
  document.head.insertBefore(style, document.head.firstChild);
  for (const [name, value] of Object.entries(course.htmlAttributes ?? {})) {
    document.documentElement.setAttribute(name, value);
  }
}

export function EditorWorkspace({ course, onEditorReady, onDirtyChange, onNotice, onBeforePreview }: EditorWorkspaceProps) {
  const editorHostRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef<HTMLDivElement>(null);
  const stylesRef = useRef<HTMLDivElement>(null);
  const traitsRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const runtimeFrameRef = useRef<HTMLIFrameElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const selectedRef = useRef<Component | null>(null);
  const loadingCourseRef = useRef(false);
  const modeRef = useRef<WorkspaceMode>('edit');
  const pickingRef = useRef(false);
  const [selected, setSelected] = useState<Component | null>(null);
  const [background, setBackground] = useState<SelectedBackground | null>(null);
  const [device, setDevice] = useState<'Desktop' | 'Mobile'>('Desktop');
  const [replacing, setReplacing] = useState<'image' | 'background' | null>(null);
  const [mode, setMode] = useState<WorkspaceMode>('edit');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [assetRevision, setAssetRevision] = useState(0);
  const [pickingText, setPickingText] = useState(false);
  const [runtimeSelection, setRuntimeSelection] = useState<RuntimeTextSelection | null>(null);
  const [runtimeValue, setRuntimeValue] = useState('');
  const [runtimePatches, setRuntimePatches] = useState<RuntimeTextPatch[]>([]);
  const [savingRuntimeText, setSavingRuntimeText] = useState(false);

  function updateSelection(component: Component | null) {
    selectedRef.current = component;
    setSelected(component);
    window.requestAnimationFrame(() => setBackground(selectedBackground(component)));
  }

  function postRuntimeMessage(message: Record<string, unknown>) {
    if (!course) return;
    runtimeFrameRef.current?.contentWindow?.postMessage({
      source: 'h5-scorm-editor-host',
      courseId: course.courseId,
      ...message,
    }, '*');
  }

  function setPickMode(enabled: boolean) {
    pickingRef.current = enabled;
    setPickingText(enabled);
    postRuntimeMessage({ type: 'set-pick-mode', enabled });
  }

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    if (!editorHostRef.current || !blocksRef.current || !stylesRef.current || !traitsRef.current) return;
    const editor = grapesjs.init({
      container: editorHostRef.current,
      height: '100%',
      width: 'auto',
      fromElement: false,
      storageManager: false,
      panels: { defaults: [] },
      blockManager: { appendTo: blocksRef.current },
      styleManager: {
        appendTo: stylesRef.current,
        sectors: [
          {
            name: '布局',
            open: true,
            buildProps: ['display', 'position', 'width', 'height', 'margin', 'padding'],
          },
          {
            name: '文字',
            open: true,
            buildProps: ['font-family', 'font-size', 'font-weight', 'color', 'line-height', 'text-align'],
          },
          {
            name: '背景',
            open: true,
            buildProps: ['background-color', 'background-image', 'background-size', 'background-position', 'background-repeat'],
          },
          {
            name: '外观',
            open: false,
            buildProps: ['border', 'border-radius', 'box-shadow', 'opacity'],
          },
        ],
      },
      traitManager: { appendTo: traitsRef.current },
      deviceManager: {
        devices: [
          { id: 'Desktop', name: '桌面', width: '' },
          { id: 'Mobile', name: '手机', width: '390px', widthMedia: '480px' },
        ],
      },
      canvas: { styles: [], scripts: [] },
      selectorManager: { componentFirst: true },
      undoManager: { trackSelection: false },
    });

    editor.BlockManager.add('heading', {
      label: '<span class="block-icon">H</span><span>标题</span>',
      category: '基础内容',
      content: '<h2>输入标题</h2>',
    });
    editor.BlockManager.add('text', {
      label: '<span class="block-icon">T</span><span>文本</span>',
      category: '基础内容',
      content: '<p>双击编辑这段文字</p>',
    });
    editor.BlockManager.add('image', {
      label: '<span class="block-icon">▧</span><span>图片</span>',
      category: '基础内容',
      select: true,
      content: { type: 'image', attributes: { alt: '课程图片' } },
    });
    editor.BlockManager.add('section', {
      label: '<span class="block-icon">□</span><span>容器</span>',
      category: '布局',
      content: '<section style="padding:24px; min-height:120px"><p>内容区域</p></section>',
    });
    editor.BlockManager.add('columns', {
      label: '<span class="block-icon">▥</span><span>双栏</span>',
      category: '布局',
      content: '<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px"><div>左侧</div><div>右侧</div></div>',
    });

    editor.on('component:selected', (component: Component) => updateSelection(component));
    editor.on('component:deselected', () => updateSelection(null));
    editor.on('component:styleUpdate', (component: Component) => {
      if (component === selectedRef.current) window.requestAnimationFrame(() => setBackground(selectedBackground(component)));
    });
    editor.on('update', () => {
      if (!loadingCourseRef.current) onDirtyChange(true);
    });
    editor.on('load', () => onEditorReady(editor));
    editorRef.current = editor;
    onEditorReady(editor);

    return () => {
      editor.destroy();
      editorRef.current = null;
    };
  }, [onDirtyChange, onEditorReady]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !course) return;
    loadingCourseRef.current = true;
    editor.setComponents(course.html);
    editor.setStyle(course.css ?? '');
    editor.getWrapper()?.setAttributes(course.bodyAttributes ?? {});
    editor.UndoManager.clear();
    onDirtyChange(false);
    updateSelection(null);
    setMode('edit');
    modeRef.current = 'edit';
    setPreviewLoading(false);
    setPreviewRevision(Date.now());
    setAssetRevision(Date.now());
    setPickingText(false);
    pickingRef.current = false;
    setRuntimeSelection(null);
    setRuntimeValue('');
    setRuntimePatches(course.runtimePatches ?? []);
    const timer = window.setTimeout(() => {
      installSourceStyles(editor, course, assetRevision || Date.now());
      loadingCourseRef.current = false;
      onDirtyChange(false);
    });
    return () => window.clearTimeout(timer);
  }, [course, onDirtyChange]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !course || !assetRevision) return;
    installSourceStyles(editor, course, assetRevision);
  }, [assetRevision, course]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data as Record<string, unknown> | null;
      if (!course || !message || message.source !== 'h5-scorm-editor-bridge' || message.courseId !== course.courseId) return;
      if (message.type === 'ready' && modeRef.current === 'interact') {
        postRuntimeMessage({ type: 'set-pick-mode', enabled: pickingRef.current });
        return;
      }
      if (message.type !== 'text-selected' || modeRef.current !== 'interact') return;
      if (
        typeof message.documentPath !== 'string'
        || typeof message.selector !== 'string'
        || typeof message.originalText !== 'string'
        || typeof message.currentText !== 'string'
        || typeof message.tagName !== 'string'
        || (message.textMode !== 'element' && message.textMode !== 'direct')
      ) return;
      const selection: RuntimeTextSelection = {
        documentPath: message.documentPath,
        selector: message.selector,
        originalText: message.originalText,
        currentText: message.currentText,
        tagName: message.tagName,
        textMode: message.textMode,
        patchId: typeof message.patchId === 'string' ? message.patchId : undefined,
      };
      setRuntimeSelection(selection);
      setRuntimeValue(selection.currentText);
      setPickMode(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pickingRef.current) setPickMode(false);
    };
    window.addEventListener('message', handleMessage);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [course]);

  function switchDevice(next: 'Desktop' | 'Mobile') {
    editorRef.current?.setDevice(next);
    setDevice(next);
  }

  async function switchMode(next: WorkspaceMode) {
    if (next === mode) return;
    if (next === 'edit') {
      setPickMode(false);
      setMode('edit');
      modeRef.current = 'edit';
      setPreviewLoading(false);
      return;
    }
    if (!course) return;
    if (mode === 'edit') {
      setPreviewLoading(true);
      const ready = await onBeforePreview();
      if (!ready) {
        setPreviewLoading(false);
        return;
      }
      setPreviewRevision(Date.now());
    }
    if (next !== 'interact') setPickMode(false);
    setMode(next);
    modeRef.current = next;
    if (next === 'interact') {
      window.setTimeout(() => postRuntimeMessage({ type: 'set-pick-mode', enabled: pickingRef.current }));
    }
  }

  function refreshPreview() {
    setPickMode(false);
    setPreviewLoading(true);
    setPreviewRevision(Date.now());
  }

  async function handleImage(file?: File) {
    const editor = editorRef.current;
    if (!file || !course || !editor || !selected) return;
    setReplacing('image');
    try {
      const result = await replaceCourseImage(course.courseId, file, selectedImageSource(selected));
      selected.addAttributes({ src: `${result.url}?v=${Date.now()}` });
      editor.AssetManager.add({ src: result.url, name: file.name });
      onDirtyChange(true);
      onNotice({ type: 'success', message: '图片资源已替换，保存后会更新页面引用。' });
    } catch (error) {
      onNotice({ type: 'error', message: error instanceof Error ? error.message : '图片替换失败。' });
    } finally {
      setReplacing(null);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  }

  async function handleBackground(file?: File) {
    const editor = editorRef.current;
    if (!file || !course || !editor || !selected) return;
    setReplacing('background');
    try {
      const source = background?.source;
      const localPrefix = `/api/courses/${course.courseId}/files/`;
      const isLocal = Boolean(source && (source.includes(localPrefix) || source.startsWith(localPrefix)));
      const result = await replaceCourseImage(course.courseId, file, isLocal ? source : undefined);
      if (!isLocal) {
        selected.addStyle({
          'background-image': `url("${result.url}")`,
          'background-size': 'cover',
          'background-position': 'center',
          'background-repeat': 'no-repeat',
        });
        onDirtyChange(true);
      }
      editor.AssetManager.add({ src: result.url, name: file.name });
      setAssetRevision(Date.now());
      window.setTimeout(() => setBackground(selectedBackground(selected)), 50);
      onNotice({
        type: 'success',
        message: isLocal ? '背景图片已按原路径替换，所有引用会同步更新。' : '背景图片已添加，保存后写入页面样式。',
      });
    } catch (error) {
      onNotice({ type: 'error', message: error instanceof Error ? error.message : '背景图片处理失败。' });
    } finally {
      setReplacing(null);
      if (backgroundInputRef.current) backgroundInputRef.current.value = '';
    }
  }

  async function handleRuntimeTextSave() {
    if (!course || !runtimeSelection || !runtimeValue.trim()) return;
    setSavingRuntimeText(true);
    try {
      const patches = await saveRuntimeTextPatch(course.courseId, {
        id: runtimeSelection.patchId,
        documentPath: runtimeSelection.documentPath,
        selector: runtimeSelection.selector,
        originalText: runtimeSelection.originalText,
        replacementText: runtimeValue,
        textMode: runtimeSelection.textMode,
      });
      setRuntimePatches(patches);
      const saved = patches.find((patch) => patch.id === runtimeSelection.patchId) ?? patches.find((patch) => (
        patch.documentPath === runtimeSelection.documentPath
        && patch.selector === runtimeSelection.selector
        && patch.originalText === runtimeSelection.originalText
      ));
      if (saved) {
        postRuntimeMessage({ type: 'apply-text-patch', patch: saved });
        setRuntimeSelection({ ...runtimeSelection, patchId: saved.id, currentText: saved.replacementText });
      }
      onNotice({ type: 'success', message: '运行时文字已保存，导出的 SCORM 中也会生效。' });
    } catch (error) {
      onNotice({ type: 'error', message: error instanceof Error ? error.message : '运行时文字保存失败。' });
    } finally {
      setSavingRuntimeText(false);
    }
  }

  async function handleRuntimePatchDelete(patch: RuntimeTextPatch) {
    if (!course) return;
    try {
      setRuntimePatches(await removeRuntimeTextPatch(course.courseId, patch.id));
      postRuntimeMessage({ type: 'remove-text-patch', patch });
      if (runtimeSelection?.patchId === patch.id) {
        setRuntimeSelection({ ...runtimeSelection, patchId: undefined, currentText: patch.originalText });
        setRuntimeValue(patch.originalText);
      }
      onNotice({ type: 'success', message: '这条运行时文字修改已撤销。' });
    } catch (error) {
      onNotice({ type: 'error', message: error instanceof Error ? error.message : '撤销文字修改失败。' });
    }
  }

  const isImage = selected?.get('type') === 'image';
  const isRuntime = mode !== 'edit';

  return (
    <div className={`workspace workspace-${mode}`}>
      <aside className="left-panel" aria-label={mode === 'interact' ? '交互定位说明' : '组件面板'}>
        {mode === 'interact' ? (
          <>
            <div className="panel-heading">
              <Navigation size={17} aria-hidden="true" />
              <div><strong>交互定位</strong><span>先跳转，再选择文字</span></div>
            </div>
            <ol className="interaction-steps">
              <li><span>1</span><p><strong>正常操作课件</strong>点击开始、下一页或菜单，到达需要修改的位置。</p></li>
              <li><span>2</span><p><strong>开启选择文字</strong>再点击目标文字，此次点击不会触发课件动作。</p></li>
              <li><span>3</span><p><strong>在右侧修改</strong>保存后会写入课程，并随 SCORM 一起导出。</p></li>
            </ol>
            <section className="patch-list" aria-label="已保存的运行时文字修改">
              <div className="patch-list-heading"><strong>已修改文字</strong><span>{runtimePatches.length}</span></div>
              {runtimePatches.length ? runtimePatches.map((patch) => (
                <div className="patch-item" key={patch.id}>
                  <div><span>{patch.originalText}</span><strong>{patch.replacementText}</strong></div>
                  <button type="button" title="撤销这条修改" aria-label={`撤销“${patch.replacementText}”`} onClick={() => void handleRuntimePatchDelete(patch)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              )) : <p className="patch-empty">还没有运行时文字修改。</p>}
            </section>
          </>
        ) : (
          <>
            <div className="panel-heading">
              <Layers3 size={17} aria-hidden="true" />
              <div><strong>组件</strong><span>拖入画布</span></div>
            </div>
            <div ref={blocksRef} className="blocks-panel" />
            <div className="editor-tip">
              <Type size={16} aria-hidden="true" />
              <p><strong>编辑文字</strong><br />双击画布中的文字即可直接修改。</p>
            </div>
          </>
        )}
      </aside>

      <main className="canvas-area" id="editor-canvas">
        <div className="canvas-toolbar" aria-label="画布工具栏">
          <div className="toolbar-group">
            <button type="button" className="icon-button" aria-label="撤销" title="撤销" disabled={isRuntime} onClick={() => editorRef.current?.runCommand('core:undo')}>
              <Undo2 size={17} />
            </button>
            <button type="button" className="icon-button" aria-label="重做" title="重做" disabled={isRuntime} onClick={() => editorRef.current?.runCommand('core:redo')}>
              <Redo2 size={17} />
            </button>
          </div>
          <div className="toolbar-center">
            <div className="mode-switcher" aria-label="工作模式">
              <button type="button" className={mode === 'edit' ? 'active' : ''} aria-pressed={mode === 'edit'} onClick={() => void switchMode('edit')}>
                <Pencil size={15} />编辑
              </button>
              <button type="button" className={mode === 'interact' ? 'active' : ''} aria-pressed={mode === 'interact'} disabled={!course || previewLoading} onClick={() => void switchMode('interact')}>
                {previewLoading && mode === 'edit' ? <LoaderCircle size={15} className="spin" /> : <MousePointer2 size={15} />}交互定位
              </button>
              <button type="button" className={mode === 'preview' ? 'active' : ''} aria-pressed={mode === 'preview'} disabled={!course || previewLoading} onClick={() => void switchMode('preview')}>
                <Play size={15} />运行预览
              </button>
            </div>
            <div className="device-switcher" aria-label="预览尺寸">
              <button type="button" className={device === 'Desktop' ? 'active' : ''} aria-pressed={device === 'Desktop'} onClick={() => switchDevice('Desktop')}>
                <Monitor size={16} />桌面
              </button>
              <button type="button" className={device === 'Mobile' ? 'active' : ''} aria-pressed={device === 'Mobile'} onClick={() => switchDevice('Mobile')}>
                <Smartphone size={16} />手机
              </button>
            </div>
          </div>
          <div className="toolbar-end">
            {isRuntime && (
              <button type="button" className="icon-button" aria-label="重新加载运行画面" title="重新加载运行画面" onClick={refreshPreview}>
                <RefreshCw size={16} />
              </button>
            )}
            <span className="zoom-label">100% <ChevronDown size={13} aria-hidden="true" /></span>
          </div>
        </div>
        <div className={`canvas-shell ${course?.entryMode === 'nested' ? 'has-entry-banner' : ''}`}>
          {course?.entryMode === 'nested' && (
            <div className="entry-banner" role="status">
              <FileSearch size={16} aria-hidden="true" />
              <strong>已识别正文</strong>
              <code>{course.editPath}</code>
              <span>SCORM 启动页 {course.launchPath} 已保留</span>
            </div>
          )}
          <div className="canvas-stage">
            <div ref={editorHostRef} className={`gjs-host ${isRuntime ? 'is-hidden' : ''}`} />
            {isRuntime && course && (
              <div className={`runtime-preview runtime-preview-${device.toLowerCase()}`}>
                <div className={`runtime-status ${pickingText ? 'is-picking' : ''}`}>
                  {mode === 'interact' ? (
                    <>
                      <Navigation size={15} aria-hidden="true" />
                      <span>{pickingText ? '请点击要修改的文字，按 Esc 取消' : '课件交互已启用，可正常跳转'}</span>
                      <button type="button" className={pickingText ? 'active' : ''} aria-pressed={pickingText} onClick={() => setPickMode(!pickingText)}>
                        <ScanText size={14} />{pickingText ? '取消选择' : '选择文字'}
                      </button>
                    </>
                  ) : (
                    <><ShieldCheck size={15} aria-hidden="true" /><span>隔离运行课程脚本 · 显示已保存内容</span></>
                  )}
                </div>
                <div className="runtime-frame-shell">
                  {previewLoading && (
                    <div className="preview-loading" role="status">
                      <LoaderCircle size={22} className="spin" />正在启动课程…
                    </div>
                  )}
                  <iframe
                    ref={runtimeFrameRef}
                    key={previewRevision}
                    className="runtime-frame"
                    title={`${course.name} ${mode === 'interact' ? '交互定位' : '运行预览'}`}
                    src={`${course.previewUrl}?v=${previewRevision}`}
                    sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
                    allow="autoplay; fullscreen"
                    onLoad={() => {
                      setPreviewLoading(false);
                      postRuntimeMessage({ type: 'set-pick-mode', enabled: pickingRef.current });
                    }}
                  />
                </div>
              </div>
            )}
            {!course && (
              <div className="empty-canvas">
                <div className="empty-canvas-icon"><Layers3 size={28} /></div>
                <h2>上传课程后开始编辑</h2>
                <p>支持包含 HTML、CSS、JavaScript 和图片资源的 ZIP 课程包。</p>
              </div>
            )}
          </div>
        </div>
      </main>

      <aside className="right-panel" aria-label={mode === 'interact' ? '运行时文字编辑' : '属性面板'}>
        {mode === 'interact' ? (
          <>
            <div className="panel-heading">
              <ScanText size={17} aria-hidden="true" />
              <div><strong>运行时文字</strong><span>{runtimeSelection ? runtimeSelection.documentPath : '等待选择'}</span></div>
            </div>
            {runtimeSelection ? (
              <section className="runtime-text-editor">
                <div className="runtime-source">
                  <span>定位元素</span>
                  <code>{runtimeSelection.tagName} · {runtimeSelection.selector}</code>
                </div>
                <label htmlFor="runtime-text-original">原文字</label>
                <div id="runtime-text-original" className="runtime-original">{runtimeSelection.originalText}</div>
                <label htmlFor="runtime-text-value">修改为</label>
                <textarea id="runtime-text-value" value={runtimeValue} rows={7} onChange={(event) => setRuntimeValue(event.target.value)} />
                <button type="button" className="replace-button" disabled={savingRuntimeText || !runtimeValue.trim()} onClick={() => void handleRuntimeTextSave()}>
                  <ScanText size={16} />{savingRuntimeText ? '保存中…' : '保存这段文字'}
                </button>
                <p className="runtime-help">此修改会在课件脚本生成该文字后自动应用，不会破坏原跳转和测验逻辑。</p>
              </section>
            ) : (
              <div className="runtime-empty">
                <ScanText size={28} />
                <strong>尚未选择文字</strong>
                <p>先在课程中到达目标页面，点击上方“选择文字”，再点需要修改的内容。</p>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="panel-heading">
              <PanelRight size={17} aria-hidden="true" />
              <div><strong>属性</strong><span>{selected ? selected.getName() : '未选择元素'}</span></div>
            </div>
            {isImage && (
              <section className="image-actions">
                <div><strong>图片资源</strong><span>替换后保持原路径</span></div>
                <button type="button" className="replace-button" disabled={replacing !== null} onClick={() => imageInputRef.current?.click()}>
                  <ImagePlus size={16} />{replacing === 'image' ? '替换中…' : '替换图片'}
                </button>
                <input ref={imageInputRef} className="visually-hidden" type="file" accept="image/*" aria-label="选择替换图片" onChange={(event) => void handleImage(event.target.files?.[0])} />
              </section>
            )}
            {selected && (
              <section className="image-actions background-actions">
                <div>
                  <strong>背景图片</strong>
                  <span>{background ? `${background.layer === 'element' ? '当前元素' : `::${background.layer}`} · 保持原路径替换` : '当前元素没有图片背景，可添加'}</span>
                </div>
                {background && <code className="background-path">{background.source}</code>}
                <button type="button" className="replace-button" disabled={replacing !== null} onClick={() => backgroundInputRef.current?.click()}>
                  <ImagePlus size={16} />{replacing === 'background' ? '处理中…' : background ? '更换背景图片' : '添加背景图片'}
                </button>
                <input ref={backgroundInputRef} className="visually-hidden" type="file" accept="image/*" aria-label="选择背景图片" onChange={(event) => void handleBackground(event.target.files?.[0])} />
              </section>
            )}
            <div className="property-tabs" role="tablist" aria-label="属性类型">
              <button type="button" role="tab" aria-selected="true">样式</button>
              <button type="button" role="tab" aria-selected="false">设置</button>
            </div>
            <div ref={stylesRef} className="styles-panel" />
            <div ref={traitsRef} className="traits-panel" />
            {!selected && <p className="property-empty">选择画布中的元素，在这里调整尺寸、间距、文字、背景和外观。</p>}
          </>
        )}
      </aside>
    </div>
  );
}
