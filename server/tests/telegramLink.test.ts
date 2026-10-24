import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTelegramLinkService,
  LINK_CODE_TTL_MS,
} from '../services/telegramLink.ts';
import type { Database } from '../db.ts';
import { createTestUser, startTestDatabase } from './helpers.ts';

let database: Database;
let stop: () => Promise<void>;
let userId: string;

beforeAll(async () => {
  ({ database, stop } = await startTestDatabase());
  userId = await createTestUser(database);
});

afterAll(() => stop());

describe('Telegram account linking', () => {
  it('links a chat with a valid code and deletes the code', async () => {
    const links = createTelegramLinkService(database.collections);
    const { code, expiresAt } = await links.createLinkCode(userId);

    expect(code).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(LINK_CODE_TTL_MS);

    expect(await links.consumeLinkCode(code, '1001')).toEqual({ ok: true, userId });
    expect(await links.getUserIdByChat('1001')).toBe(userId);
    expect(await database.collections.telegramLinkCodes.countDocuments()).toBe(0);
  });

  it('stores only a hash of the code', async () => {
    const links = createTelegramLinkService(database.collections);
    const { code } = await links.createLinkCode(userId);
    const stored = await database.collections.telegramLinkCodes.findOne({});
    expect(stored?.code).not.toBe(code);
    expect(stored?.code).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a code that was already used', async () => {
    const links = createTelegramLinkService(database.collections);
    const { code } = await links.createLinkCode(userId);
    await links.consumeLinkCode(code, '1002');
    expect(await links.consumeLinkCode(code, '1003')).toEqual({ ok: false, reason: 'invalid' });
    expect(await links.getUserIdByChat('1003')).toBeNull();
  });

  it('allows only one of two concurrent uses of the same code', async () => {
    const links = createTelegramLinkService(database.collections);
    const { code } = await links.createLinkCode(userId);
    const results = await Promise.all([
      links.consumeLinkCode(code, '2001'),
      links.consumeLinkCode(code, '2002'),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('rejects an expired code', async () => {
    let now = new Date('2026-10-25T10:00:00Z');
    const links = createTelegramLinkService(database.collections, () => now);
    const { code } = await links.createLinkCode(userId);

    now = new Date(now.getTime() + LINK_CODE_TTL_MS + 1000);
    expect(await links.consumeLinkCode(code, '1004')).toEqual({ ok: false, reason: 'expired' });
    expect(await links.getUserIdByChat('1004')).toBeNull();
  });

  it('rejects malformed and unknown codes', async () => {
    const links = createTelegramLinkService(database.collections);
    expect(await links.consumeLinkCode('short', '1005')).toEqual({ ok: false, reason: 'invalid' });
    expect(await links.consumeLinkCode('a'.repeat(24), '1005')).toEqual({ ok: false, reason: 'invalid' });
    expect(await links.consumeLinkCode('<script>alert(1)</script>', '1005')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('invalidates older codes when a new one is generated', async () => {
    const links = createTelegramLinkService(database.collections);
    const first = await links.createLinkCode(userId);
    await links.createLinkCode(userId);
    expect(await links.consumeLinkCode(first.code, '1006')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('disconnects every chat linked to the user', async () => {
    const links = createTelegramLinkService(database.collections);
    expect((await links.getLinkedChats(userId)).length).toBeGreaterThan(0);
    const removed = await links.unlinkUser(userId);
    expect(removed).toContain('1001');
    expect(await links.getUserIdByChat('1001')).toBeNull();
  });
});
