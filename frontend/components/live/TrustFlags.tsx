'use client';

/**
 * Warnings the backend attaches to a translated line (see backend/src/ai/trust.ts): where the reader should not
 * trust the screen blindly. 'low_confidence', 'number:<digits>', 'term:<glossary term>'.
 */
function describe(flag: string): { label: string; hint: string } {
  if (flag === 'low_confidence') return { label: 'Nghe chưa rõ', hint: 'Độ tin cậy nhận dạng thấp: nội dung gốc có thể bị nghe sai.' };
  if (flag.startsWith('number:')) {
    const n = flag.slice(7);
    return { label: `Kiểm tra số ${n}`, hint: `Số ${n} có trong bản gốc nhưng không thấy trong bản dịch.` };
  }
  if (flag.startsWith('term:')) {
    const t = flag.slice(5);
    return { label: `Thuật ngữ: ${t}`, hint: `"${t}" không được dịch theo glossary của hội nghị.` };
  }
  return { label: flag, hint: flag };
}

export function TrustFlags({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {flags.map((f) => {
        const { label, hint } = describe(f);
        return (
          <span key={f} title={hint} className="rounded-md border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[0.6em] font-medium leading-tight text-warn">
            ⚠ {label}
          </span>
        );
      })}
    </div>
  );
}
