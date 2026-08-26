// Receivables Chaser
// Pure business logic for aging analysis, collection prioritization, and payment plans

export type AgingBucket = '0-30' | '31-60' | '61-90' | '90+';

export interface ReceivablesSummary {
  /** Total overdue amount in paise */
  totalOverdue: number;
  /** Breakdown by aging bucket */
  byBucket: Record<AgingBucket, number>;
  /** Weighted average overdue days */
  averageOverdueDays: number;
  /** Historical collection rate (0-1) */
  collectionRate: number;
}

export interface InvoiceInput {
  /** Invoice amount in paise */
  amount: number;
  /** Days overdue */
  overdueDays: number;
  /** Number of previous payments made on time */
  previousOnTimePayments: number;
  /** Number of previous late payments */
  previousLatePayments: number;
  /** Customer health score (0-100) */
  customerHealthScore: number;
  /** Invoice due date as ISO string */
  dueDate: string;
}

export interface CollectionPriority {
  /** Priority score (higher = chase first) */
  score: number;
  /** Assigned urgency tier */
  tier: 'critical' | 'high' | 'medium' | 'low';
  /** Reasoning for the priority */
  reasoning: string;
}

export interface PaymentInstallment {
  /** Installment amount in paise */
  amount: number;
  /** Due date as ISO string */
  dueDate: string;
  /** Installment sequence number (1-based) */
  sequence: number;
}

// Baseline collection rates by aging bucket
export const BASE_COLLECTION_RATES: Record<AgingBucket, number> = {
  '0-30': 0.85,
  '31-60': 0.65,
  '61-90': 0.40,
  '90+': 0.15,
};

// Determine aging bucket from overdue days
export function calculateAgingBucket(overdueDays: number): AgingBucket {
  if (overdueDays <= 30) return '0-30';
  if (overdueDays <= 60) return '31-60';
  if (overdueDays <= 90) return '61-90';
  return '90+';
}

// Calculate collection priority score for an invoice
export function calculateCollectionPriority(
  invoice: InvoiceInput
): CollectionPriority {
  const bucket = calculateAgingBucket(invoice.overdueDays);
  const baseRate = BASE_COLLECTION_RATES[bucket];

  // Amount factor: higher amounts get more attention
  const amountFactor = Math.min(2.0, 1.0 + Math.log(invoice.amount / 10000 + 1) * 0.3);

  // Overdue days factor: older = higher priority
  const overdueFactor = Math.min(2.0, 1.0 + invoice.overdueDays / 60);

  // Payment history factor: reliable customers slightly lower priority
  const totalPayments =
    invoice.previousOnTimePayments + invoice.previousLatePayments;
  const onTimeRate = totalPayments > 0
    ? invoice.previousOnTimePayments / totalPayments
    : 0.5;
  const historyFactor = 1.3 - onTimeRate * 0.6; // worse history = higher priority

  // Health score factor: lower health = higher priority
  const healthFactor = 1.5 - (invoice.customerHealthScore / 100) * 0.5;

  // Base recovery urgency: harder-to-collect buckets are more urgent
  const urgencyFactor = 2.0 - baseRate;

  const rawScore =
    amountFactor * overdueFactor * historyFactor * healthFactor * urgencyFactor * 100;

  const score = Math.max(0, Math.min(1000, Math.floor(rawScore)));

  let tier: CollectionPriority['tier'];
  if (score >= 600) tier = 'critical';
  else if (score >= 400) tier = 'high';
  else if (score >= 200) tier = 'medium';
  else tier = 'low';

  const reasoning =
    `Score ${score}: amount=${amountFactor.toFixed(2)}, overdue=${overdueFactor.toFixed(2)}, ` +
    `history=${historyFactor.toFixed(2)}, health=${healthFactor.toFixed(2)}, urgency=${urgencyFactor.toFixed(2)}`;

  return { score, tier, reasoning };
}

// Generate a payment plan with equal installments spread over future dates
export function generatePaymentPlan(
  invoice: InvoiceInput,
  maxInstallments: number
): PaymentInstallment[] {
  if (maxInstallments <= 0 || invoice.amount <= 0) return [];

  // Determine reasonable number of installments based on amount and health
  const recommendedInstallments = Math.min(
    maxInstallments,
    Math.max(2, Math.ceil(invoice.amount / 250000))
  );

  const installmentAmount = Math.floor(
    invoice.amount / recommendedInstallments
  );
  const remainder = invoice.amount - installmentAmount * recommendedInstallments;

  const today = new Date();
  const installments: PaymentInstallment[] = [];

  for (let i = 0; i < recommendedInstallments; i++) {
    // Spread installments 15 days apart starting from 7 days from now
    const dueDate = new Date(today);
    dueDate.setDate(dueDate.getDate() + 7 + i * 15);

    // Add remainder to first installment
    const amount = installmentAmount + (i === 0 ? remainder : 0);

    installments.push({
      amount,
      dueDate: dueDate.toISOString(),
      sequence: i + 1,
    });
  }

  return installments;
}
