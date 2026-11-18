'use client';

/**
 * Reads Vietnamese text aloud with the browser's built-in voices (no API cost, works offline on most phones).
 * One shared instance per tab: live translations and "listen" buttons go through the same queue.
 */
class VietnameseSpeaker {
  rate = 1.15;
  private queued = 0;
  private listeners = new Set<() => void>();

  get supported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  /** The best Vietnamese voice on this device, or null when none is installed. */
  get voice(): SpeechSynthesisVoice | null {
    if (!this.supported) return null;
    const vi = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith('vi'));
    // Natural/online voices sound far better than the legacy offline ones.
    return vi.find((v) => /natural|online|google/i.test(v.name)) ?? vi[0] ?? null;
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
    if (!this.supported || !clean) return;
    if (interrupt || this.queued >= 3) this.stop();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'vi-VN';
    const voice = this.voice;
    if (voice) u.voice = voice;
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

export const speaker = new VietnameseSpeaker();
