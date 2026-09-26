import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Image, FileText, Play, Undo2, RefreshCw } from 'lucide-react';
import { getMaintenance, updateMaintenanceText, updateMaintenanceImage, undoMaintenance, type MaintenanceData, type MaintenanceText, type MaintenanceImage } from './api';
import type { CoursePayload, Notice } from './types';
import './maintenance.css';

// Keep the original resource path and encoding, including when a PNG replaces a WebP.
async function prepareImage(file: File, target: string): Promise<File> {
  const ext = target.split('.').at(-1)?.toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : undefined;
  if (!mime) {
    if ((ext === 'gif' && file.type === 'image/gif') || (ext === 'svg' && file.type === 'image/svg+xml')) return file;
    throw new Error('这类图片请使用同格式的 GIF 或 SVG 替换。');
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new window.Image(); img.src = url;
    try { await img.decode(); } catch { throw new Error('无法读取这张图片，请选择有效的 PNG、JPG 或 WebP 图片。'); }
    if (!img.naturalWidth || img.naturalWidth * img.naturalHeight > 40000000) throw new Error('请选择不超过 4000 万像素的图片。');
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('无法处理图片。');
    if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片转换失败。')), mime, 0.94));
    if (blob.type !== mime) throw new Error('当前环境不支持转换为此图片格式。');
    return new File([blob], target.split('/').at(-1)!, { type: mime });
  } finally { URL.revokeObjectURL(url); }
}

type Props = { course: CoursePayload; onNotice: (notice: Notice) => void; onState: (state: { dirty: boolean; busy: boolean }) => void };
export function MaintenanceWorkspace({ course, onNotice, onState }: Props) {
  const [data, setData] = useState<MaintenanceData | null>(null);
  const [mode, setMode] = useState<'text' | 'image' | 'preview'>('text');
  const [query, setQuery] = useState('');
  const [fileFilter, setFileFilter] = useState('');
  const [selection, setSelection] = useState<MaintenanceText | null>(null);
  const [value, setValue] = useState('');
  const [picture, setPicture] = useState<MaintenanceImage | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [pendingUrl, setPendingUrl] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [previewPage, setPreviewPage] = useState(course.editPath);
  const [revision, setRevision] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const dirty = Boolean((selection && value !== selection.text) || pending);
  useEffect(() => { onState({ dirty, busy }); }, [dirty, busy, onState]);
  useEffect(() => () => onState({ dirty: false, busy: false }), [onState]);
  useEffect(() => {
    if (!pending) { setPendingUrl(''); return; }
    const url = URL.createObjectURL(pending); setPendingUrl(url); return () => URL.revokeObjectURL(url);
  }, [pending]);
  const reload = useCallback(async () => {
    const result = await getMaintenance(course.courseId); setData(result); setRevision(Date.now()); setError('');
  }, [course.courseId]);
  useEffect(() => {
    let cancelled = false;
    getMaintenance(course.courseId).then(result => { if (!cancelled) setData(result); })
      .catch(e => { if (!cancelled) setError(String(e.message)); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [course.courseId]);
  async function action(work: () => Promise<void>, message: string) {
    setBusy(true);
    try {
      await work(); setSelection(null); setValue(''); setPending(null); setPicture(null);
      await reload(); onNotice({ type: 'success', message });
    } catch (e) { const message = e instanceof Error ? e.message : '操作失败，请重试。'; setError(message); onNotice({ type: 'error', message }); }
    finally { setBusy(false); }
  }
  const locked = busy || dirty;
  const search = query.trim().toLocaleLowerCase();
  const texts = data?.texts.filter(item => (!fileFilter || item.file === fileFilter) && `${item.text} ${item.section} ${item.file}`.toLocaleLowerCase().includes(search)) ?? [];
  const images = data?.images.filter(item => item.file.toLocaleLowerCase().includes(search)) ?? [];
  const textFiles = [...new Set(data?.texts.map(item => item.file) ?? [])];
  const sourceLabel = (file: string) => {
    if (file.endsWith('course-data.js')) return '共享课程文案（各章节正文）';
    if (file.endsWith('questions.js')) return '测验题目文案';
    if (file.endsWith('.js')) return `页面固定文案 · ${file.split('/').at(-1)!.replace('.js', '')}`;
    const lesson = file.match(/lesson-(\d+)-(\d+)/);
    const chapter = file.match(/chapter-0?(\d+)/);
    const prefix = lesson ? `小节 ${lesson[1]}.${lesson[2]}` : chapter ? `第 ${chapter[1]} 章` : file.includes('assessment') || file.includes('test') ? '结业测试' : file.includes('completion') ? '课程结束' : '课程首页';
    return `${file.includes('course-full') ? '全课版 · ' : ''}${prefix} · ${data?.pages.find(p => p.file === file)?.title || file}`;
  };
  return <section className="maintenance" id="editor-canvas" aria-label="文案与图片维护">
    <header className="maintenance-toolbar">
      <div className="maintenance-tabs" role="tablist" aria-label="维护内容">
        <button role="tab" aria-selected={mode === 'text'} disabled={locked} onClick={() => { setMode('text'); setQuery(''); }}><FileText size={17}/>文案</button>
        <button role="tab" aria-selected={mode === 'image'} disabled={locked} onClick={() => { setMode('image'); setQuery(''); }}><Image size={17}/>图片</button>
        <button role="tab" aria-selected={mode === 'preview'} disabled={locked} onClick={() => { setMode('preview'); setRevision(Date.now()); }}><Play size={17}/>预览</button>
      </div>
      <span className="maintenance-status" role="status">{busy ? '正在处理…' : dirty ? '有待保存的修改，请保存或取消' : '修改自动保存在课程副本中'}</span>
      <button className="button button-ghost" disabled={locked || !data?.lastChange} title={data?.lastChange?.label} onClick={() => void action(() => undoMaintenance(course.courseId), '已撤销最近一次修改。')}><Undo2 size={16}/>撤销最近修改</button>
      <button className="icon-button" aria-label="刷新维护列表" disabled={locked} onClick={() => void action(reload, '列表已刷新。')}><RefreshCw size={16}/></button>
    </header>
    {error && <div className="maintenance-error" role="alert">{error}</div>}
    {!data ? <div className="maintenance-empty">{busy ? '正在读取各章节文案和图片…' : <button onClick={() => void action(reload, '已重新读取课程。')}>重新读取课程</button>}</div> : mode === 'preview' ? <div className="maintenance-preview">
      <label>预览页面 <select aria-label="预览页面" value={previewPage} onChange={e => setPreviewPage(e.target.value)}>{data.pages.map(page => <option key={page.file} value={page.file}>{sourceLabel(page.file)}</option>)}</select></label>
      <p>这里用于查看修改效果。文案和图片可直接在维护列表中修改，无需完成课程学习。</p>
      <iframe title="课程维护预览" key={`${previewPage}:${revision}`} src={`${course.previewUrl}${previewPage.split('/').map(encodeURIComponent).join('/')}?progress=999&v=${revision}`} sandbox="allow-scripts allow-forms allow-modals" allow="autoplay; fullscreen"/>
    </div> : <div className="maintenance-columns">
      <aside className="maintenance-library" aria-label={mode === 'text' ? '课程文案列表' : '课程图片列表'}>
        <div className="maintenance-search"><Search size={17}/><input aria-label={mode === 'text' ? '搜索文案或章节' : '搜索图片'} placeholder={mode === 'text' ? '搜索错字、文案或章节' : '搜索图片名称'} value={query} disabled={locked} onChange={e => setQuery(e.target.value)}/></div>
        {mode === 'text' && <select aria-label="筛选文案来源" value={fileFilter} disabled={locked} onChange={e => setFileFilter(e.target.value)}><option value="">全部章节与页面</option>{textFiles.map(file => <option key={file} value={file}>{sourceLabel(file)}</option>)}</select>}
        <p className="maintenance-count">{mode === 'text' ? `${texts.length} 段文案 · 包含各章节及共享课程数据` : `${images.length} 张图片 · 点击查看大图`}</p>
        <div className={mode === 'text' ? 'maintenance-text-list' : 'maintenance-image-list'}>
          {mode === 'text' ? texts.slice(0, 300).map(item => <button className={`maintenance-text-card ${selection?.id === item.id && selection.file === item.file ? 'selected' : ''}`} key={`${item.file}:${item.id}`} disabled={locked} onClick={() => { setSelection(item); setValue(item.text); setError(''); }}><small>{item.section}</small><span>{item.text}</span><em>{item.kind === 'data' ? '共享文案' : '页面文案'}</em></button>) : images.map(item => <button className={`maintenance-image-card ${picture?.file === item.file ? 'selected' : ''}`} key={item.file} disabled={locked} onClick={() => { setPicture(item); setError(''); }}><img loading="lazy" src={`${item.url}?v=${revision}`} alt={item.file.split('/').at(-1)}/><span>{item.file.split('/').at(-1)}</span></button>)}
          {mode === 'text' && texts.length > 300 && <p>当前显示前 300 条，请搜索或选择来源缩小范围。</p>}
          {(mode === 'text' ? texts : images).length === 0 && <p>没有找到匹配的内容。</p>}
        </div>
      </aside>
      <main className="maintenance-detail">
        {mode === 'text' ? selection ? <>
          <span className="maintenance-eyebrow">修改文案</span><h2>{selection.section}</h2>
          <p>{selection.kind === 'data' ? '此处保存会更新共享课程文案，使用这条数据的页面会同步变化。' : '此处保存会更新当前页面。其他页面的相同文字可通过搜索逐项修改。'}</p>
          <label htmlFor="maintenance-text">文案内容</label><textarea id="maintenance-text" value={value} disabled={busy} onChange={e => setValue(e.target.value)} maxLength={30000}/>
          <div className="maintenance-actions"><button className="button button-primary" disabled={busy || value === selection.text} onClick={() => void action(() => updateMaintenanceText(course.courseId, selection, value), '文案已保存，可切换预览查看效果。')}>保存文案</button><button className="button button-ghost" disabled={busy} onClick={() => setValue(selection.text)}>取消修改</button></div>
          <details><summary>内容位置</summary><p>{selection.file}</p></details>
        </> : <div className="maintenance-empty"><FileText size={38}/><h2>找到文字，就能修改</h2><p>在左侧搜索错字或文案，选择结果后编辑。标题、正文、说明和题目文案均可在列表中查找。</p></div> : picture ? <>
          <span className="maintenance-eyebrow">替换图片</span><h2>{picture.file.split('/').at(-1)}</h2>
          <p>替换后，所有使用这张图片的位置都会更新。可以撤销最近一次替换。</p>
          <div className="maintenance-image-preview"><img src={pendingUrl || `${picture.url}?v=${revision}`} alt={pending ? '待保存的新图片' : '当前课程图片'}/></div>
          {pending && <p>待替换为：{pending.name}</p>}
          <input ref={input} className="visually-hidden" type="file" accept="image/*" aria-label="选择新的课程图片" onChange={e => { setPending(e.target.files?.[0] ?? null); e.target.value = ''; }}/>
          <div className="maintenance-actions"><button className="button button-ghost" disabled={busy} onClick={() => input.current?.click()}>选择新图片</button><button className="button button-primary" disabled={!pending || busy} onClick={() => void action(async () => updateMaintenanceImage(course.courseId, picture, await prepareImage(pending!, picture.file)), '图片已替换，可切换预览查看效果。')}>保存替换</button>{pending && <button className="button button-ghost" disabled={busy} onClick={() => setPending(null)}>取消</button>}</div>
          <p className="maintenance-tip">PNG、JPG、WebP 会自动适配原图片格式；GIF、SVG 请使用同格式图片。</p><details><summary>图片位置</summary><p>{picture.file}</p></details>
        </> : <div className="maintenance-empty"><Image size={38}/><h2>选择图片，预览后替换</h2><p>包含章节配图、操作截图、封面和背景图。</p></div>}
      </main>
    </div>}
  </section>;
}
