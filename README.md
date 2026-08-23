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
- `/dashboard` — KPIs, recovery funnel, money funnel, leakage by category, recent cases
- ML service: `POST /predict`, `GET /health`, `GET /model-info` (honest held-out metrics + limitations)

## Honest ML disclosure

- Model: logistic regression with isotonic calibration — chosen over gradient boosting because the honest held-out gain did not justify the complexity.
- Training data is **synthetic** (see `services/ml/data/generate_synthetic.py`); labels mean "a retry-style intervention eventually recovered this payment".
- Held-out metrics live in `services/ml/metrics.json` and are exposed verbatim at `GET /model-info`. The API refuses to serve if the trained artifact is missing.
