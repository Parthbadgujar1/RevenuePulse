// Promise Tracker
// Pure business logic for tracking payment promises and escalation

export type PromiseStatus = 'pending' | 'kept' | 'violated' | 'escalated';

export enum EscalationLevel {
  INITIAL = 0,
  FIRST_REMINDER = 1,
  FINAL = 2,
  ESCALATED = 3,
}

export interface PaymentPromise {
  /** Promise ID */
  id: string;
  /** Merchant ID */
  merchantId: string;
  /** Customer identifier */
  customerId: string;
  /** Promised amount in paise */
  amount: number;
  /** Promised payment date as ISO string */
  promisedDate: string;
  /** Channel through which promise was made */
  channel: 'phone' | 'email' | 'sms' | 'whatsapp';
  /** Current status */
  status: PromiseStatus;
  /** Current escalation level */
  escalationLevel: EscalationLevel;
  /** When the promise was created */
  createdAt: string;
}

export interface ViolationResult {
  /** Whether the promise has been violated */
  violated: boolean;
  /** Days past promised date (0 if not violated) */
  daysOverdue: number;
  /** Recommended next action */
  nextAction: string;
}

export interface EscalationAction {
  /** Description of the action to take */
  action: string;
  /** Days after violation before this action triggers */
  triggerDays: number;
  /** Maximum contact attempts at this level */
  maxContacts: number;
}

export interface PromiseKeepingStats {
  /** Total number of promises */
  totalPromises: number;
  /** Number of kept promises */
  keptPromises: number;
  /** Number of violated promises */
  violatedPromises: number;
  /** Keeping rate (0-1) */
  keepingRate: number;
  /** Average days overdue for violated promises */
  averageDaysOverdue: number;
}

// Baseline promise-keeping rates by channel
export const PROMISE_KEEPING_RATES: Record<string, number> = {
  phone: 0.65,
  email: 0.35,
  sms: 0.25,
  whatsapp: 0.45,
};

// Escalation actions by level
export const ESCALATION_ACTIONS: Record<EscalationLevel, EscalationAction> = {
  [EscalationLevel.INITIAL]: {
    action: 'Send automated reminder via original channel.',
    triggerDays: 1,
    maxContacts: 1,
  },
  [EscalationLevel.FIRST_REMINDER]: {
    action: 'Send follow-up reminder with updated payment link.',
    triggerDays: 3,
    maxContacts: 2,
  },
  [EscalationLevel.FINAL]: {
    action: 'Send final notice with deadline and consequences.',
    triggerDays: 7,
    maxContacts: 1,
  },
  [EscalationLevel.ESCALATED]: {
    action: 'Escalate to collections team or external agency.',
    triggerDays: 14,
    maxContacts: 0,
  },
};

// Check if a promise has been violated and determine next action
export function checkPromiseViolation(
  promise: PaymentPromise,
  now: Date
): ViolationResult {
  if (promise.status === 'kept') {
    return { violated: false, daysOverdue: 0, nextAction: 'No action needed; promise was kept.' };
  }

  if (promise.status === 'escalated') {
    return {
      violated: true,
      daysOverdue: 0,
      nextAction: 'Already escalated to collections.',
    };
  }

  const promisedDate = new Date(promise.promisedDate);
  const diffMs = now.getTime() - promisedDate.getTime();
  const daysOverdue = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

  if (daysOverdue <= 0) {
    return { violated: false, daysOverdue: 0, nextAction: 'Promise not yet due.' };
  }

  // Determine escalation level based on days overdue
  let nextLevel: EscalationLevel;
  if (daysOverdue < 3) {
    nextLevel = EscalationLevel.INITIAL;
  } else if (daysOverdue < 7) {
    nextLevel = EscalationLevel.FIRST_REMINDER;
  } else if (daysOverdue < 14) {
    nextLevel = EscalationLevel.FINAL;
  } else {
    nextLevel = EscalationLevel.ESCALATED;
  }

  const action = getEscalationAction(nextLevel);

  return {
    violated: true,
    daysOverdue,
    nextAction: action.action,
  };
}

// Get the escalation action for a given level
export function getEscalationAction(level: EscalationLevel): EscalationAction {
  return ESCALATION_ACTIONS[level];
}

// Calculate promise-keeping statistics for a merchant
export function calculatePromiseKeepingRate(
  merchantId: string,
  promises: PaymentPromise[]
): PromiseKeepingStats {
  const merchantPromises = promises.filter((p) => p.merchantId === merchantId);
  const totalPromises = merchantPromises.length;

  if (totalPromises === 0) {
    return {
      totalPromises: 0,
      keptPromises: 0,
      violatedPromises: 0,
      keepingRate: 0,
      averageDaysOverdue: 0,
    };
  }

  const keptPromises = merchantPromises.filter((p) => p.status === 'kept').length;
  const violatedPromises = merchantPromises.filter(
    (p) => p.status === 'violated' || p.status === 'escalated'
  ).length;

  const keepingRate = totalPromises > 0 ? keptPromises / totalPromises : 0;

  // Calculate average days overdue for violated promises
  const now = new Date();
  const violatedPromisesList = merchantPromises.filter(
    (p) => p.status === 'violated' || p.status === 'escalated'
  );

  let totalDaysOverdue = 0;
  for (const p of violatedPromisesList) {
    const promisedDate = new Date(p.promisedDate);
    const diffMs = now.getTime() - promisedDate.getTime();
    totalDaysOverdue += Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  }

  const averageDaysOverdue =
    violatedPromisesList.length > 0
      ? Math.round(totalDaysOverdue / violatedPromisesList.length)
      : 0;

  return {
    totalPromises,
    keptPromises,
    violatedPromises,
    keepingRate: Math.round(keepingRate * 1000) / 1000,
    averageDaysOverdue,
  };
}
