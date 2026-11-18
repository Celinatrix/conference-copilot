import { describe, expect, it } from 'vitest';
import { modelOptions } from '../src/ai/responder.js';

// Each family rejects the others' "no thinking" setting with a 400, so the mapping is pinned here.
describe('answer model options', () => {
  it('Haiku 5.5: thinking disabled, no server-side fallback (unsupported there)', () => {
    const o = modelOptions('claude-haiku-5-5');
    expect(o.thinking).toEqual({ type: 'disabled' });
    expect(o.fallbacks).toBeUndefined();
    expect(o.betas).toBeUndefined();
  });

  it('Sonnet 5.5: between_tools with the default fallback', () => {
    const o = modelOptions('claude-sonnet-5-5');
    expect(o.thinking).toEqual({ type: 'between_tools' });
    expect(o.fallbacks).toBe('default');
    expect(o.betas).toEqual(['server-side-fallback-2026-07-01']);
  });

  it('Opus 5.5: thinking left on (cannot be disabled), low effort', () => {
    const o = modelOptions('claude-opus-5-5');
    expect(o.thinking).toBeUndefined();
    expect(o.output_config).toEqual({ effort: 'low' });
  });
});
