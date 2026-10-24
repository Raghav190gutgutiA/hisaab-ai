import { createHash, randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Collections } from '../db.ts';
import { toObjectId } from './expenses.ts';

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

// Telegram deep-link payloads allow only [A-Za-z0-9_-], up to 64 chars.
const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export type LinkResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid' | 'expired' };

export function createTelegramLinkService(
  { telegramLinkCodes, telegramAccounts }: Collections,
  now: () => Date = () => new Date()
) {
  /**
   * Issues a fresh one-time code and invalidates any earlier codes for
   * this user. Only the hash is stored.
   */
  async function createLinkCode(
    userId: string
  ): Promise<{ code: string; expiresAt: string }> {
    const userObjectId = toObjectId(userId);
    const code = randomBytes(18).toString('base64url');
    const expiresAt = new Date(now().getTime() + LINK_CODE_TTL_MS);

    await telegramLinkCodes.deleteMany({ user_id: userObjectId });
    await telegramLinkCodes.insertOne({
      _id: new ObjectId(),
      code: hashCode(code),
      user_id: userObjectId,
      expires_at: expiresAt,
    });

    return { code, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Atomically claims (deletes) the code, so two concurrent requests can
   * never both use it, then links the chat to the code's user.
   */
  async function consumeLinkCode(
    code: string,
    chatId: string
  ): Promise<LinkResult> {
    const trimmed = code.trim();
    if (!LINK_CODE_PATTERN.test(trimmed)) {
      return { ok: false, reason: 'invalid' };
    }

    const claimed = await telegramLinkCodes.findOneAndDelete({
      code: hashCode(trimmed),
    });

    if (!claimed) return { ok: false, reason: 'invalid' };
    if (claimed.expires_at <= now()) return { ok: false, reason: 'expired' };

    await telegramAccounts.updateOne(
      { chat_id: chatId },
      { $set: { user_id: claimed.user_id, linked_at: new Date() } },
      { upsert: true }
    );

    return { ok: true, userId: claimed.user_id.toHexString() };
  }

  async function getUserIdByChat(chatId: string): Promise<string | null> {
    const doc = await telegramAccounts.findOne({ chat_id: chatId });
    return doc?.user_id.toHexString() ?? null;
  }

  async function getLinkedChats(
    userId: string
  ): Promise<{ chatId: string; linkedAt: string }[]> {
    const docs = await telegramAccounts
      .find({ user_id: toObjectId(userId) })
      .sort({ linked_at: 1 })
      .toArray();
    return docs.map((doc) => ({
      chatId: doc.chat_id,
      linkedAt: doc.linked_at.toISOString(),
    }));
  }

  /** Removes every chat linked to the user. Returns the unlinked chat ids. */
  async function unlinkUser(userId: string): Promise<string[]> {
    const chats = (await getLinkedChats(userId)).map((c) => c.chatId);
    await telegramAccounts.deleteMany({ user_id: toObjectId(userId) });
    return chats;
  }

  return {
    createLinkCode,
    consumeLinkCode,
    getUserIdByChat,
    getLinkedChats,
    unlinkUser,
  };
}

export type TelegramLinkService = ReturnType<
  typeof createTelegramLinkService
>;
