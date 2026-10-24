import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import { initDB, type Database } from '../db.ts';

/**
 * Starts a throwaway in-memory MongoDB per test file. Set MONGO_TEST_URI to
 * reuse an existing local server instead (a random database is used).
 */
export async function startTestDatabase(): Promise<{
  database: Database;
  stop: () => Promise<void>;
}> {
  const external = process.env.MONGO_TEST_URI;
  const server = external ? null : await MongoMemoryServer.create();
  const uri = external ?? server!.getUri();
  const database = await initDB(uri, { dbName: `hisaab_test_${new ObjectId().toHexString()}` });

  return {
    database,
    async stop() {
      await database.db.dropDatabase();
      await database.client.close();
      await server?.stop();
    },
  };
}

export async function createTestUser(database: Database, email = 'test@example.com') {
  const _id = new ObjectId();
  await database.collections.users.insertOne({
    _id,
    email,
    name: 'Test',
    password_hash: 'x',
    created_at: new Date(),
  });
  return _id.toHexString();
}
