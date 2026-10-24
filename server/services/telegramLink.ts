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

export type LinkInspection =
  | { ok: true; userId: string; /** account this chat is linked to now */ currentUserId: string | null }
  | { ok: false; reason: 'invalid' | 'expired' };

/** "raghav@gmail.com" -> "r*****@gmail.com", so a chat never shows a full address. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

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
   * Checks a code without using it up, so the bot can ask before moving a
   * chat that is already linked to a different account.
   */
  async function inspectLinkCode(code: string, chatId: string): Promise<LinkInspection> {
    const trimmed = code.trim();
    if (!LINK_CODE_PATTERN.test(trimmed)) return { ok: false, reason: 'invalid' };

    const doc = await telegramLinkCodes.findOne({ code: hashCode(trimmed) });
    if (!doc) return { ok: false, reason: 'invalid' };
    if (doc.expires_at <= now()) return { ok: false, reason: 'expired' };

    const current = await telegramAccounts.findOne({ chat_id: chatId });
    return {
      ok: true,
      userId: doc.user_id.toHexString(),
      currentUserId: current?.user_id.toHexString() ?? null,
    };
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
    inspectLinkCode,
    consumeLinkCode,
    getUserIdByChat,
    getLinkedChats,
    unlinkUser,
  };
}

export type TelegramLinkService = ReturnType<
  typeof createTelegramLinkService
>;
