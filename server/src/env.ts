import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// The dev server runs with cwd at server/, but .env lives at the monorepo root.
// Walk up from both cwd and this module's directory to find the nearest .env.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const start of [process.cwd(), here]) {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

const encryptionKeyRaw = required('ENCRYPTION_KEY');
const encryptionKey = Buffer.from(encryptionKeyRaw, 'base64');
if (encryptionKey.length !== 32) {
  throw new Error(
    'ENCRYPTION_KEY must be a base64-encoded 32-byte key. Generate one with: openssl rand -base64 32',
  );
}

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');

export const env = {
  port: Number(process.env.PORT ?? 3001),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  dataDir,
  dbPath: path.join(dataDir, 'meoly.db'),
  encryptionKey,
  /** Path to the built SPA, served in production. */
  webDist: path.resolve(process.cwd(), 'web/dist'),
} as const;
