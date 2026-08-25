import { prisma } from '@rp/database';
import { decryptSecret } from './crypto';

/**
 * Resolve Razorpay API credentials for a merchant: stored connection first
 * (AES-256-GCM encrypted at rest), then env fallback. Returns {error} when
 * nothing usable is configured so routes can return a helpful 400.
 */
export async function resolveRazorpayCredentials(
  merchantId: string
): Promise<{ keyId: string; keySecret: string } | { error: string }> {
  const conn = await prisma.providerConnection.findFirst({
    where: { merchantId, provider: 'razorpay', status: 'active' },
    orderBy: { id: 'desc' },
  });
  if (conn?.keySecretEncrypted && conn.keyId) {
    const secret = decryptSecret(conn.keySecretEncrypted);
    if (!secret) {
      return {
        error:
          'Stored Razorpay key secret could not be decrypted. Reconnect the integration.',
      };
    }
    return { keyId: conn.keyId, keySecret: secret };
  }
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    return {
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
    };
  }
  return {
    error:
      'No Razorpay API keys available. Connect with Key ID + Key Secret on /integrations (stored encrypted), or set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.',
  };
}
