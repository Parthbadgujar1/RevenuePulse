# Evaluation

This document explains how the recovery model and the recovery pipeline are
measured and how to reproduce the published numbers. Everything here is
computed from committed artifacts (`services/ml/metrics.json`,
`services/ml/model/baseline_model.json`) or from a seeded, reproducible
experiment run — nothing is hardcoded in the dashboard.

## Model metrics (v4)

Served as `baseline-recovery-v4.0.1`. Held-out test metrics from
`services/ml/metrics.json`:

| Metric | Value |
| --- | --- |
| Model | logistic regression, isotonic calibration |
| Dataset rows | 80,769 (synthetic / benchmark-calibrated) |
| Train / test | 64,615 / 16,154 |
| ROC-AUC | 0.7738 |
| Brier score | 0.1826 |
| Accuracy | 0.7176 |

The model won an honest head-to-head against histogram gradient boosting
(0.774 vs 0.771); boosting must win by > 0.01 to displace the transparent
baseline (`metrics.json → model_selection.selection_rule`).

## Dataset provenance

Training data is **synthetic but industry-calibrated**:
`generate_synthetic.py` produces intervention outcomes whose generative
process matches published 2025–26 subscription-recovery benchmarks
(insufficient funds 55–70% with timed retries, expired cards ~40% (≈26% of
failure volume), transient errors up to 78%, voluntary cancellations <10%,
blended smart-dunning 65–75%). Benchmark sources are linked in
`metrics.json → benchmark_sources`. The `real_world_500.csv` sample has been
renamed `synthetic_payment_sample_500.csv` to remove any misleading implication
that it is real production data.

Production retraining instead accumulates **real verified outcomes** in
`services/ml/data/production_training.jsonl` (gitignored, written by the
pipeline after each verified outcome) and re-fits on demand.

## Reproducibility

- Demo Lab batches are **deterministic given a seed**: same seed ⇒ same cohort,
  same model scores, same ground-truth draws, bit-for-bit identical results.
- Re-running an identical batch is idempotent (deduplicated by stable event
  keys).
- The retry-all baseline is realized through the same seeded simulator — not an
  expected-value shortcut.

## Headline result

Seed 20260823, **500 synthetic failures** (~₹25.5L at risk) through the real
production pipeline (committed in `evidence/batch-report.json`): RevenuePulse
recovers **gross ₹15.3L (59.9%)**, **net +₹2.05L vs retry-everything**
(₹15.28L vs ₹13.23L net; the no-intervention baseline is ₹0). Funnel: 500
diagnosed → 500 decided → 500 executed → 500 outcomes verified → 296 recovered;
zero stopped by policy, zero awaiting approval.

To reproduce:

```powershell
# From a clean-state DB (starts the ML service on :8001, seeds, runs 500 cases)
npm run demo:500
```

A quick smoke run with 100 cases:
`npx tsx scripts/batch-experiment.ts 100` (requires a running ML service).

## Limits & honesty

- Linear baseline: no explicit feature interactions (additive logit).
- Calibration is valid only within the training distribution.
- Label definition: *"recovered = 1 if a retry-style intervention eventually
  recovered this payment."*
- Live (non-demo) outcomes are **not simulated**: a case enters
  `OUTCOME_PENDING` and resolves only from a real provider event or Razorpay
  API poll correlated through the payment link.

## Test gates

| Suite | Command | Count |
| --- | --- | --- |
| Unit (pure logic, no DB) | `npx tsx scripts/test-unit.ts` | 168 |
| Integration (needs Postgres) | `npx tsx scripts/test-integration.ts` | 24 |

The adversarial cases pin the money-action gateway (policy guardrails,
fail-closed inputs, net economics), webhook/cross-tenant isolation, duplicate
execution, and retry exhaustion behaviors.
