/**
 * Shared AES-256-GCM encryption for provider/API secrets at rest.
 *
 * Lives here (in the observability package) so both the web app and the
 * background queue worker can encrypt and decrypt the same secrets without
 * an app->web dependency. apps/web/lib/crypto.ts re-exports these helpers so
 * existing call sites keep working.
 *
 * Key derived from NEXTAUTH_SECRET (or RP_SECRET) via scrypt.
 * Fail-closed: in production a missing secret throws; development falls back
 * to the documented dev key.
 */
import * as crypto from 'crypto';

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET || process.env.RP_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('NEXTAUTH_SECRET or RP_SECRET must be set in production');
    }
    return 'revenuepulse-dev-only-secret';
  }
  return secret;
}

function key(): Buffer {
  return crypto.scryptSync(getSecret(), 'revenuepulse.kesalt', 32);
}

/** AES-256-GCM encrypt -> "v1.<iv>.<tag>.<ciphertext>" (base64). */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

/** Decrypt a "v1.*" blob; returns null on any failure (never throws). */
export function decryptSecret(stored: string): string | null {
  try {
    const [version, ivB64, tagB64, dataB64] = stored.split('.');
    if (version !== 'v1') return null;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}