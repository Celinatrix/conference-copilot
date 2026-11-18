'use client';

/**
 * Short "ting" for a new question, synthesised with Web Audio (no sound file). Browsers, iPhone above all, only
 * allow audio after the user has touched the page, so the context is created and resumed on the first tap or key.
 */
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

/** Call once at start-up: unlocks audio on the first user gesture. */
export function primeChime() {
  if (typeof window === 'undefined') return;
  const unlock = () => {
    const c = context();
    if (c && c.state === 'suspended') void c.resume();
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true });
}

/** Two quick bell tones (E6 then A6), ~0.35 s, gentle volume. */
export function playChime() {
  const c = context();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
  const now = c.currentTime;
  [
    [1318.5, 0],
    [1760, 0.11],
  ].forEach(([freq, delay]) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = now + delay;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  });
  // Android also buzzes; iPhone ignores this.
  navigator.vibrate?.(120);
}
