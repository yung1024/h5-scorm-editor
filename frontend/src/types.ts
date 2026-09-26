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

export interface RuntimeTextSelection {
  documentPath: string;
  selector: string;
  originalText: string;
  currentText: string;
  tagName: string;
  textMode: 'element' | 'direct';
  patchId?: string;
}

export type Notice = {
  type: 'success' | 'error' | 'info';
  message: string;
} | null;
