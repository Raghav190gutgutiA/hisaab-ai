import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import type { Database } from '../db.ts';
import { startTestDatabase } from './helpers.ts';

let database: Database;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ database, stop } = await startTestDatabase());
});
afterAll(() => stop());

function buildApp(env: Record<string, string> = {}) {
  const config = loadConfig({ JWT_SECRET: 'test-secret', ...env });
  return createApp({
    config,
    database,
    getAgent: () => {
      throw new Error('agent not needed');
    },
    bot: null,
  });
}

describe('/health', () => {
  it('returns 200 without auth', async () => {
    const res = await request(buildApp()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('CORS', () => {
  const app = () =>
    buildApp({
      NODE_ENV: 'production',
      APP_FRONTEND_URL: 'https://hisaab.vercel.app/',
      CORS_ORIGINS: 'https://preview.vercel.app, https://other.example',
    });

  it('allows the frontend and CORS_ORIGINS, normalising trailing slashes', async () => {
    for (const origin of ['https://hisaab.vercel.app', 'https://preview.vercel.app', 'https://other.example']) {
      const res = await request(app()).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('blocks other origins, and localhost in production', async () => {
    for (const origin of ['https://evil.example', 'http://localhost:5173']) {
      const res = await request(app()).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('allows localhost during development', async () => {
    const res = await request(buildApp()).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('accepts the Authorization header in preflight', async () => {
    const res = await request(buildApp())
      .options('/chat')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toMatch(/Authorization/);
  });
});

describe('Bearer token auth', () => {
  it('signs up, then uses the returned token for authenticated requests', async () => {
    const app = buildApp();
    const signup = await request(app)
      .post('/auth/signup')
      .send({ name: 'Raghav', email: 'bearer@example.com', password: 'long-password-1' })
      .expect(201);
    expect(typeof signup.body.token).toBe('string');
    expect(signup.headers['set-cookie']).toBeUndefined();

    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${signup.body.token}`).expect(200);
    expect(me.body.user.email).toBe('bearer@example.com');

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'BEARER@example.com', password: 'long-password-1' })
      .expect(200);
    await request(app).get('/preferences').set('Authorization', `Bearer ${login.body.token}`).expect(200);
  });

  it('rejects missing, malformed and forged tokens', async () => {
    const app = buildApp();
    await request(app).get('/auth/me').expect(401);
    await request(app).get('/auth/me').set('Authorization', 'Token abc').expect(401);
    await request(app).get('/auth/me').set('Authorization', 'Bearer not-a-jwt').expect(401);

    const other = buildApp({ JWT_SECRET: 'a-different-secret' });
    const signup = await request(other)
      .post('/auth/signup')
      .send({ name: 'X', email: 'forged@example.com', password: 'long-password-1' });
    await request(app).get('/auth/me').set('Authorization', `Bearer ${signup.body.token}`).expect(401);
  });
});

describe('config', () => {
  it('still accepts the old variable names', () => {
    const config = loadConfig({
      JWT_SECRET: 'x',
      WEB_APP_URL: 'https://old-front.example/',
      PUBLIC_API_URL: 'https://old-api.example',
      MONGO_URI: 'mongodb://127.0.0.1:27017/legacy',
    });
    expect(config.APP_FRONTEND_URL).toBe('https://old-front.example');
    expect(config.APP_BACKEND_URL).toBe('https://old-api.example');
    expect(config.DATABASE_URL).toBe('mongodb://127.0.0.1:27017/legacy');
  });

  it('requires JWT_SECRET and the webhook secret in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x', TELEGRAM_MODE: 'webhook' })).toThrow(
      /TELEGRAM_WEBHOOK_SECRET/
    );
  });
});
