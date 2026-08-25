import { prisma } from '@rp/database';

/** Reset all pipeline data so a fresh demo cohort can be measured cleanly. */
async function main() {
  await prisma.auditLog.deleteMany({});
  await prisma.outcome.deleteMany({});
  await prisma.recoveryAction.deleteMany({});
  await prisma.prediction.deleteMany({});
  await prisma.revenueCase.deleteMany({});
  await prisma.transaction.deleteMany({});
  await prisma.webhookEvent.deleteMany({});
  console.log('pipeline tables cleared');
  await prisma.$disconnect();
}
main();
