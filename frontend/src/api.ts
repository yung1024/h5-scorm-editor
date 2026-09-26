import type { CoursePayload, RuntimeTextPatch } from './types';

interface DesktopConfig {
  desktop: boolean;
  token?: string;
}

let desktopConfigPromise: Promise<DesktopConfig> | undefined;

async function desktopConfig(): Promise<DesktopConfig> {
  desktopConfigPromise ??= fetch('/api/desktop-config', { cache: 'no-store' })
    .then(async (response) => response.ok ? response.json() as Promise<DesktopConfig> : { desktop: false })
    .catch(() => ({ desktop: false }));
  return desktopConfigPromise;
}

async function editorHeaders(initial?: HeadersInit): Promise<Headers> {
  const headers = new Headers(initial);
  const config = await desktopConfig();
  if (config.token) headers.set('X-H5-Editor-Token', config.token);
  return headers;
}

async function parseError(response: Response): Promise<never> {
  let message = `请求失败（${response.status}）`;
  try {
    const data = await response.json() as { message?: string };
    if (data.message) message = data.message;
  } catch {
    // Keep the HTTP fallback when the response is not JSON.
  }
  throw new Error(message);
}

export async function uploadCourse(file: File): Promise<CoursePayload> {
  const form = new FormData();
  form.append('course', file);
  const response = await fetch('/api/courses/upload', { method: 'POST', headers: await editorHeaders(), body: form });
  if (!response.ok) return parseError(response);
  return response.json() as Promise<CoursePayload>;
}

export async function getCourse(courseId: string): Promise<CoursePayload> {
  const response = await fetch(`/api/courses/${courseId}`, { headers: await editorHeaders() });
  if (!response.ok) return parseError(response);
  return response.json() as Promise<CoursePayload>;
}

export async function saveCourse(courseId: string, html: string, css: string): Promise<void> {
  const response = await fetch(`/api/courses/${courseId}`, {
    method: 'PUT',
    headers: await editorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ html, css }),
  });
  if (!response.ok) return parseError(response);
}

export async function replaceCourseImage(courseId: string, file: File, targetPath?: string) {
  const form = new FormData();
  form.append('image', file);
  if (targetPath) form.append('targetPath', targetPath);
  const response = await fetch(`/api/courses/${courseId}/assets`, { method: 'POST', headers: await editorHeaders(), body: form });
  if (!response.ok) return parseError(response);
  return response.json() as Promise<{ path: string; url: string }>;
}

export async function saveRuntimeTextPatch(
  courseId: string,
  patch: Omit<RuntimeTextPatch, 'id'> & { id?: string },
): Promise<RuntimeTextPatch[]> {
  const response = await fetch(`/api/courses/${courseId}/runtime-patches`, {
    method: 'POST',
    headers: await editorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch),
  });
  if (!response.ok) return parseError(response);
  const result = await response.json() as { patches: RuntimeTextPatch[] };
  return result.patches;
}

export async function removeRuntimeTextPatch(courseId: string, patchId: string): Promise<RuntimeTextPatch[]> {
  const response = await fetch(`/api/courses/${courseId}/runtime-patches/${encodeURIComponent(patchId)}`, {
    method: 'DELETE',
    headers: await editorHeaders(),
  });
  if (!response.ok) return parseError(response);
  const result = await response.json() as { patches: RuntimeTextPatch[] };
  return result.patches;
}

export async function exportCourse(courseId: string, fileName: string): Promise<void> {
  const response = await fetch(`/api/courses/${courseId}/export`, { headers: await editorHeaders() });
  if (!response.ok) return parseError(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const suggested = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  link.download = suggested ? decodeURIComponent(suggested) : `${fileName}_scorm.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export interface MaintenanceText { id: string; file: string; section: string; text: string; revision: string; kind: 'page' | 'data' }
export interface MaintenanceImage { file: string; url: string; revision: string }
export interface MaintenanceData {
  texts: MaintenanceText[];
  images: MaintenanceImage[];
  pages: Array<{ file: string; title: string }>;
  lastChange: { label: string; createdAt: string } | null;
}
export async function getMaintenance(courseId: string): Promise<MaintenanceData> {
  const response = await fetch(`/api/courses/${courseId}/maintenance`, { headers: await editorHeaders() });
  if (!response.ok) return parseError(response);
  return response.json();
}
export async function updateMaintenanceText(courseId: string, item: MaintenanceText, text: string) {
  const response = await fetch(`/api/courses/${courseId}/maintenance/text`, {
    method: 'PUT', headers: await editorHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ ...item, text }),
  });
  if (!response.ok) return parseError(response);
}
export async function updateMaintenanceImage(courseId: string, image: MaintenanceImage, file: File) {
  const form = new FormData(); form.append('file', image.file); form.append('revision', image.revision); form.append('image', file);
  const response = await fetch(`/api/courses/${courseId}/maintenance/image`, { method: 'POST', headers: await editorHeaders(), body: form });
  if (!response.ok) return parseError(response);
}
export async function undoMaintenance(courseId: string) {
  const response = await fetch(`/api/courses/${courseId}/maintenance/undo`, { method: 'POST', headers: await editorHeaders() });
  if (!response.ok) return parseError(response);
}
