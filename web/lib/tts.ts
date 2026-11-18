'use client';

/** Female Vietnamese voices, in order of preference: Edge "HoaiMy" (PC), Apple "Linh" (iPhone/iPad/Mac). */
const FEMALE_VOICES = [/HoaiMy|Hoai My/i, /\bLinh\b/i];
/** Male voices are never used: Edge "NamMinh", Windows "Microsoft An". */
const MALE_VOICE = /NamMinh|Nam Minh|Microsoft An\b|\bmale\b/i;

/**
 * Reads Vietnamese text aloud with the browser's built-in voices (no API cost, works offline on most phones).
 * One shared instance per tab: live translations and "listen" buttons go through the same queue.
 */
class VietnameseSpeaker {
  rate = 1.15;
  private queued = 0;
  private listeners = new Set<() => void>();

  /**
   * Set while THIS iPhone/iPad records: iOS then routes in-page speech to the loudspeaker even with a headset plugged
   * in, which would play the translation out loud in the room, so nothing is read until recording stops.
   */
  recordingOnAppleMobile = false;

  get supported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  /** The female Vietnamese voice on this device, or null when it has none (then nothing is read: never a male voice). */
  get voice(): SpeechSynthesisVoice | null {
    if (!this.supported) return null;
    const female = speechSynthesis
      .getVoices()
      .filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith('vi') && !MALE_VOICE.test(v.name));
    for (const preferred of FEMALE_VOICES) {
      const match = female.find((v) => preferred.test(v.name));
      if (match) return match;
    }
    return null;
  }

  /** Voices load asynchronously; subscribers re-render once they arrive. */
  onVoicesChanged(fn: () => void) {
    if (!this.supported) return () => {};
    this.listeners.add(fn);
    speechSynthesis.addEventListener('voiceschanged', fn);
    return () => {
      this.listeners.delete(fn);
      speechSynthesis.removeEventListener('voiceschanged', fn);
    };
  }

  /** Mobile browsers only allow speech after a tap: call this from the click that turns reading on. */
  unlock() {
    if (!this.supported) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  /**
   * Queues a sentence. If the listener has fallen several sentences behind the speaker, the backlog is dropped
   * so they always hear what is being said now rather than something from half a minute ago.
   */
  say(text: string, { interrupt = false }: { interrupt?: boolean } = {}) {
    const clean = text.replace(/\((suy luận|inference)\)/gi, '').trim();
    if (!this.supported || !clean || this.recordingOnAppleMobile) return;
    // No female Vietnamese voice: stay silent rather than let the browser pick a default (possibly male) voice.
    const voice = this.voice;
    if (!voice) return;
    if (interrupt || this.queued >= 3) this.stop();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'vi-VN';
    u.voice = voice;
    u.rate = this.rate;
    this.queued++;
    const done = () => {
      this.queued = Math.max(0, this.queued - 1);
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
    // Chrome sometimes leaves the engine paused after a tab switch; resuming is harmless otherwise.
    speechSynthesis.resume();
  }

  stop() {
    if (!this.supported) return;
    speechSynthesis.cancel();
    this.queued = 0;
  }
}

/** iPhone/iPad (iPadOS reports itself as a Mac with touch). */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export const speaker = new VietnameseSpeaker();
