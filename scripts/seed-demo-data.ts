// Seed Demo Data - Synthetic transaction events for development and testing
// Generates realistic Razorpay-like webhook events for the recovery pipeline

import { normalizeRazorpayEvent } from '../packages/razorpay/src/index';
import { FailureCategory } from '../packages/domain/src/constants/failure-taxonomy';

// Transaction event configurations - realistic distributions
const transactionEvents = [
  // Successful payments (should not create recovery cases)
  {
    type: 'payment_successful',
    data: {
      id: 'receipt_1',
      amount: 500000, // ₹5,000
      currency: 'INR',
      status: 'successful',
      method: 'card',
      error: null,
      time_created: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    },
  },
  // Transient failures - recoverable
  {
    type: 'payment_failed',
    data: {
      id: 'order_1',
      amount: 100000, // ₹1,000
      currency: 'INR',
      status: 'failed',
      method: 'card',
      error: {
        code: 'TIMEOUT',
        description: 'Network connection timeout',
      },
      time_created: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago,
    },
  },
  // Bank failure - potentially recoverable
  {
    type: 'payment_failed',
    data: {
      id: 'order_2',
      amount: 500000, // ₹5,000
      currency: 'INR',
      status: 'failed',
      method: 'card',
      error: {
        code: 'RA0014', // Razorpay bank failure code
        description: 'Bank side failure - please retry',
      },
      time_created: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago,
    },
  },
  // Insufficient funds - lower recoverability
  {
    type: 'payment_failed',
    data: {
      id: 'order_3',
      amount: 2000, // ₹20
      currency: 'INR',
      status: 'failed',
      method: 'upi',
      error: {
        code: 'INSUFFICIENT_FUNDS',
        description: 'Insufficient funds in account',
      },
      time_created: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), // 6 hours ago,
    },
  },
  // Auth failure - usually transient
  {
    type: 'payment_failed',
    data: {
      id: 'order_4',
      amount: 100000, // ₹1,000
      currency: 'INR',
      status: 'failed',
      method: 'card',
      error: {
        code: 'AUTH_ERROR',
        description: 'Authentication failure - card declined',
      },
      time_created: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago,
    },
  },
  // Expired instrument - lower recoverability without update
  {
    type: 'payment_failed',
    data: {
      id: 'order_5',
      amount: 300000, // ₹3,000
      currency: 'INR',
      status: 'failed',
      method: 'card',
      error: {
        code: 'CARD_EXPIRED',
        description: 'Card expired',
      },
      time_created: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago,
    },
  },
  // Repeated failure - should have diagnosis
  {
    type: 'payment_failed',
    data: {
      id: 'order_6',
      amount: 50000, // ₹500
      currency: 'INR',
      status: 'failed',
      method: 'card',
      error: {
        code: 'REPEATED_ATTEMPT',
        description: 'Repeated failure - check pattern',
      },
      time_created: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 2 days ago,
    },
  },
];

// Merchants for the demo
const merchants = [
  { id: 'm1', name: 'TechStore', currency: 'INR' },
  { id: 'm2', name: 'FashionBazaar', currency: 'INR' },
  { id: 'm3', name: 'DigitalGoods', currency: 'INR' },
];

// Generate seeded demo data
export function generateSeedData(
  count: number = 20,
  merchantIndex: number = 0
) {
  const merchant = merchants[merchantIndex % merchants.length];
  const events = [];
  
  // Shuffle and pick events
  const shuffled = [...transactionEvents].sort(() => Math.random() - 0.5);
  
  for (let i = 0; i < count; i++) {
    const eventModel = shuffled[i % shuffled.length];
    const event = {
      ...eventModel,
      merchantId: merchant.id,
      merchantName: merchant.name,
    };
    
    // Normalize the event - wrap with the event-type field normalizeRazorpayEvent expects
    const normalized = normalizeRazorpayEvent({
      ...event,
      event: event.type,
    } as any);
    
    events.push({
      ...event,
      normalizedEvent: normalized,
      merchant,
    });
  }
  
  return events;
}

// Print summary of generated data
export function printSeedSummary(events: any[]) {
  console.log('=== Seed Demo Data Summary ===\n');
  
  const total = events.length;
  const failedEvents = events.filter(e => e.normalizedEvent.eventType === 'payment_failed');
  const successEvents = events.filter(e => e.normalizedEvent.eventType === 'payment_successful');
  
  console.log(`Total events generated: ${total}`);
  console.log(`Failed events: ${failedEvents.length}`);
  console.log(`Successful events: ${successEvents.length}\n`);
  
  // Group by failure category
  const categoryCounts: Record<string, number> = {};
  failedEvents.forEach(e => {
    const cat = e.normalizedEvent.safeMetadata.failureCategory;
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });
  
  console.log('Failure categories:');
  for (const [cat, count] of Object.entries(categoryCounts)) {
    console.log(`  • ${cat}: ${count} (${(count/failedEvents.length*100).toFixed(1)}%)`);
  }
  
  // Amount at risk
  const totalAmountAtRisk = failedEvents.reduce(
    (sum, e) => sum + e.normalizedEvent.safeMetadata.amount,
    0
  );
  console.log(`\nTotal amount at risk: ₹${(totalAmountAtRisk/100).toLocaleString()}`);
  
  // Average probability estimate
  const avgProbability = failedEvents.reduce(
    (sum, e) => {
      // Simple heuristic: higher amount + certain categories = higher prob
      const baseProb = 0.5;
      const amountFactor = Math.min(e.normalizedEvent.safeMetadata.amount / 10000, 1) * 0.2;
      const categoryBoost: Record<string, number> = {
        'insufficient_funds': 0.1,
        'bank_failure': 0.15,
        'auth_failure': 0.2,
        'network_timeout': 0.1,
        'expired_instrument': -0.1,
        'customer_cancellation': -0.2,
        'unknown': 0,
      };
      const catBoost = categoryBoost[e.normalizedEvent.safeMetadata.failureCategory] || 0;
      return sum + Math.max(0, Math.min(1, baseProb + amountFactor + catBoost));
    },
    0
  ) / failedEvents.length;
  
  console.log(`Average recovery probability estimate: ${(avgProbability*100).toFixed(1)}%\n`);
  
  // Show a few sample events
  console.log('Sample events:');
  events.slice(0, 5).forEach((e, i) => {
    const status = e.normalizedEvent.eventType;
    const amount = e.normalizedEvent.safeMetadata.amount;
    const cat = e.normalizedEvent.safeMetadata.failureCategory;
    console.log(`  ${i + 1}. ${status}: ₹${(amount/100).toLocaleString()} [${cat}]`);
  });
  
  console.log('=== End of Summary ===');
}

// Example usage
const demoEvents = generateSeedData(30, 0);
printSeedSummary(demoEvents);

// Export for use by other scripts
export { demoEvents, merchants, transactionEvents };