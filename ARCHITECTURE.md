# Architecture

RevenuePulse is an **AI Revenue Recovery Agent**: it closes the loop from a
failed payment to **verified, recovered money** — not a generic analytics
platform. This document describes the runtime topology, the package layout, the
end-to-end pipeline, and the invariants that keep demo data honest.

## Runtime topology

```
Razorpay ──webhook(1)──▶ apps/web (Next.js /api) ──enqueue──▶ Worker (apps/worker)
Razorpay ──REST sync──▶ apps/web                        │   │
File import (CSV/XLSX)▶ apps/web                         │   ▼
                                                        │   pg-boss queue (Postgres)
                                                        │   ▼
                              Prisma ORM ⇄ PostgreSQL ◀──┘
                              ML service (FastAPI, services/ml) ◀┐
                                                               │
                              Web dashboard (apps/web)          │
```

- **Ingestion** (`apps/web/app/api/ingest|webhooks|integrations`) normalizes a
  payment event into an internal event, verifies it, and persists it durably
  before enqueueing.
- **Worker** (`apps/worker`) consumes jobs from a **pg-boss** queue in
  Postgres. It is the only place that executes recovery actions, draws
  simulated outcomes, and writes outcomes.
- **ML service** (`services/ml`) serves `model.joblib` predictions over HTTP,
  gated by an internal bearer token. The pipeline calls it and fails loudly if
  it is unreachable — it never silently substitutes a heuristic.
- **Web dashboard** (`apps/web`) is a read/decision surface over real persisted
  rows; every KPI is computed from live pipeline data, never hardcoded.

## Workspace layout

| Package | Role |
| --- | --- |
| `packages/database` | Prisma client, schema, idempotency + webhook state machine |
| `packages/razorpay` | Webhook payload normalization, categorization, types |
| `packages/providers` | Webhook signature verification (Razorpay) |
| `packages/auth` | RBAC permission model |
| `packages/domain` | Pure business logic (economics, policy, retry, checkout, receivables) |
| `packages/policies` | Decision engine + intervention lift tables (single source of truth) |
| `packages/observability` | Queue worker, live/verify dispatch, ML client, audit logging |
| `packages/agent` | Agent orchestrator (diagnose → score → propose → explain; advisory only) |
| `apps/web` | Next.js dashboard, ingestion + webhook APIs, outcome verification |
| `apps/worker` | Long-running job consumer |
| `services/ml` | Model training, serving, drift, retraining |

## End-to-end pipeline

1. **Ingest** — a payment failure arrives via webhook, REST sync, or file
   import. It is normalized, de-duplicated on a stable key, and persisted.
2. **Diagnose** — `diagnoseFailure` maps provider error codes to a structured
   failure category (insufficient funds, expired instrument, network timeout,
   …) and stores diagnosis evidence.
3. **Predict** — the trained model computes the recovery probability from real
   features; the prediction (with served model version) is persisted.
4. **Decide** — the decision engine (`packages/policies`) reconciles the model
   probability with the merchant's policy guardrails (retries, contacts, case
   lifetime, cooldown, declined/repeated-failure stops, economics) to pick an
   intervention.
5. **Execute** — a bounded `RecoveryAction` is created and, if auto-approved,
   executed. Demo actions draw a seeded ground-truth outcome;
   **live** actions create a real Razorpay Payment Link and enter
   `OUTCOME_PENDING` — no outcome is ever fabricated.
6. **Verify** — demo outcomes are drawn from the simulator; live outcomes are
   resolved only from a real provider event (`payment_captured`) or a Razorpay
   API poll correlated through the payment link. `Outcome` rows store the
   verified amount and provider reference.
7. **Feedback** — verified outcomes are logged to `production_training.jsonl`
   (gitignored) and periodically re-trained into the model.

## Key invariants

- **Money actions are gated.** `isInterventionAllowed` enforces every merchant
  guardrail against the *real* model probability and live case context, and
  fails closed on a missing/NaN prediction.
- **Authorized ≠ recovered.** Only a captured payment is an outcome; an
  authorized-but-unsettled payment stays pending.
- **No fabricated provider refs.** Live execution either uses a real Razorpay
  payment-link id or honestly records the action without one.
- **Durable idempotency.** Webhook events dedupe on stable keys; the retained
  state machine is `RECEIVED → PROCESSING → PROCESSED | FAILED`, owned by the
  database, and enqueue failures return non-2xx so Razorpay retries.
- **Net economics.** `net = gross − action cost − incentive` (the dashboard and
  demo-lab implement this; incentive is ₹0 under the default policy).

## Webhook state machine

```
                 ┌──────────────────────────────────────────────┐
 provider event ─▶ WebhookEvent (RECEIVED) ─▶ PROCESSING ─▶ PROCESSED
                 │                                   │
                 │        enqueue failure            │ evaluation failure
                 └──────────────▶ FAILED (non-2xx, provider retries)
```

See `SECURITY.md` for the signature-verification and tenant-isolation model.
