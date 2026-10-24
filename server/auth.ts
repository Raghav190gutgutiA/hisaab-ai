import { Router, type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as z from 'zod';
import type { AppConfig } from './config.ts';
import { EmailTakenError, type UserService } from './services/users.ts';

const signupSchema = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(128),
});

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function signToken(userId: string, config: AppConfig): string {
  return jwt.sign({ sub: userId }, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string, config: AppConfig): string | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    return typeof payload === 'object' && typeof payload.sub === 'string'
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

/** Reads `Authorization: Bearer <token>`. */
function bearerToken(req: Request): string | null {
  const header = req.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * Sessions are stateless JWTs sent as a Bearer token. The web app and API
 * live on different sites in production (vercel.app / onrender.com), where
 * cookies are blocked as third-party in Safari, so a header is used instead.
 */
export function requireAuth(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    const userId = token ? verifyToken(token, config) : null;
    if (!userId) {
      res.status(401).json({ error: 'Please log in' });
      return;
    }
    req.userId = userId;
    next();
  };
}

export function createAuthRouter(config: AppConfig, users: UserService) {
  const router = Router();
  const session = (user: { id: string }) => signToken(user.id, config);

  router.post('/signup', async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    try {
      const user = await users.createUser({
        email: parsed.data.email,
        name: parsed.data.name,
        passwordHash: await bcrypt.hash(parsed.data.password, 12),
      });
      res.status(201).json({ user, token: session(user) });
    } catch (error) {
      if (error instanceof EmailTakenError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.post('/login', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter a valid email and password' });
      return;
    }
    const user = await users.findByEmail(parsed.data.email);
    const valid =
      user && (await bcrypt.compare(parsed.data.password, user.passwordHash));
    if (!user || !valid) {
      res.status(401).json({ error: 'Incorrect email or password' });
      return;
    }
    res.json({ user: { id: user.id, email: user.email, name: user.name }, token: session(user) });
  });

  // Tokens are stateless: logging out means the client discards its token
  router.post('/logout', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/me', requireAuth(config), async (req, res) => {
    const user = await users.findById(req.userId!);
    if (!user) {
      res.status(401).json({ error: 'Please log in' });
      return;
    }
    res.json({ user });
  });

  return router;
}
