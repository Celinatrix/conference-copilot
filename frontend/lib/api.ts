import type { ResponseMode, SegmentDto } from '@conference-copilot/shared';

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
  /** Up to 3 suggested-answer styles, in display order. */
  response_modes?: ResponseMode[];
  created_at: string;
  updated_at: string;
  segment_count?: number;
  permissions?: { canManage: boolean; canDelete: boolean };
}

/** Transcript line, as the backend sends it (shared contract). */
export type Segment = SegmentDto;

export interface SystemStatus {
  database: string;
  stt: { provider: string; configured: boolean; model: string };
  translation: { provider: string; configured: boolean; model: string };
  answers: { provider: string; configured: boolean; model: string; autoBudgetUsd: number };
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
