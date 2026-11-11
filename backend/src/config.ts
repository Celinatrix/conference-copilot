import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Backend keys live in backend/.env (next to this package), never in the frontend.
loadEnv({ path: resolve(backendRoot, '.env'), quiet: true });

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
  /** Open self-registration. Off by default: after the first (owner) account, people join by invite link. */
  allowSignup: boolean;
  /** Registration attempts allowed per IP per hour. */
  registerPerHour: number;
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
  answers: {
    model: string;
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
    cacheReadUsdPerMTok: number;
    cacheWriteUsdPerMTok: number;
    /** Auto-suggestions stop (and wait for a click) once a conference's answer spend reaches this. 0 = unlimited. */
    autoBudgetUsd: number;
  };
  /** Segments whose recognition confidence is below this are flagged in the translation. */
  lowConfidenceThreshold: number;
  /** Hard spending caps on every paid AI call (STT, translation, detection, answers). 0 disables a cap. */
  costCaps: {
    conferenceUsd: number;
    workspaceDailyUsd: number;
  };
  /** Per-user request limits for endpoints that trigger paid AI calls, per minute. */
  aiRateLimits: { questionsPerMinute: number; retranslatePerMinute: number };
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    port: num('PORT', 4000),
    host: process.env.HOST || '127.0.0.1',
    // Default: only the Next.js proxy on this machine is trusted.
    trustProxy: process.env.TRUST_PROXY === 'false' ? false : process.env.TRUST_PROXY || 'loopback',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3001,http://127.0.0.1:3001')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    allowSignup: process.env.ALLOW_SIGNUP === 'true',
    registerPerHour: num('REGISTER_PER_HOUR', 5),
    databaseUrl: process.env.DATABASE_URL || null,
    pgliteDir: process.env.PGLITE_DIR || resolve(backendRoot, 'data', 'pglite'),
    migrationsDir: resolve(backendRoot, 'migrations'),
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
    answers: {
      model: process.env.ANSWER_MODEL || 'claude-sonnet-5-5',
      inputUsdPerMTok: num('ANSWER_INPUT_USD_PER_MTOK', 2),
      outputUsdPerMTok: num('ANSWER_OUTPUT_USD_PER_MTOK', 10),
      cacheReadUsdPerMTok: num('ANSWER_CACHE_READ_USD_PER_MTOK', 0.2),
      cacheWriteUsdPerMTok: num('ANSWER_CACHE_WRITE_USD_PER_MTOK', 2.5),
      autoBudgetUsd: num('ANSWER_AUTO_BUDGET_USD', 1),
    },
    lowConfidenceThreshold: num('LOW_CONFIDENCE_THRESHOLD', 0.75),
    costCaps: {
      conferenceUsd: num('AI_CONFERENCE_CAP_USD', 10),
      workspaceDailyUsd: num('AI_WORKSPACE_DAILY_CAP_USD', 25),
    },
    aiRateLimits: {
      questionsPerMinute: num('AI_QUESTIONS_PER_MINUTE', 10),
      retranslatePerMinute: num('AI_RETRANSLATE_PER_MINUTE', 15),
    },
  };
  return { ...base, ...overrides };
}
