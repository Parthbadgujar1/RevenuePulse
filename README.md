# RevenuePulse

AI revenue-recovery platform for subscription businesses. RevenuePulse watches payment webhooks (Razorpay), diagnoses why each payment failed against a failure taxonomy, predicts recovery probability with a calibrated ML model, and orchestrates recovery actions — retries, reminders, instrument upgrades, human escalation — under per-merchant policy guardrails. Every action is executed, its outcome verified, and the recovered money measured.

## Architecture

| Piece | Stack |
|---|---|
| Dashboard / API | Next.js (App Router) + Tailwind CSS — `apps/web` |
| Background worker | pg-boss consumer over PostgreSQL — `apps/worker` |
| Core packages | domain (taxonomy, features), policies (decision engine), observability (pipeline + queue), agent (tool registry + orchestrator), providers/razorpay (demo-first adapters) — `packages/*` |
| Database | Prisma 7 + PostgreSQL (driver adapter `@prisma/adapter-pg`) — `packages/database` (canonical schema: `packages/database/prisma/schema.prisma`) |
| ML service | FastAPI + scikit-learn calibrated logistic regression — `services/ml` |

## Pipeline

```
webhook → durable WebhookEvent row (idempotent) → Transaction + RevenueCase
        → ML score (model.joblib) → decision under policy guardrails
        → RecoveryAction → execution → Outcome verification
        → ₹ recovered / cost / net measured per case
```

In demo mode (`RAZORPAY_MODE=demo`, the default) unsigned webhooks are accepted and action outcomes are simulated by drawing from an **independent ground-truth propensity** (category base rate + retry fatigue + intervention fit) — deliberately not from the model's own score, so measured results are not circular.

## Getting started

Prereqs: Node 20+, PostgreSQL 14+, Python 3.11+.

```powershell
# 1. Install deps
npm install

# 2. Configure environment
#    apps/web/.env:
DATABASE_URL="postgresql://postgres:password@localhost:5432/revenuepulse?schema=public"
NEXTAUTH_SECRET="<any-long-random-string>"
NEXTAUTH_URL="http://localhost:3000"
#    Optional live mode:
#    RAZORPAY_MODE=live and RAZORPAY_WEBHOOK_SECRET=<from Razorpay dashboard>

# 3. Create schema + generate the Prisma client (both required)
npx prisma db push
npx prisma generate

# 4. Train the ML artifact (writes services/ml/model/model.joblib)
pip install -r services/ml/requirements.txt
python services/ml/data/generate_synthetic.py
python services/ml/train_baseline.py

# 5. Run everything
npx next dev            # in apps/web — http://localhost:3000
npx tsx apps/worker/index.ts   # pipeline worker
uvicorn src.main:app --port 8001  # in services/ml (optional; batch script calls it)

# 6. Reproduce the headline numbers (N synthetic failures through the real pipeline)
$env:DATABASE_URL="postgresql://postgres:password@localhost:5432/revenuepulse?schema=public"
npx tsx scripts/batch-experiment.ts 100
```

Demo sign-in: `owner@revenuepulse.dev` / `demo1234`

## Measured results (batch experiment, N=100, seeded)

The experiment reports an honest funnel (diagnosed → scored → executed → verified → recovered), a money funnel (at risk / recovered / cost / net) and a strategy comparison against no-intervention and retry-all baselines using the same ground-truth simulator. Expect RevenuePulse to beat retry-all on net recovery via intervention-fit selection (e.g., payment-method recovery for expired instruments) while spending less on hopeless cases.

## Key endpoints

- `POST /api/webhooks/razorpay` — webhook ingestion (signature verification, durable idempotency, async processing)
- `GET  /api/webhooks/razorpay` — health check
- `POST /api/ingest` — multipart file import (CSV / XLSX / PDF). `dryRun=true` returns the auto-detected column mapping, failure/captured counts and estimated at-risk amount; `dryRun=false` runs every imported failure through the full pipeline
- `POST /api/integrations/razorpay/sync` — pull recent payments from the Razorpay REST API using stored keys (key secret AES-256-GCM encrypted at rest)
- `/dashboard` — KPIs, recovery funnel, money funnel, leakage by category, recent cases
- ML service: `POST /predict`, `GET /health`, `GET /model-info` (honest held-out metrics + limitations)

## Bring your own data

Three ways to feed real failed payments into the same pipeline:

1. **Webhook** (`RAZORPAY_MODE=live` + webhook secret from the dashboard connection card) — strictly HMAC-verified.
2. **Razorpay REST sync** — connect Key ID + Key Secret under *Integrations* (stored encrypted), then "Sync Failed Payments" pulls the latest payments via `api.razorpay.com/v1/payments`.
3. **File import** (`/ingest`) — CSV, Excel (.xlsx/.xls) or even PDF reports. Headers are auto-mapped by fuzzy matching (`Payment ID`, `Transaction Amount (INR)`, `Failure Reason`, … all recognized), amounts auto-detect rupees vs paise (override in the UI), and a dry-run preview shows exactly what will be ingested before anything is committed.

PDF imports use heuristic line parsing (currency-marked amounts + status keywords + payment-id/method tokens), so structured exports like bank statements work best; CSV/XLSX are exact.

## Honest ML disclosure

- Model: logistic regression with isotonic calibration — chosen over gradient boosting because the honest held-out gain did not justify the complexity.
- Training data is **synthetic** (see `services/ml/data/generate_synthetic.py`); labels mean "a retry-style intervention eventually recovered this payment".
- Held-out metrics live in `services/ml/metrics.json` and are exposed verbatim at `GET /model-info`. The API refuses to serve if the trained artifact is missing.

## Honesty guarantees (what is real vs simulated)

**The trained model is load-bearing.** Every production decision path (`evaluateRecovery` in the pipeline) calls the FastAPI service that serves `model.joblib`; predictions persist with the real `modelVersion` (`baseline-recovery-v2.0.0`) on every Prediction row and in audit evidence. If the model service is unreachable, the pipeline job **fails loudly** — it never silently substitutes a hand-coded heuristic. A labeled fallback (`RP_ML_FALLBACK=heuristic`, version string `heuristic-fallback-v1`) exists for dev environments without Python.

**Demo vs live execution are structurally separate.**
- *Simulated* sources (Demo Lab batches, file imports) draw outcomes from an independent seeded ground-truth propensity; executions are stamped `SIMULATED_DEMO` in the audit trail.
- *Live* sources (Razorpay API sync, verified webhooks) execute in `PROVIDER_LIVE` mode: no outcome is ever fabricated. The case enters `OUTCOME_PENDING` and resolves only when a real provider event arrives (`resolvePendingLiveOutcomes`) or when the Razorpay API reports a terminal payment status — via the scheduled poller (`RP_VERIFY_POLL_SECONDS`, default 300s, `0` disables), the manual "Verify now" button on the case page (`POST /api/outcomes/verify`), recording the real provider transaction id as `verificationRef`.
- Every case shows a source badge: 🟣 Demo Lab · 🟢 File Import · 🟠 Razorpay API Sync (live) · 🔵 Razorpay Webhook.

**Reproducible experiments.** Demo Lab runs are fully deterministic given a seed: same seed ⇒ same cohort, same model scores, same ground-truth draws, bit-for-bit identical results. Re-running an identical batch is idempotent (deduplicated by stable event keys). The retry-all baseline is realized through the same seeded simulator — not an expected-value shortcut.

**Merchant isolation & secrets.** All dashboard queries are scoped via `requireMerchantContext()`; cross-tenant case ids 404. The anonymous demo tenant is a dev-only convenience: it is disabled in production (`NODE_ENV=production`) unless `RP_DEMO_FALLBACK=1` is set explicitly. Razorpay key secrets are validated against the live API at connect time and stored AES-256-GCM encrypted; sync/webhook flows decrypt only in memory. Webhooks require HMAC verification in live mode.

**Idempotency everywhere.** Provider events dedupe on stable keys (webhook event id / payment id / file-hash+row), so replays, re-syncs and re-uploads never create duplicate cases or double-spend recovery budget.

```powershell
# Unit tests (payload normalization + ML contract, no DB needed)
npm test
```
