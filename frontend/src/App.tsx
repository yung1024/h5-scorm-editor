import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from 'grapesjs';
import { Check, Download, FileArchive, Save, Sparkles, Upload, X } from 'lucide-react';
import { exportCourse, getCourse, saveCourse, uploadCourse } from './api';
import { EditorWorkspace } from './EditorWorkspace';
import { MaintenanceWorkspace } from './MaintenanceWorkspace';
import type { CoursePayload, Notice } from './types';

export default function App() {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [course, setCourse] = useState<CoursePayload | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<'upload' | 'save' | 'export' | null>(null);
  const [dirty, setDirty] = useState(false);
  const [workspace, setWorkspace] = useState<'maintenance' | 'layout'>('maintenance');
  const [maintenanceState, setMaintenanceState] = useState({ dirty: false, busy: false });

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!course || course.editPath) return;
    let cancelled = false;
    void getCourse(course.courseId)
      .then((upgraded) => {
        if (!cancelled) setCourse(upgraded);
      })
      .catch((error: unknown) => {
        if (!cancelled) setNotice({ type: 'error', message: error instanceof Error ? error.message : '课程兼容升级失败。' });
      });
    return () => { cancelled = true; };
  }, [course]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty && !maintenanceState.dirty) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, maintenanceState.dirty]);

  const handleEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor;
  }, []);

  const handleDirtyChange = useCallback((value: boolean) => setDirty(value), []);

  async function handleUpload(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setNotice({ type: 'error', message: '请选择 .zip 格式的 H5 课程包。' });
      return;
    }
    setBusy('upload');
    try {
      const result = await uploadCourse(file);
      setCourse(result);
      setWorkspace('maintenance');
      setDirty(false);
      setNotice({ type: 'success', message: `“${result.name}”已加载，可以开始编辑。` });
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : '课程上传失败。' });
    } finally {
      setBusy(null);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  }

  async function persist(showNotice = true) {
    if (workspace === 'maintenance' || !dirty) return true;
    const editor = editorRef.current;
    if (!course || !editor) return false;
    await saveCourse(course.courseId, editor.getHtml(), editor.getCss() ?? '');
    setDirty(false);
    if (showNotice) setNotice({ type: 'success', message: '课程修改已保存。' });
    return true;
  }

  async function handleSave() {
    setBusy('save');
    try {
      await persist();
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : '保存失败。' });
    } finally {
      setBusy(null);
    }
  }

  async function handleBeforePreview() {
    if (!course || busy) return false;
    setBusy('save');
    try {
      return await persist(false);
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : '预览前保存失败。' });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function handleExport() {
    if (!course) return;
    setBusy('export');
    try {
      await persist(false);
      await exportCourse(course.courseId, course.name);
      setNotice({ type: 'success', message: 'SCORM 1.2 课程包已生成并下载。' });
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'SCORM 导出失败。' });
    } finally {
      setBusy(null);
    }
  }

  const isWorking = busy !== null;
  const maintenanceLocked = maintenanceState.dirty || maintenanceState.busy;

  async function switchWorkspace(next: 'maintenance' | 'layout') {
    if (next === workspace || isWorking || maintenanceLocked) return;
    setBusy('save');
    try {
      await persist(false);
      if (course && next === 'layout') setCourse(await getCourse(course.courseId));
      setDirty(false); setWorkspace(next);
    } catch (e) { setNotice({ type: 'error', message: e instanceof Error ? e.message : '切换失败。' }); }
    finally { setBusy(null); }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#editor-canvas">跳到编辑画布</a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={19} /></span>
          <div>
            <h1>H5 SCORM Editor</h1>
            <span>课程维护工具 · v1.0.3</span>
          </div>
        </div>

        <div className="course-state" aria-live="polite">
          {course ? (
            <>
              <FileArchive size={16} />
              <div>
                <strong>{course.name}</strong>
                <span>{dirty || maintenanceState.dirty ? '有未保存修改' : '课程副本已保存'}</span>
              </div>
              {!dirty && !maintenanceState.dirty && <Check size={15} className="saved-check" />}
            </>
          ) : <span>尚未上传课程</span>}
        </div>

        <nav className="top-actions" aria-label="课程操作">
          <button type="button" className="button button-ghost" disabled={isWorking || maintenanceLocked || dirty} onClick={() => uploadInputRef.current?.click()}>
            <Upload size={17} />{busy === 'upload' ? '上传中…' : '上传课程'}
          </button>
          <input
            ref={uploadInputRef}
            className="visually-hidden"
            type="file"
            accept=".zip,application/zip"
            aria-label="选择 H5 课程 ZIP 包"
            onChange={(event) => void handleUpload(event.target.files?.[0])}
          />
          {workspace === 'layout' && <button type="button" className="button button-ghost" disabled={!course || isWorking} onClick={() => void handleSave()}>
            <Save size={17} />{busy === 'save' ? '保存中…' : '保存'}
          </button>}
          <button type="button" className="button button-primary" disabled={!course || isWorking || maintenanceLocked} onClick={() => void handleExport()}>
            <Download size={17} />{busy === 'export' ? '生成中…' : '导出 SCORM'}
          </button>
        </nav>
      </header>
      <nav className="workspace-switch" aria-label="编辑方式">
        <button aria-pressed={workspace === 'maintenance'} disabled={isWorking || maintenanceLocked} onClick={() => void switchWorkspace('maintenance')}>文案与图片</button>
        <button aria-pressed={workspace === 'layout'} disabled={isWorking || maintenanceLocked} onClick={() => void switchWorkspace('layout')}>首页排版</button>
        <span>{workspace === 'maintenance' ? '搜索各章节文案、替换图片，保存后导出新课件' : '调整首页静态元素；章节文案和图片请使用“文案与图片”'}</span>
      </nav>
      {workspace === 'maintenance' ? course ? <MaintenanceWorkspace key={course.courseId} course={course} onNotice={setNotice} onState={setMaintenanceState}/> : <main className="maintenance-empty" id="editor-canvas"><FileArchive size={44}/><h2>上传课程，开始维护</h2><p>支持搜索各章节文字、修改文案、替换图片，并导出新的 SCORM 课件。</p><button className="button button-primary" disabled={isWorking} onClick={() => uploadInputRef.current?.click()}>选择课程 ZIP</button></main> : <EditorWorkspace
        course={course}
        onEditorReady={handleEditorReady}
        onDirtyChange={handleDirtyChange}
        onNotice={setNotice}
        onBeforePreview={handleBeforePreview}
      />}

      {notice && (
        <div className={`toast toast-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'} aria-live="polite">
          <span>{notice.type === 'success' ? <Check size={17} /> : <FileArchive size={17} />}</span>
          <p>{notice.message}</p>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16} /></button>
        </div>
      )}
    </div>
  );
}
