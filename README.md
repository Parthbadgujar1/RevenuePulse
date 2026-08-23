# RevenuePulse

AI revenue-recovery platform for subscription businesses. RevenuePulse watches payment webhooks (Razorpay), diagnoses why each payment failed against a failure taxonomy, predicts recovery probability with an ML model, and orchestrates recovery actions — retries, dunning emails, instrument-upgrade nudges — under per-merchant policy guardrails.

## Architecture

| Piece | Stack |
|---|---|
| Dashboard / API | Next.js (App Router) + Tailwind CSS — `apps/web` |
| Background worker | pg-boss consumer over PostgreSQL — `apps/worker` |
| Core packages | domain (taxonomy, features), policies (decision engine), agent (tool registry + orchestrator), providers/razorpay (simulation-first adapters) — `packages/*` |
| Database | Prisma 7 + PostgreSQL (driver adapter `@prisma/adapter-pg`) — `packages/database` |
| ML service | FastAPI + scikit-learn baseline recovery model — `services/ml` |

## Getting started

```bash
npm install
npx prisma db push        # from repo root
$env:DATABASE_URL="postgresql://..."; npx tsx services/ml/../../scripts  # see scripts/
npx next dev              # in apps/web — http://localhost:3000
npx tsx apps/worker/index.ts
```

Demo sign-in: `owner@revenuepulse.dev` / `demo1234`

## Key endpoints

- `POST /api/webhooks/razorpay` — webhook ingestion (signature verification, idempotency, async processing)
- `GET  /api/webhooks/razorpay` — health check
- `/dashboard` — live revenue-at-risk, leakage by category, recent cases
