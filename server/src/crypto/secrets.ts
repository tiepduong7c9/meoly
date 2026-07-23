import crypto from 'node:crypto';
import { env } from '../env.js';

const ALGO = 'aes-256-gcm';

/**
 * Encrypt a secret (IMAP app password) for storage at rest.
 * Format: base64(iv).base64(authTag).base64(ciphertext)
 */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, env.encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted secret');
  }
  const decipher = crypto.createDecipheriv(
    ALGO,
    env.encryptionKey,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
