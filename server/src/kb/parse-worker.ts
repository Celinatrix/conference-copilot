import { parentPort, workerData } from 'node:worker_threads';
import { parseDocument } from './parse.js';

/** Runs one document parse in isolation; the parent enforces memory and time limits on this thread. */
const { buffer, filename } = workerData as { buffer: Uint8Array; filename: string };

parseDocument(Buffer.from(buffer), filename)
  .then((result) => parentPort!.postMessage({ ok: true, result }))
  .catch((err) => parentPort!.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) }));
