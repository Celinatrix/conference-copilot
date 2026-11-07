import { Worker } from 'node:worker_threads';
import type { ParsedDocument } from './parse.js';

export interface ParseLimits {
  timeoutMs: number;
  maxMemoryMb: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = { timeoutMs: 30_000, maxMemoryMb: 512 };

export class ParseLimitError extends Error {}

/**
 * Parses in a worker thread with a heap cap and a deadline. A malicious file that slips past the structural checks
 * (lying ZIP sizes, a PDF with enormous streams) can at worst kill this worker, not the server.
 */
export function parseInWorker(buf: Buffer, filename: string, limits: ParseLimits = DEFAULT_PARSE_LIMITS): Promise<ParsedDocument> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parse-worker.ts', import.meta.url), {
      workerData: { buffer: new Uint8Array(buf), filename },
      // The server runs TypeScript through tsx; the worker needs the same loader.
      execArgv: ['--import', 'tsx'],
      resourceLimits: { maxOldGenerationSizeMb: limits.maxMemoryMb, maxYoungGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new ParseLimitError('Đọc file quá lâu (quá 30 giây), file có thể bị lỗi hoặc quá phức tạp.'))), limits.timeoutMs);
    worker.once('message', (msg: { ok: true; result: ParsedDocument } | { ok: false; message: string }) =>
      finish(() => (msg.ok ? resolve(msg.result) : reject(new Error(msg.message)))),
    );
    worker.once('error', (err: Error & { code?: string }) =>
      finish(() =>
        reject(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new ParseLimitError('File cần quá nhiều bộ nhớ để đọc (nghi là bom giải nén).') : err),
      ),
    );
    worker.once('exit', (code) => finish(() => reject(new ParseLimitError(`Tiến trình đọc file dừng bất thường (mã ${code}).`))));
  });
}
