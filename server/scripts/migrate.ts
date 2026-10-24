/**
 * Applies pending database migrations against DATABASE_URL.
 * Run once before each production deploy: pnpm db:migrate
 */
import { loadConfig } from '../config.ts';
import { initDB, pendingMigrations, runMigrations } from '../db.ts';

const config = loadConfig();
const database = await initDB(config.DATABASE_URL, {
  migrate: false,
  production: config.NODE_ENV === 'production',
});

try {
  const pending = await pendingMigrations(database.db);
  if (pending.length === 0) {
    console.log(`Database "${database.db.databaseName}" is up to date.`);
  } else {
    await runMigrations(database.db);
    console.log(`Applied to "${database.db.databaseName}": ${pending.join(', ')}`);
  }
} finally {
  await database.client.close();
}
