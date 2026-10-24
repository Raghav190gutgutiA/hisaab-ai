import { Long, MongoClient, type Collection, type Db, type ObjectId } from 'mongodb';
import { migrations } from './migrations.ts';

/**
 * Document shapes. Field names mirror the relational table design
 * (snake_case columns), see "Data model" in the README.
 */
export type UserDoc = {
  _id: ObjectId;
  email: string;
  name: string;
  password_hash: string;
  created_at: Date;
};

export type ExpenseDoc = {
  _id: ObjectId;
  user_id: ObjectId;
  title: string;
  category: string;
  amount_paise: number | Long;
  spent_on: string; // YYYY-MM-DD in the app timezone
  created_at: Date;
};

export type UserPreferenceDoc = {
  _id: ObjectId;
  user_id: ObjectId;
  expense_format: 'table' | 'json' | 'chart';
  updated_at: Date;
};

export type TelegramLinkCodeDoc = {
  _id: ObjectId;
  code: string; // SHA-256 of the one-time code
  user_id: ObjectId;
  expires_at: Date;
};

export type TelegramAccountDoc = {
  _id: ObjectId;
  chat_id: string;
  user_id: ObjectId;
  linked_at: Date;
};

export type TelegramUpdateDoc = {
  _id: number; // Telegram update_id
  received_at: Date;
};

export type Collections = {
  users: Collection<UserDoc>;
  expenses: Collection<ExpenseDoc>;
  userPreferences: Collection<UserPreferenceDoc>;
  telegramLinkCodes: Collection<TelegramLinkCodeDoc>;
  telegramAccounts: Collection<TelegramAccountDoc>;
  telegramUpdates: Collection<TelegramUpdateDoc>;
};

export type Database = {
  client: MongoClient;
  db: Db;
  collections: Collections;
};

export function getCollections(db: Db): Collections {
  return {
    users: db.collection<UserDoc>('users'),
    expenses: db.collection<ExpenseDoc>('expenses'),
    userPreferences: db.collection<UserPreferenceDoc>('user_preferences'),
    telegramLinkCodes: db.collection<TelegramLinkCodeDoc>('telegram_link_codes'),
    telegramAccounts: db.collection<TelegramAccountDoc>('telegram_accounts'),
    telegramUpdates: db.collection<TelegramUpdateDoc>('telegram_updates'),
  };
}

export type InitOptions = {
  dbName?: string;
  /** Apply pending migrations on connect (development and tests). */
  migrate?: boolean;
  production?: boolean;
};

/**
 * Connects to MongoDB. The database name comes from the path in the
 * connection string (e.g. .../hisaab-ai?...).
 *
 * A small pool suits free-tier clusters. The driver reconnects on its own,
 * so a cold start or a dropped connection recovers without a restart.
 */
export async function initDB(
  uri: string,
  { dbName, migrate = true, production = false }: InitOptions = {}
): Promise<Database> {
  const isLocal = /^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(uri);
  const client = new MongoClient(uri, {
    appName: 'hisaab-ai',
    maxPoolSize: 5,
    minPoolSize: 0,
    maxIdleTimeMS: 60_000,
    serverSelectionTimeoutMS: 15_000,
    // mongodb+srv always uses TLS; force it for any non-local host in production
    ...(production && !isLocal && { tls: true }),
  });
  await client.connect();

  const db = client.db(dbName);
  if (migrate) {
    await runMigrations(db);
  } else {
    const pending = await pendingMigrations(db);
    if (pending.length) {
      console.warn(`Pending database migrations: ${pending.join(', ')}. Run "pnpm db:migrate".`);
    }
  }

  return { client, db, collections: getCollections(db) };
}

export async function pendingMigrations(db: Db): Promise<string[]> {
  const applied = new Set(
    (await db.collection<{ _id: string }>('schema_migrations').find().toArray()).map((d) => d._id)
  );
  return migrations.map((m) => m.name).filter((name) => !applied.has(name));
}

/**
 * Applies every migration not yet recorded in schema_migrations, in order.
 * Migrations must be idempotent: a crash mid-way is retried on next start.
 */
export async function runMigrations(db: Db) {
  const history = db.collection<{ _id: string; applied_at: Date }>(
    'schema_migrations'
  );
  const applied = new Set(
    (await history.find().toArray()).map((doc) => doc._id)
  );

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await migration.up(db);
    await history.insertOne({ _id: migration.name, applied_at: new Date() });
  }
}

/** Integers above int32 are stored as BSON long so they stay integers. */
export function toBsonInt(value: number): number | Long {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Expected a safe integer, got ${value}`);
  }
  return Math.abs(value) <= 2_147_483_647 ? value : Long.fromNumber(value);
}

export function fromBsonInt(value: number | Long): number {
  return typeof value === 'number' ? value : value.toNumber();
}
