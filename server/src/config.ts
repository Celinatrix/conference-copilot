import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: resolve(serverRoot, '..', '.env'), quiet: true });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

export interface AppConfig {
  port: number;
  host: string;
  /** Which proxies may set X-Forwarded-For. Never `true`: any client could then fake its IP. */
  trustProxy: string | false;
  allowedOrigins: string[];
  cookieSecure: boolean;
  databaseUrl: string | null;
  pgliteDir: string | null;
  migrationsDir: string;
  deepgram: { apiKey: string | null; model: string; usdPerMinute: number };
  anthropic: {
    apiKey: string | null;
    translationModel: string;
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
  };
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    port: num('PORT', 4000),
    host: process.env.HOST || '127.0.0.1',
    // Default: only the Next.js proxy on this machine is trusted.
    trustProxy: process.env.TRUST_PROXY === 'false' ? false : process.env.TRUST_PROXY || 'loopback',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    databaseUrl: process.env.DATABASE_URL || null,
    pgliteDir: process.env.PGLITE_DIR || resolve(serverRoot, '..', 'data', 'pglite'),
    migrationsDir: resolve(serverRoot, 'migrations'),
    deepgram: {
      apiKey: process.env.DEEPGRAM_API_KEY || null,
      model: process.env.DEEPGRAM_MODEL || 'nova-3',
      usdPerMinute: num('DEEPGRAM_USD_PER_MIN', 0.0092),
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || null,
      translationModel: process.env.TRANSLATION_MODEL || 'claude-haiku-5-5',
      inputUsdPerMTok: num('TRANSLATION_INPUT_USD_PER_MTOK', 0.1),
      outputUsdPerMTok: num('TRANSLATION_OUTPUT_USD_PER_MTOK', 0.5),
    },
  };
  return { ...base, ...overrides };
}
