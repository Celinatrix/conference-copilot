// Runs on the audio rendering thread. Converts the device stream (usually 48 kHz float, possibly stereo)
// into 16 kHz mono PCM16 and posts one 100 ms chunk at a time, plus an RMS level for the meter.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = (options && options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.chunkSamples = Math.round(this.targetRate / 10);
    this.out = new Int16Array(this.chunkSamples);
    this.outIndex = 0;
    this.pos = 0; // fractional read position into the incoming stream
    this.carry = new Float32Array(0);
    this.sumSquares = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const frames = input[0].length;
    const mono = new Float32Array(this.carry.length + frames);
    mono.set(this.carry, 0);
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < input.length; c++) s += input[c][i];
      mono[this.carry.length + i] = s / input.length;
    }

    // Linear-interpolation resampling.
    while (this.pos + 1 < mono.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      let v = mono[i] * (1 - frac) + mono[i + 1] * frac;
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      this.sumSquares += v * v;
      this.out[this.outIndex++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.outIndex === this.chunkSamples) {
        const level = Math.sqrt(this.sumSquares / this.chunkSamples);
        const buffer = this.out.buffer;
        this.port.postMessage({ type: 'chunk', buffer, level }, [buffer]);
        this.out = new Int16Array(this.chunkSamples);
        this.outIndex = 0;
        this.sumSquares = 0;
      }
      this.pos += this.ratio;
    }
    const keepFrom = Math.floor(this.pos);
    this.carry = mono.slice(keepFrom);
    this.pos -= keepFrom;
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
