# Meoly

A self-hosted, multi-account **IMAP email client** for the web. View and manage your
mail — mark read/unread, move, archive, delete — with a fast local cache. It is
**read/manage only: there is no way to send email**.

Built with:

- **Frontend** — Vite + React 19, the [Astryx](https://github.com/facebook/astryx) design
  system, Tailwind CSS v4, and lucide-react icons.
- **Backend** — Express 5 (TypeScript) REST API.
- **IMAP** — [`imapflow`](https://imapflow.com/), one persistent connection per account.
- **Cache** — `better-sqlite3`. App passwords are encrypted at rest (AES-256-GCM).

## How it works

- Add each mailbox with its IMAP host/port and an **app password** (not your login
  password). Presets for Gmail / Outlook / iCloud / Fastmail prefill host + port.
- The server keeps a single IMAP connection per account and serializes all operations
  over it with a mailbox lock.
- Message envelopes and flags are cached in SQLite; bodies are fetched lazily and cached.
  The UI renders from cache first, then re-syncs.

## Requirements

- Node.js 20+ (24 recommended) and npm, or Docker.

## Local development

```bash
cp .env.example .env
# generate an encryption key and paste it into .env as ENCRYPTION_KEY
openssl rand -base64 32

npm install
npm run dev
```

- Web (Vite dev server): http://localhost:5173
- API (Express): http://localhost:3001 (Vite proxies `/api` to it)

## Docker

```bash
cp .env.example .env      # set ENCRYPTION_KEY
docker compose up --build
```

Open http://localhost:3000. The SQLite database (accounts + cache) is persisted in the
`./data` volume.

## Environment variables

| Var              | Description                                                        |
| ---------------- | ------------------------------------------------------------------ |
| `PORT`           | Port the Express server listens on.                                |
| `DATA_DIR`       | Directory for the SQLite database (`meoly.db`).                    |
| `ENCRYPTION_KEY` | Base64 32-byte key used to encrypt stored app passwords. Required. |

## Getting an app password

- **Gmail** — enable 2-Step Verification, then create an App Password. IMAP host
  `imap.gmail.com:993`.
- **Outlook/Office365** — `outlook.office365.com:993`.
- **iCloud** — generate an app-specific password. `imap.mail.me.com:993`.
- **Fastmail** — create an app password. `imap.fastmail.com:993`.
