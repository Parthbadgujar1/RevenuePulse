import * as crypto from 'crypto';

/**
 * AES-256-GCM encryption for provider API secrets at rest.
 * Key derived from NEXTAUTH_SECRET (or a dev fallback) via scrypt.
 */
function key(): Buffer {
  const secret =
    process.env.NEXTAUTH_SECRET ||
    process.env.RP_SECRET ||
    'revenuepulse-dev-only-secret';
  return crypto.scryptSync(secret, 'revenuepulse.kesalt', 32);
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

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
