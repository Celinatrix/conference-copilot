import { loadConfig } from './config.js';
import { migrate, openPglite, openPostgres } from './db.js';

const config = loadConfig();
const db = config.databaseUrl ? await openPostgres(config.databaseUrl) : await openPglite(config.pgliteDir);
const ran = await migrate(db, config.migrationsDir);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
await db.close();
