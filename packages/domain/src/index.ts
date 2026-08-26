// Domain Package - Shared types and business logic
// All functions are pure (no side effects, no LLM, no arbitrary API access)
// This makes them testable and replaceable

export * from './constants/failure-taxonomy';
export * from './constants/recovery-models';
export * from './services/domain-services';
export * from './services/checkout-recovery';
export * from './services/receivables-chaser';
export * from './services/retry-sequencer';
export * from './services/promise-tracker';
