import { loadConfig } from './config.js';
import { migrate, openPglite, openPostgres } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = config.databaseUrl ? await openPostgres(config.databaseUrl) : await openPglite(config.pgliteDir);
const ran = await migrate(db, config.migrationsDir);

const { app, ctx } = await buildApp(db, config);
if (ran.length) app.log.info({ migrations: ran }, 'applied migrations');
await ctx.live.recoverAfterRestart();

if (!config.deepgram.apiKey) app.log.warn('DEEPGRAM_API_KEY is not set: live transcription will be refused until it is configured.');
if (!config.anthropic.apiKey) app.log.warn('ANTHROPIC_API_KEY is not set: translation will fail with a clear error until it is configured.');

await app.listen({ port: config.port, host: config.host });

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
