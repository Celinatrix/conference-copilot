import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

interface Mp3EncoderInstance {
  encodeBuffer(samples: Int16Array): Int8Array;
  flush(): Int8Array;
}
type Mp3EncoderCtor = new (channels: number, sampleRate: number, kbps: number) => Mp3EncoderInstance;

let ctor: Mp3EncoderCtor | null = null;

/**
 * lamejs 1.2.1's CommonJS entry is broken ("MPEGMode is not defined"); its prebuilt single-file bundle works,
 * so it is evaluated once in an isolated context and the encoder class taken from there.
 */
function encoderClass(): Mp3EncoderCtor {
  if (ctor) return ctor;
  const require = createRequire(import.meta.url);
  const sandbox: { lamejs?: { Mp3Encoder: Mp3EncoderCtor } } = {};
  createContext(sandbox);
  runInContext(readFileSync(require.resolve('lamejs/lame.all.js'), 'utf8'), sandbox);
  if (!sandbox.lamejs?.Mp3Encoder) throw new Error('lamejs bundle did not load');
  ctor = sandbox.lamejs.Mp3Encoder;
  return ctor;
}

/** Mono MP3 encoder for a continuous live stream. */
export class Mp3Stream {
  private enc: Mp3EncoderInstance;

  constructor(sampleRate: number, kbps: number) {
    const Enc = encoderClass();
    this.enc = new Enc(1, sampleRate, kbps);
  }

  encode(samples: Int16Array): Buffer {
    const out = this.enc.encodeBuffer(samples);
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  }
}

/** Linear resampling: speech output rates (16/22.05 kHz) to the stream rate. Good enough for voice. */
export function resample(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return samples;
  const length = Math.floor((samples.length * to) / from);
  const out = new Int16Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const f = x - i0;
    out[i] = Math.round(samples[i0] * (1 - f) + samples[i1] * f);
  }
  return out;
}
