# Meoly

A self-hosted, multi-account **IMAP email client** for the web. View and manage your
mail — mark read/unread, move, archive, delete — with a fast local cache. It is
**read/manage only: there is no way to send email**.

Built with:

- **Frontend** — Vite + React 19, Tailwind CSS v4, and lucide-react icons.
- **Backend** — Express 5 (TypeScript) REST API.
- **IMAP** — [`imapflow`](https://imapflow.com/), one persistent connection per account.
- **Cache** — `better-sqlite3`. App passwords are encrypted at rest (AES-256-GCM).
- **AI triage** _(optional)_ — classifies unread mail and suggests keep / mark-read / archive / delete via any OpenAI-compatible endpoint (LMStudio, Ollama, etc.).
- **Telegram digest** _(optional)_ — sends a daily summary of your inbox with action buttons.

## How it works

- Add each mailbox with its IMAP host/port and an **app password** (not your login
  password). Presets for Gmail / Outlook / iCloud / Fastmail prefill host + port.
- The server keeps a single IMAP connection per account and serializes all operations
  over it with a mailbox lock.
- Message envelopes and flags are cached in SQLite; bodies are fetched lazily and cached.
  The UI renders from cache first, then re-syncs.

## Deploy with Docker (prebuilt image)

The easiest way to run Meoly on a server. No source code needed.

**1. Create `docker-compose.yml`:**

```yaml
services:
  meoly:
    image: ghcr.io/tiepduong7c9/meoly:latest
    ports:
      - "3000:3000"
    environment:
      PORT: 3000
      DATA_DIR: /data
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
      NODE_ENV: production
    volumes:
      - ./data:/data
    restart: unless-stopped
```

**2. Create `.env`:**

```bash
ENCRYPTION_KEY=$(openssl rand -base64 32)
```

**3. Start:**

```bash
docker compose up -d
```

Open http://localhost:3000. The SQLite database is persisted in `./data`.

**Updating:**

```bash
docker compose pull && docker compose up -d
```

## Build from source

### Local development

```bash
cp .env.example .env
# Generate an encryption key and paste it into .env as ENCRYPTION_KEY
openssl rand -base64 32

npm install
npm run dev
```

- Web (Vite dev server): http://localhost:5173
- API (Express): http://localhost:3001 (Vite proxies `/api` to it)

### Docker (build locally)

```bash
cp .env.example .env   # set ENCRYPTION_KEY
docker compose up --build
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port the Express server listens on (default `3000`). |
| `DATA_DIR` | No | Directory for the SQLite database (default `./data`). |
| `ENCRYPTION_KEY` | **Yes** | Base64 32-byte key for encrypting stored app passwords. Generate with `openssl rand -base64 32`. |
| `NODE_ENV` | No | Set to `production` for the built image. |
| `AI_ENABLED` | No | Enable AI triage (`true`/`false`, default `false`). |
| `AI_API_BASE_URL` | No | OpenAI-compatible base URL (e.g. `http://localhost:1234/v1`). |
| `AI_API_KEY` | No | API key (optional for local servers). |
| `AI_MODEL` | No | Model name to use for triage. |
| `AI_DRY_RUN` | No | When `true`, no IMAP changes are made (suggestions only). |
| `AI_POLL_INTERVAL_MS` | No | How often to scan for new unread mail (default `300000`). |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for digest notifications. |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID to send digests to. |

See `.env.example` for the full list with descriptions.

## Getting an app password

- **Gmail** — enable 2-Step Verification, then create an App Password. IMAP host `imap.gmail.com:993`.
- **Outlook/Office 365** — `outlook.office365.com:993`.
- **iCloud** — generate an app-specific password. `imap.mail.me.com:993`.
- **Fastmail** — create an app password. `imap.fastmail.com:993`.

## Requirements (build from source)

- Node.js 20+ (24 recommended) and npm, or Docker.
