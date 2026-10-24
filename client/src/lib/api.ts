import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { ExpenseFormat, StreamEvent, User } from '../type.ts';

/**
 * Reads VITE_API_URL, tolerating stray whitespace or a byte-order mark
 * (some shells add one when piping the value into a CLI), and insists on
 * an absolute http(s) URL. A relative value would silently send API calls
 * to the frontend host instead.
 */
function resolveApiUrl(raw: string | undefined): string {
  const value = (raw ?? '').replace(/^﻿/, '').trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `VITE_API_URL must be an absolute URL like https://api.example.com (got "${value}"). ` +
        'Set it in client/.env (local) or the Vercel project settings.'
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`VITE_API_URL must use http or https (got "${value}").`);
  }
  return value;
}

export const API_URL = resolveApiUrl(import.meta.env.VITE_API_URL);

const TOKEN_KEY = 'hisaab_token';

/**
 * The session token is kept in localStorage and sent as a Bearer header.
 * In production the API is on another site, where Safari blocks cookies
 * as third-party. Storage can be unavailable (e.g. private mode), so every
 * access is guarded.
 */
export const session = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // The session then lasts until the page is closed
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // Nothing stored
    }
  },
};

function authHeaders(): Record<string, string> {
  const token = session.get();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) session.clear();
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.error ?? 'Something went wrong. Please try again.'
    );
  }
  return body as T;
}

type AuthResult = { user: User; token: string };

export const api = {
  me: () => request<{ user: User }>('/auth/me'),
  login: async (email: string, password: string) => {
    const result = await request<AuthResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    session.set(result.token);
    return result;
  },
  signup: async (name: string, email: string, password: string) => {
    const result = await request<AuthResult>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    });
    session.set(result.token);
    return result;
  },
  // Tokens are stateless, so logging out just forgets the token
  logout: async () => {
    session.clear();
  },

  setExpenseFormat: (expenseFormat: ExpenseFormat) =>
    request<{ expenseFormat: ExpenseFormat }>('/preferences', {
      method: 'PUT',
      body: JSON.stringify({ expenseFormat }),
    }),

  telegramStatus: () =>
    request<{
      enabled: boolean;
      botUsername: string | null;
      linked: boolean;
      linkedAt: string | null;
    }>('/telegram/status'),
  telegramLinkCode: () =>
    request<{ code: string; expiresAt: string; deepLink: string | null }>(
      '/telegram/link-code',
      { method: 'POST' }
    ),
  telegramDisconnect: () =>
    request('/telegram/link', { method: 'DELETE' }),
};

/** Fatal errors stop fetchEventSource from retrying. */
class FatalStreamError extends Error {}

/**
 * POSTs to a streaming endpoint and calls onEvent for every SSE message.
 */
export async function streamChat(
  path: '/chat' | '/chat/resume',
  body: Record<string, unknown>,
  onEvent: (event: StreamEvent) => void
) {
  await fetchEventSource(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    openWhenHidden: true,
    async onopen(response) {
      if (
        response.ok &&
        response.headers.get('content-type')?.includes('text/event-stream')
      ) {
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) session.clear();
      throw new FatalStreamError(
        response.status === 401
          ? 'Your session has expired. Please log in again.'
          : (data.error ?? 'Could not reach the server.')
      );
    },
    onmessage(ev) {
      if (!ev.data) return;
      onEvent(JSON.parse(ev.data) as StreamEvent);
    },
    onerror(error) {
      // Never auto-retry: a retried POST could log the same expense twice
      throw error instanceof FatalStreamError
        ? error
        : new FatalStreamError('Connection lost. Please try again.');
    },
  });
}
