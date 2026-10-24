import type { Db, Document } from 'mongodb';

export type Migration = { name: string; up: (db: Db) => Promise<void> };

const ISO_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/**
 * Creates the collection with a $jsonSchema validator, or updates the
 * validator if the collection already exists.
 */
async function ensureCollection(db: Db, name: string, schema: Document) {
  const exists =
    (await db.listCollections({ name }, { nameOnly: true }).toArray())
      .length > 0;
  const validator = { $jsonSchema: schema };

  if (exists) {
    try {
      await db.command({ collMod: name, validator, validationLevel: 'strict' });
    } catch (error) {
      // Database users with only readWrite (e.g. a default Atlas user) may not
      // run collMod. Validators only tighten checks, so carry on without it.
      if ((error as { code?: number }).code !== 13) throw error;
      console.warn(`Skipped updating the validator for "${name}": the database user lacks the collMod permission.`);
    }
  } else {
    await db.createCollection(name, { validator, validationLevel: 'strict' });
  }
}

export const migrations: Migration[] = [
  {
    name: '001_initial_schema',
    async up(db) {
      // users(id, email UNIQUE, name, password_hash, created_at)
      await ensureCollection(db, 'users', {
        bsonType: 'object',
        required: ['email', 'name', 'password_hash', 'created_at'],
        properties: {
          email: { bsonType: 'string', maxLength: 254 },
          name: { bsonType: 'string', minLength: 1, maxLength: 80 },
          password_hash: { bsonType: 'string' },
          created_at: { bsonType: 'date' },
        },
      });
      await db.collection('users').createIndex({ email: 1 }, { unique: true });

      // expenses(id, user_id, title, category, amount_paise, spent_on, created_at)
      await ensureCollection(db, 'expenses', {
        bsonType: 'object',
        required: ['user_id', 'title', 'category', 'amount_paise', 'spent_on', 'created_at'],
        properties: {
          user_id: { bsonType: 'objectId' },
          title: { bsonType: 'string', minLength: 1, maxLength: 120 },
          category: { bsonType: 'string' },
          amount_paise: { bsonType: ['int', 'long'], minimum: 1 },
          spent_on: { bsonType: 'string', pattern: ISO_DATE_PATTERN },
          created_at: { bsonType: 'date' },
        },
      });
      await db
        .collection('expenses')
        .createIndex({ user_id: 1, spent_on: 1 });

      // user_preferences(user_id UNIQUE, expense_format, updated_at)
      await ensureCollection(db, 'user_preferences', {
        bsonType: 'object',
        required: ['user_id', 'updated_at'],
        properties: {
          user_id: { bsonType: 'objectId' },
          expense_format: { enum: ['table', 'json', 'chart'] },
          updated_at: { bsonType: 'date' },
        },
      });
      await db
        .collection('user_preferences')
        .createIndex({ user_id: 1 }, { unique: true });
    },
  },
  {
    name: '002_telegram',
    async up(db) {
      // telegram_link_codes(code UNIQUE, user_id, expires_at)
      await ensureCollection(db, 'telegram_link_codes', {
        bsonType: 'object',
        required: ['code', 'user_id', 'expires_at'],
        properties: {
          code: { bsonType: 'string' },
          user_id: { bsonType: 'objectId' },
          expires_at: { bsonType: 'date' },
        },
      });
      const codes = db.collection('telegram_link_codes');
      await codes.createIndex({ code: 1 }, { unique: true });
      await codes.createIndex({ user_id: 1 });
      // MongoDB deletes expired codes in the background (~60s granularity);
      // expiry is still checked explicitly when a code is used.
      await codes.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

      // telegram_accounts(chat_id UNIQUE, user_id, linked_at)
      await ensureCollection(db, 'telegram_accounts', {
        bsonType: 'object',
        required: ['chat_id', 'user_id', 'linked_at'],
        properties: {
          chat_id: { bsonType: 'string' },
          user_id: { bsonType: 'objectId' },
          linked_at: { bsonType: 'date' },
        },
      });
      const accounts = db.collection('telegram_accounts');
      await accounts.createIndex({ chat_id: 1 }, { unique: true });
      await accounts.createIndex({ user_id: 1 });
    },
  },
  {
    name: '003_telegram_update_dedupe',
    async up(db) {
      // telegram_updates(_id = update_id, received_at): seen updates, so a
      // retried webhook delivery is never processed twice. Kept for 2 days.
      const exists =
        (await db.listCollections({ name: 'telegram_updates' }, { nameOnly: true }).toArray()).length > 0;
      if (!exists) await db.createCollection('telegram_updates');
      await db
        .collection('telegram_updates')
        .createIndex({ received_at: 1 }, { expireAfterSeconds: 2 * 24 * 60 * 60 });
    },
  },
  {
    name: '004_monthly_budget',
    async up(db) {
      // user_preferences(monthly_budget_paise, budget_alert_month, budget_alert_levels):
      // the monthly budget, and which alerts (80% / 100%) were sent this month
      await ensureCollection(db, 'user_preferences', {
        bsonType: 'object',
        required: ['user_id', 'updated_at'],
        properties: {
          user_id: { bsonType: 'objectId' },
          expense_format: { enum: ['table', 'json', 'chart'] },
          monthly_budget_paise: { bsonType: ['int', 'long'], minimum: 1 },
          budget_alert_month: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}$' },
          budget_alert_levels: { bsonType: 'array', items: { enum: [80, 100] } },
          updated_at: { bsonType: 'date' },
        },
      });
    },
  },
];
