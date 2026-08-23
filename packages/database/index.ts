// Database package entry point
// Prisma 7 generates the client into prisma/generated/prisma (not @prisma/client)
// and requires a driver adapter at construction time.
import { PrismaClient } from './prisma/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

export { PrismaClient } from './prisma/generated/prisma/client';
export {
  ensureDemoMerchant,
  registerWebhookEvent,
  markWebhookProcessing,
  markWebhookProcessed,
  markWebhookFailed,
  hashPayload,
} from './src/idempotency';
export type { IdempotencyRecord, WebhookStatus } from './src/idempotency';

// Singleton PrismaClient (survives HMR in dev)
const globalForPrisma = globalThis as unknown as { __revenuePulsePrisma?: InstanceType<typeof PrismaClient> };

function createClient(): InstanceType<typeof PrismaClient> {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://postgres:password@localhost:5432/revenuepulse?schema=public';
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter }) as InstanceType<typeof PrismaClient>;
}

export const prisma: InstanceType<typeof PrismaClient> =
  globalForPrisma.__revenuePulsePrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__revenuePulsePrisma = prisma;
}
