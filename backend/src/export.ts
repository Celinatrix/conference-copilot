import type { SegmentDto } from './live/protocol.js';

export type ExportFormat = 'md' | 'txt';
export type ExportView = 'both' | 'original' | 'vi';

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function formatTranscript(
  conference: { name: string; location: string; starts_at: string | Date | null },
  segments: SegmentDto[],
  format: ExportFormat,
  view: ExportView,
): string {
  const md = format === 'md';
  const lines: string[] = [];
  const when = conference.starts_at ? new Date(conference.starts_at).toLocaleString('vi-VN') : '';
  lines.push(md ? `# ${conference.name}` : conference.name.toUpperCase());
  const meta = [when, conference.location].filter(Boolean).join(' · ');
  if (meta) lines.push(md ? `_${meta}_` : meta);
  lines.push(md ? '' : '='.repeat(40), '');

  let currentSession = '';
  let sessionIndex = 0;
  for (const s of segments) {
    if (s.session_id !== currentSession) {
      currentSession = s.session_id;
      sessionIndex++;
      lines.push(md ? `## Phiên ${sessionIndex}` : `--- Phiên ${sessionIndex} ---`, '');
    }
    const head = [`[${formatClock(s.start_ms)}]`, s.speaker, s.language ? `(${s.language})` : null, s.is_important ? '★' : null]
      .filter(Boolean)
      .join(' ');
    lines.push(md ? `**${head}**` : head);
    if (view !== 'vi') lines.push(md ? `> ${s.text_original}` : `  ${s.text_original}`);
    if (view !== 'original') {
      const vi = s.text_vi ?? (s.translation_status === 'error' ? '(chưa dịch được)' : '(đang dịch)');
      lines.push(md && view === 'both' ? `${vi}` : `  ${vi}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
