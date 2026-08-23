// Idempotency Layer - Prevent duplicate webhook processing and actions
// Uses database constraints and transactional locking in production;
// in-memory TTL store as MVP placeholder.

// Idempotency key structure: {prefix}:{entityType}:{entityId}
// e.g., webhook:event_123456, action:{caseId}:{actionType}:{attempt}

interface IdempotencyEntry {
  expires: number; // epoch ms after which the key may be reclaimed
  acquiredAt: number;
  completedAt?: number;
  result?: string;
}

// Store declared BEFORE use (avoids TDZ runtime errors).
const IdempotencyStore: Record<string, IdempotencyEntry> = {};

/**
 * Try to acquire an idempotency key.
 * Returns true if acquired, false if the key exists and has not expired
 * or was already completed (i.e., work already done or in progress).
 */
export async function tryAcquireIdempotencyKey(
  key: string,
  ttlSeconds: number = 3600
): Promise<boolean> {
  const now = Date.now();
  const existing = IdempotencyStore[key];

  if (existing) {
    // Completed keys never re-acquire until pruned by TTL expiry.
    if (existing.completedAt !== undefined) {
      return false;
    }
    if (existing.expires > now) {
      return false; // In-flight acquisition
    }
    // Expired without completion - safe to reclaim
  }

  IdempotencyStore[key] = {
    expires: now + ttlSeconds * 1000,
    acquiredAt: now,
  };
  return true;
}

/**
 * Complete an idempotency key (mark the associated work as processed).
 */
export async function completeIdempotencyKey(
  key: string,
  result?: string
): Promise<void> {
  const entry = IdempotencyStore[key];
  if (!entry) return;

  entry.completedAt = Date.now();
  entry.result = result;
}

export interface IdempotencyRecord {
  key: string;
  entityType: string;
  entityId: string;
  acquiredAt: Date;
  completedAt?: Date;
  result?: string;
}
