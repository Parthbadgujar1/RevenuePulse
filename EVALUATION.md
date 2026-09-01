# Evaluation

This document explains how the recovery model and the recovery pipeline are
measured and how to reproduce the published numbers. Everything here is
computed from committed artifacts (`services/ml/metrics.json`,
`services/ml/model/baseline_model.json`) or from a seeded, reproducible
experiment run — nothing is hardcoded in the dashboard.

## Model metrics (v4.0.0)

Served as `baseline-recovery-v4.0.0`. Held-out test metrics from
`services/ml/metrics.json`:

| Metric | Value |
| --- | --- |
| Model | logistic regression, isotonic calibration |
| Dataset rows | 80,603 (synthetic / benchmark-calibrated) |
| Train / test | 64,482 / 16,121 |
| ROC-AUC | 0.7741 |
| PR-AUC | 0.6578 |
| Brier score | 0.1825 |
| Accuracy | 0.7174 |
| Precision / Recall / F1 | 0.6488 / 0.4958 / 0.5621 |

The model won an honest head-to-head against histogram gradient boosting
(0.7741 vs 0.7716); boosting must win by > 0.01 to displace the transparent
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

Seed 20260823, 100 synthetic failures (~₹5.0L at risk): RevenuePulse recovers
**gross ₹3.36L (67.1%)** vs 47.2% for retry-everything
(**+₹99.5k gross uplift**) — inside the published 65–75% smart-dunning band.
Funnel: 100 diagnosed → 100 decided → 100 executed → 64 recovered; zero stopped
by policy, zero awaiting approval. Net figures subtract measured action cost
(`gross − cost − incentive = net`); incentive cost is ₹0 under the default
policy.

To reproduce:

```powershell
$env:DATABASE_URL="postgresql://postgres:password@localhost:5432/revenuepulse?schema=public"
npx tsx scripts/batch-experiment.ts 100
```

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
