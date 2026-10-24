import { MongoServerError, ObjectId } from 'mongodb';
import * as z from 'zod';
import type { Collections } from '../db.ts';
import { toObjectId } from './expenses.ts';

export const EXPENSE_FORMATS = ['table', 'json', 'chart'] as const;
export type ExpenseFormat = (typeof EXPENSE_FORMATS)[number];
export const expenseFormatSchema = z.enum(EXPENSE_FORMATS);

export type User = { id: string; email: string; name: string };

export class EmailTakenError extends Error {
  constructor() {
    super('An account with this email already exists');
  }
}

export function createUserService({ users, userPreferences }: Collections) {
  async function createUser(input: {
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<User> {
    const doc = {
      _id: new ObjectId(),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      password_hash: input.passwordHash,
      created_at: new Date(),
    };
    try {
      await users.insertOne(doc);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new EmailTakenError();
      }
      throw error;
    }
    return { id: doc._id.toHexString(), email: doc.email, name: doc.name };
  }

  async function findByEmail(
    email: string
  ): Promise<(User & { passwordHash: string }) | null> {
    const doc = await users.findOne({ email: email.trim().toLowerCase() });
    if (!doc) return null;
    return {
      id: doc._id.toHexString(),
      email: doc.email,
      name: doc.name,
      passwordHash: doc.password_hash,
    };
  }

  async function findById(id: string): Promise<User | null> {
    if (!ObjectId.isValid(id)) return null;
    const doc = await users.findOne(
      { _id: new ObjectId(id) },
      { projection: { password_hash: 0 } }
    );
    return doc
      ? { id: doc._id.toHexString(), email: doc.email, name: doc.name }
      : null;
  }

  async function getExpenseFormat(
    userId: string
  ): Promise<ExpenseFormat | null> {
    const doc = await userPreferences.findOne({ user_id: toObjectId(userId) });
    return doc?.expense_format ?? null;
  }

  async function setExpenseFormat(userId: string, format: ExpenseFormat) {
    expenseFormatSchema.parse(format);
    await userPreferences.updateOne(
      { user_id: toObjectId(userId) },
      { $set: { expense_format: format, updated_at: new Date() } },
      { upsert: true }
    );
  }

  return {
    createUser,
    findByEmail,
    findById,
    getExpenseFormat,
    setExpenseFormat,
  };
}

export type UserService = ReturnType<typeof createUserService>;
