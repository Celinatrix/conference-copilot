export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...rest,
      headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError('Không kết nối được máy chủ. Kiểm tra mạng hoặc server API.', 0, 'network');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const fallback = res.status >= 500 ? 'Máy chủ gặp lỗi hoặc chưa chạy (cổng 4000).' : `Lỗi ${res.status}`;
    throw new ApiError(data?.message || fallback, res.status, data?.error);
  }
  return data as T;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Conference {
  id: string;
  workspace_id: string;
  created_by: string;
  name: string;
  starts_at: string | null;
  location: string;
  speakers: string;
  input_language: string;
  glossary: string;
  visibility: 'private' | 'workspace';
  status: 'draft' | 'live' | 'paused' | 'ended';
  created_at: string;
  updated_at: string;
  segment_count?: number;
  response_modes?: ResponseMode[];
  /** null = server default (Haiku first drafts). */
  answer_model?: string | null;
  permissions?: { canManage: boolean; canDelete: boolean };
}

export interface KbDocument {
  id: string;
  filename: string;
  kind: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv';
  size_bytes: number;
  status: 'processing' | 'ready' | 'error';
  error: string | null;
  unit_count: number;
  char_count: number;
  warning: string | null;
  created_at: string;
}

export type ResponseMode = 'professional' | 'concise' | 'strategic' | 'academic' | 'technical';

export const RESPONSE_MODE_LABELS: Record<ResponseMode, string> = {
  concise: 'Ngắn gọn',
  professional: 'Đầy đủ',
  technical: 'Chuyên sâu',
  strategic: 'Chiến lược',
  academic: 'Học thuật',
};

export interface AnswerCitation {
  chunk_id: string;
  document_id: string;
  filename: string;
  locator: string;
  quote: string;
}

export interface StructuredAnswer {
  analysis_vi: string;
  options: { mode: ResponseMode; vi: string; en: string; citations: AnswerCitation[] }[];
  missing: string;
  follow_ups: string[];
  context: 'all' | 'ranked' | 'none' | 'no_match';
}

export interface Question {
  id: string;
  conference_id: string;
  segment_id: string | null;
  source: 'auto' | 'manual';
  /** 'comment' = a judge's remark on the presentation ("Nhận xét"): listed with its own numbers, never answered. */
  kind?: 'question' | 'comment';
  text_original: string;
  text_vi: string | null;
  status: 'detected' | 'answering' | 'answered' | 'error' | 'awaiting_click' | 'awaiting_confirm' | 'dismissed' | 'noted';
  error: string | null;
  unclear_reason: string | null;
  /** "Câu N" in the conference, in the order questions were asked (kept when others are removed). */
  seq: number | null;
  answer: StructuredAnswer | null;
  answer_model: string | null;
  created_at: string;
}

/** Models a conference can pick for drafting answers (must match the server's ANSWER_MODEL_CHOICES). */
export const ANSWER_MODELS: { id: string; name: string; note: string; cost: string }[] = [
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', note: 'Nhanh, rẻ nhất', cost: '~$0.002/câu' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', note: 'Lập luận chặt hơn', cost: '~$0.08/câu' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'Tốt nhất, chậm hơn', cost: '~$0.15/câu' },
];
export const DEFAULT_ANSWER_MODEL = 'claude-haiku-5-5';

export const isComment = (q: Pick<Question, 'kind'>) => q.kind === 'comment';

/** "Câu 3" for a question, "Nhận xét 2" for a judge's remark (empty when the number is unknown). */
export function questionLabel(q: Pick<Question, 'seq' | 'kind'>): string {
  if (!q.seq) return '';
  return isComment(q) ? `Nhận xét ${q.seq}` : `Câu ${q.seq}`;
}

/**
 * Fills in numbers the server did not send (a server not yet migrated): questions and remarks are each numbered by
 * the order they were heard, counting removed ones too so the numbers do not shift. Server numbers win when present.
 */
export function numberQuestions(list: Question[]): Question[] {
  if (list.every((q) => q.seq)) return list;
  const fallback = new Map<string, number>();
  for (const comment of [false, true]) {
    const order = list
      .filter((q) => isComment(q) === comment)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    order.forEach((q, i) => fallback.set(q.id, i + 1));
  }
  return list.map((q) => (q.seq ? q : { ...q, seq: fallback.get(q.id) ?? null }));
}

/** Short display name for the model that drafted an answer. */
export function modelLabel(model: string | null): string {
  if (!model) return '';
  if (model.includes('haiku')) return 'Haiku · nháp nhanh';
  if (model.includes('sonnet')) return 'Sonnet · soạn kỹ';
  if (model.includes('opus')) return 'Opus · soạn kỹ';
  return model;
}

export interface Segment {
  id: string;
  conference_id: string;
  session_id: string;
  seq: number;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  language: string | null;
  confidence: number | null;
  text_original: string;
  text_vi: string | null;
  translation_status: 'pending' | 'done' | 'error' | 'skipped';
  translation_error: string | null;
  is_important: boolean;
  edited: boolean;
  created_at: string;
  updated_at: string;
}

export interface SystemStatus {
  database: string;
  stt: { provider: string; configured: boolean; model: string };
  translation: { provider: string; configured: boolean; model: string };
}

export interface Usage {
  items: { kind: string; provider: string; unit: string; units: number; cost_usd: number }[];
  totalUsd: number;
}

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'multi', label: 'Tự động nhận diện (đa ngôn ngữ)' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語 (Japanese)' },
  { code: 'ko', label: '한국어 (Korean)' },
  { code: 'zh', label: '中文 (Chinese)' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
  { code: 'vi', label: 'Tiếng Việt' },
];

export const languageLabel = (code: string | null) =>
  code ? (LANGUAGES.find((l) => l.code === code)?.label.split(' (')[0] ?? code.toUpperCase()) : '—';
