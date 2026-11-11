import type { DocumentKind } from './parse.js';

/**
 * Checks that run on the raw upload BEFORE any parser touches it. Parsers (PDF, ZIP/XML) are complex code fed
 * with attacker-controlled bytes, so cheap structural checks come first and refuse anything suspicious.
 */

export class UnsafeUploadError extends Error {
  constructor(
    message: string,
    readonly code: 'bad_signature' | 'zip_bomb' | 'zip_invalid' | 'not_text' | 'too_long',
  ) {
    super(message);
  }
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
  /** Uncompressed/compressed ratio above which a large entry is treated as a bomb. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxTotalUncompressedBytes: 50 * 1024 * 1024,
  maxEntryUncompressedBytes: 30 * 1024 * 1024,
  maxRatio: 200,
};

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** The file must actually be the format its extension claims. */
export function checkSignature(buf: Buffer, kind: DocumentKind) {
  if (kind === 'pdf') {
    // The spec allows junk before the header; real files put it in the first bytes. 1 KB is the common tolerance.
    if (!buf.subarray(0, 1024).includes('%PDF-')) throw new UnsafeUploadError('File không phải PDF hợp lệ.', 'bad_signature');
    return;
  }
  if (kind === 'docx' || kind === 'pptx' || kind === 'xlsx') {
    if (!buf.subarray(0, 4).equals(ZIP_MAGIC)) throw new UnsafeUploadError(`File không phải ${kind.toUpperCase()} hợp lệ.`, 'bad_signature');
    return;
  }
  // CSV: must be text. NUL bytes or invalid UTF-8 mean a binary file renamed to .csv.
  if (buf.includes(0)) throw new UnsafeUploadError('File CSV chứa dữ liệu nhị phân.', 'not_text');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new UnsafeUploadError('File CSV phải dùng mã hóa UTF-8.', 'not_text');
  }
}

/**
 * Reads the ZIP central directory (without decompressing anything) and refuses archives whose declared contents
 * are too many or too large — the classic decompression bomb. Declared sizes can lie, which is why parsing also
 * runs in a memory- and time-limited worker; this check stops the honest-looking bombs cheaply.
 */
export function inspectZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS) {
  // End Of Central Directory: signature 0x06054b50, within the last 64 KB + 22 bytes.
  const minPos = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UnsafeUploadError('File nén bị hỏng.', 'zip_invalid');
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw new UnsafeUploadError('File nén ZIP64 không được hỗ trợ.', 'zip_invalid');
  if (entries > limits.maxEntries) throw new UnsafeUploadError(`File chứa quá nhiều phần (${entries}).`, 'zip_bomb');

  let pos = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new UnsafeUploadError('File nén bị hỏng.', 'zip_invalid');
    const compressed = buf.readUInt32LE(pos + 20);
    const uncompressed = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    if (uncompressed === 0xffffffff || compressed === 0xffffffff) throw new UnsafeUploadError('File nén ZIP64 không được hỗ trợ.', 'zip_invalid');
    if (uncompressed > limits.maxEntryUncompressedBytes) throw new UnsafeUploadError('Một phần trong file giải nén ra quá lớn.', 'zip_bomb');
    if (uncompressed > 1024 * 1024 && uncompressed / Math.max(compressed, 1) > limits.maxRatio) {
      throw new UnsafeUploadError('File có tỷ lệ nén bất thường (nghi là bom giải nén).', 'zip_bomb');
    }
    total += uncompressed;
    if (total > limits.maxTotalUncompressedBytes) throw new UnsafeUploadError('File giải nén ra vượt quá 50 MB.', 'zip_bomb');
    pos += 46 + nameLen + extraLen + commentLen;
  }
}
