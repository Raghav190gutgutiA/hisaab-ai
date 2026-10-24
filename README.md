# Hisaab.ai

**Track your expenses by chatting.** Type `tea 20, taxi 80` and Hisaab.ai logs both, sorts them into categories and keeps track of your spending. Ask `show this month's expenses` to see this month as a table, JSON or chart, on the web or in Telegram.

> 📸 _Screenshots coming soon_
>
> | Web chat | Format picker | Telegram |
> |---|---|---|
> | ![Web chat](docs/screenshots/web-chat.png) | ![Format picker](docs/screenshots/format-picker.png) | ![Telegram](docs/screenshots/telegram.png) |

---

## Features

- **Natural-language logging**: plain English. Several expenses in one message, with automatic categories (Food, Travel, Bills…) and dates ("yesterday").
- **Generative UI**: replies render as live components (expense tables, JSON, charts), not just text.
- **You choose the format (human-in-the-loop)**: the first time you ask to see expenses, the assistant pauses and asks: **Table**, **JSON** or **Chart**. Your choice is saved, and every result has a switcher to change it.
  - *Table*: sortable by date, description, category or amount (₹)
  - *JSON*: collapsible viewer with a copy button
  - *Chart*: daily totals bar chart
- **Spending analysis**: ask "analyse my spending this month" or "food aur travel ka analysis". You get totals, averages, category shares, top expenses, the biggest day and the change from the previous period, for one category, several, or all. The server computes the numbers; the model only writes short insights.
- **Category filters**: "food ka chart", "food aur travel ka table" or JSON, for any mix of categories.
- **Replies in your language**: English questions get English answers, and Hinglish questions get Hinglish answers.
- **Telegram bot**: log and view expenses from Telegram with the same assistant and the same data. Replies are short natural sentences in your language, e.g. `✅ ₹100 added (Travel ₹80, Food ₹20)`, with a link to the web dashboard for tables and charts.
- **Secure account linking**: link a Telegram chat to your account with a one-time code that expires in 10 minutes, and disconnect anytime.
- **Private by design**: every query is scoped to the signed-in or linked user. Amounts are stored as integer paise, never floats.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, TypeScript, Tailwind CSS 4, shadcn/ui, Recharts |
| Backend | Node.js 22, Express 5, TypeScript (run with `tsx`) |
| AI agent | LangGraph (StateGraph, `interrupt()` + resume), LangChain tools, Google Gemini via `@langchain/google-genai` |
| Database | MongoDB (official driver), `$jsonSchema` validation, LangGraph MongoDB checkpointer |
| Telegram | grammY (long polling for local development, webhook in production) |
| Auth | Email + password (bcrypt), JWT in an httpOnly cookie |
| Validation | Zod (env, HTTP bodies, tool inputs) |
| Tests | Vitest, Supertest, mongodb-memory-server |

## Architecture

```
 ┌──────────────┐  SSE stream   ┌────────────────────────────────────────────┐
 │ React web app│◄─────────────►│ Express API                                │
 │ (Vite)       │  REST + cookie│  /auth  /chat  /chat/resume  /telegram/*   │
 └──────────────┘               │                                            │
                                │   ┌─────────────── LangGraph agent ──────┐ │
 ┌──────────────┐  webhook or   │   │ callModel ─► tools ─► finalize ─► end│ │
 │ Telegram bot │◄─────────────►│   │     ▲          │ show_expenses:      │ │
 │ (grammY)     │  long polling │   │     └──────────┘ interrupt() → picker│ │
 └──────────────┘               │   └──────────────────────────────────────┘ │
                                │        │ Gemini           │ services/       │
                                └────────┼──────────────────┼─────────────────┘
                                         ▼                  ▼
                                  Google Gemini API      MongoDB
                                                (data + agent checkpoints)
```

- **One agent, two channels.** The web app and Telegram bot call the same LangGraph agent, tools and services. Each run carries `{ userId, channel, thread_id }` in its config, and tools read the user from there, never from model output.
- **Human-in-the-loop.** `show_expenses` calls LangGraph's `interrupt()` when no format preference is saved. The server streams an `interrupt` event and the web app shows the **FormatPicker**. The choice is sent to `POST /chat/resume`, which resumes the paused run with `Command({ resume })`. Threads are persisted by the MongoDB checkpointer, so a pending question survives restarts. Telegram never pauses: it defaults to a table, with buttons to switch.
- **Tiered model routing.** A light Gemini model handles tool selection, expense logging and chat replies. A mid-tier model writes generated UI content (analysis insights). It also takes over automatically when the light model's tool call fails Zod validation, or when the light model returns a malformed call or an empty reply.
- **Fewer tokens.** After a tool that renders UI (log, show, chart), the graph ends with a short deterministic reply instead of another LLM call. History is trimmed to the last few messages, and old tool results are compacted.
- **Gemini error handling.** 429 and 5xx errors are retried with backoff. Safety blocks get a friendly reply. A malformed tool call is retried once. Invalid tool arguments fail Zod validation and are returned to the model so it can correct itself. Failures stream to the client as an `error` event.

## Data model

MongoDB stores JSON documents. Each collection maps to a table structure, enforced by a `$jsonSchema` validator and indexes in [server/migrations.ts](server/migrations.ts):

| Collection (table) | Fields (columns) | Constraints |
|---|---|---|
| `users` | `_id`, `email`, `name`, `password_hash`, `created_at` | `email` unique |
| `expenses` | `_id`, `user_id`, `title`, `category`, `amount_paise` (int/long), `spent_on` (`YYYY-MM-DD`), `created_at` | index `(user_id, spent_on)`, `amount_paise ≥ 1` |
| `user_preferences` | `_id`, `user_id`, `expense_format` (`table`\|`json`\|`chart`), `updated_at` | `user_id` unique |
| `telegram_link_codes` | `code` (SHA-256 hash), `user_id`, `expires_at` | `code` unique, TTL on `expires_at` |
| `telegram_accounts` | `chat_id`, `user_id`, `linked_at` | `chat_id` unique |
| `checkpoints`, `checkpoint_writes` | managed by LangGraph | expire after 30 days idle |

**Document → row mapping for display.** The web table, the JSON viewer and the Telegram bot all map an expense document to the same row:

```json
{ "date": "2026-10-25", "description": "tea", "category": "Food", "amount_inr": 20 }
```

Migrations are tracked in a `schema_migrations` collection and run automatically at startup.

## Project structure

```
client/                 React web app
  src/components/       ChatContainer, ChatMessage, FormatPicker, ExpenseView,
                        ExpenseTable, JsonViewer, ExpenseChart, SettingsPanel, AuthScreen
  src/lib/              API client (SSE), formatting helpers
server/                 API, agent and bot
  agent.ts              LangGraph agent (graph, history trimming, interrupt helpers)
  tools.ts              add_expenses, get_expenses, show_expenses, generate_expense_chart
  llm.ts                Gemini model factory and error handling
  services/             expenses, users/preferences, Telegram linking (shared business logic)
  routes/               chat (SSE + resume), Telegram linking endpoints
  telegram/             bot handlers, HTML formatting
  db.ts, migrations.ts  MongoDB connection, schema validators, indexes
  tests/                Vitest suites
```

## Getting started

### Prerequisites

- Node.js **22.12+**
- pnpm (via Corepack: `corepack enable`)
- MongoDB 4.4+: local install, Docker (`docker run -d -p 27017:27017 mongo:7`) or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster
- A Google Gemini API key
- A Telegram bot token (optional, see below)

### 1. Install

```bash
cd server && pnpm install
cd ../client && pnpm install
```

### 2. Configure environment

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Fill in `server/.env` (see the table below). To generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 3. Run locally

```bash
# terminal 1: API + Telegram bot (long polling)
cd server && pnpm dev

# terminal 2: web app
cd client && pnpm dev
```

Open http://localhost:5173, create an account, and try `tea 20, taxi 80`.

### 4. Tests

```bash
cd server && pnpm test        # uses an in-memory MongoDB (downloaded on first run)
MONGO_TEST_URI=mongodb://127.0.0.1:27017 pnpm test   # or reuse a local server
pnpm typecheck
```

## Environment variables

### Server (`server/.env`)

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | | `development` \| `production` \| `test` |
| `PORT` | | API port (default `4100`) |
| `APP_TIMEZONE` | | Defines "today" and "this month" (default `Asia/Kolkata`) |
| `APP_FRONTEND_URL` | ✓ | Public URL of the web app: allowed by CORS, used in Telegram links |
| `APP_BACKEND_URL` | prod | Public https URL of the API, used to register the Telegram webhook |
| `CORS_ORIGINS` | | Extra allowed browser origins, comma separated (localhost is allowed outside production) |
| `DATABASE_URL` | ✓ | MongoDB connection string; the path sets the database name (`…/hisaab-ai`) |
| `JWT_SECRET` | ✓ | Long random string for signing login tokens |
| `JWT_EXPIRES_IN` | | Session length (default `7d`) |
| `GEMINI_API_KEY` | ✓ | From [Google AI Studio](https://aistudio.google.com/apikey) |
| `GEMINI_LIGHT_MODEL` | | Light tier: tool selection, logging, chat (default `gemini-3.5-flash-lite`); see [models](https://ai.google.dev/gemini-api/docs/models) |
| `GEMINI_LIGHT_THINKING_LEVEL` | | `OFF` \| `LOW` \| `MEDIUM` \| `HIGH` (default `LOW`) |
| `GEMINI_LIGHT_MAX_OUTPUT_TOKENS` | | Light-tier reply cap (default `512`) |
| `GEMINI_MID_MODEL` | | Mid tier: analysis insights and validation fallback (default `gemini-3.6-flash`) |
| `GEMINI_MID_THINKING_LEVEL` | | `OFF` \| `LOW` \| `MEDIUM` \| `HIGH` (default `LOW`) |
| `GEMINI_MID_MAX_OUTPUT_TOKENS` | | Mid-tier reply cap (default `1024`) |
| `GEMINI_MAX_RETRIES` | | Retries for 429/5xx (default `3`) |
| `AGENT_HISTORY_MESSAGES` | | Recent messages sent to the model (default `12`) |
| `TELEGRAM_BOT_TOKEN` | for bot | From @BotFather |
| `TELEGRAM_BOT_USERNAME` | | Bot username without `@` (auto-detected if empty) |
| `TELEGRAM_MODE` | | `polling` (local) \| `webhook` (production) \| `off` |
| `TELEGRAM_WEBHOOK_SECRET` | webhook | Random string Telegram echoes in `X-Telegram-Bot-Api-Secret-Token` (`A-Z a-z 0-9 _ -`) |

### Client (`client/.env`)

| Variable | Description |
|---|---|
| `VITE_API_URL` | API base URL (required; the build fails without it). Only `VITE_` variables reach the browser, so never put secrets here. |

`.env` files are git-ignored. Only `.env.example` files are committed.

## Telegram bot

### Create the bot with @BotFather

1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
2. Choose a display name (e.g. *Hisaab.ai*) and a username ending in `bot` (e.g. `hisaab_ai_bot`).
3. Copy the token into `TELEGRAM_BOT_TOKEN` in `server/.env`.
4. Optional: `/setdescription` and `/setuserpic`. Commands are registered automatically at startup.

### Link your account

1. Log in to the web app, open **Settings** (⚙) and click **Connect Telegram**.
2. Telegram opens `t.me/<bot>?start=<code>`. Tap **Start**.
   You can also send `/link <code>` to the bot yourself.
3. The code is single-use and expires in 10 minutes. Use **Disconnect Telegram** in Settings to unlink.

### Using the bot

| Message | Result |
|---|---|
| `tea 20, taxi 80` | `✅ ₹100 added (Travel ₹80, Food ₹20)` |
| `show today's expenses` / `/today` | A short written summary of today |
| `this month's spending` / `/month` | A short written summary of the month |
| `food aur travel ka analysis` | The analysis in sentences, followed by insights (in Hinglish) |
| `/help` | Usage guide |

The bot always replies in natural sentences, never tables or JSON, and in the user's language (English or Hinglish). Tables and charts live on the web dashboard, which every summary links to. Sending the same expense twice logs it twice (two plates of momos are two expenses); only Telegram's own retries of one message are ignored. The bot works in private chats only.

### Local development (long polling)

Use a **separate dev bot** (a second bot from @BotFather) for local work: put its token in `server/.env`, keep `TELEGRAM_MODE=polling` and run `pnpm dev`. A bot can't poll and use a webhook at once, so the server refuses to poll a bot that has a webhook set rather than take the production bot offline.

### Production (webhook)

Set `TELEGRAM_MODE=webhook`, `APP_BACKEND_URL` (public https) and `TELEGRAM_WEBHOOK_SECRET`, then register the webhook once:

```bash
cd server
pnpm telegram:set-webhook    # registers APP_BACKEND_URL/telegram/webhook with the secret
pnpm telegram:webhook-info   # shows the registered URL, pending updates and last error
```

The webhook route checks `X-Telegram-Bot-Api-Secret-Token`, answers 200 immediately and processes the update afterwards, so slow AI replies never cause Telegram retries. Each `update_id` is stored for two days and processed only once.

## Deployment

| Part | Host | Plan |
|---|---|---|
| API + Telegram webhook | [Render](https://render.com) web service | Free |
| Web app | [Vercel](https://vercel.com) | Hobby (free) |
| Database | [MongoDB Atlas](https://www.mongodb.com/atlas) | M0 (free) |

**1. Database (Atlas).** Create a database user and allow access from anywhere (`0.0.0.0/0`), since Render's free plan has no fixed IP. Then run migrations once from your machine:

```bash
cd server
DATABASE_URL="<atlas connection string>" NODE_ENV=production pnpm db:migrate
```

Migrations run from a workstation rather than during the Render build: Render's free plan has no pre-deploy step, and migrating inside a build would change the live database even if that build then fails. In production the server only warns about pending migrations.

**2. API (Render).** Push the repo to GitHub and create a Blueprint from [render.yaml](render.yaml). Fill in the secret variables (`DATABASE_URL`, `JWT_SECRET`, `GEMINI_API_KEY`, `TELEGRAM_*`, `APP_*_URL`, `CORS_ORIGINS`). Render builds with `pnpm build` (TypeScript → `dist/`), starts `node dist/server.js` and health-checks `/health`.

**3. Web app (Vercel).** Import the repo with **root directory `client`** and set `VITE_API_URL` to the Render URL. [client/vercel.json](client/vercel.json) rewrites every route to `index.html`, so refreshing any URL works.

**4. Connect them.** Set `APP_FRONTEND_URL` (and `CORS_ORIGINS` for preview URLs) on Render to the Vercel URL, redeploy, then run `pnpm telegram:set-webhook`.

**Free-tier notes.** Render free services sleep after about 15 minutes idle and take up to a minute to wake. Point an uptime monitor at `/health` (it touches neither the database nor Gemini). Telegram retries webhook deliveries that arrive while the service is waking, and duplicates are dropped.

### If something breaks

| Symptom | Check |
|---|---|
| CORS error in the browser | The exact Vercel origin (scheme + host, no trailing slash) must be in `APP_FRONTEND_URL` or `CORS_ORIGINS` on Render. Redeploy after changing it. |
| Chat reply arrives all at once | The response must have `Content-Type: text/event-stream` and `X-Accel-Buffering: no`; check nothing in front of Render (a proxy or CDN) buffers or compresses `/chat`. |
| Bot doesn't answer | Run `pnpm telegram:webhook-info`: the URL must be `<APP_BACKEND_URL>/telegram/webhook`. "401" in last error means `TELEGRAM_WEBHOOK_SECRET` differs between Render and the registered webhook; run `telegram:set-webhook` again. |
| Database TLS / timeout errors | Use the `mongodb+srv://` string from Atlas (TLS on by default) and make sure Atlas network access allows `0.0.0.0/0`. |
| "Pending database migrations" in logs | Run `pnpm db:migrate` against `DATABASE_URL`. |

## API overview

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/signup`, `/auth/login`, `/auth/logout` | Session management |
| `GET` | `/auth/me` | Current user |
| `POST` | `/chat` | Send a message; streams Server-Sent Events (`ai`, `toolCall:start`, `tool`, `interrupt`, `error`) |
| `POST` | `/chat/resume` | Answer the format picker: `{ "format": "table" \| "json" \| "chart" }` |
| `GET` / `PUT` | `/preferences` | Read or update the saved expense format |
| `GET` | `/telegram/status` | Linking status |
| `POST` | `/telegram/link-code` | Create a one-time link code and deep link |
| `DELETE` | `/telegram/link` | Disconnect Telegram |
| `POST` | `/telegram/webhook` | Telegram updates (webhook mode only) |

## Author

**Raghav Gutgutia**
