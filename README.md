# RevenuePulse

AI revenue-recovery platform for subscription businesses. RevenuePulse watches payment webhooks (Razorpay), diagnoses why each payment failed against a failure taxonomy, predicts recovery probability with a calibrated ML model, and orchestrates recovery actions — retries, reminders, instrument upgrades, human escalation — under per-merchant policy guardrails. Every action is executed, its outcome verified, and the recovered money measured.

A short deep-dive on the genuine AI agent (ML predicts, LLM reasons, policy gates, executor acts) lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Architecture

| Piece | Stack |
|---|---|
| Dashboard / API | Next.js (App Router) + Tailwind CSS — `apps/web` |
| Background worker | pg-boss consumer over PostgreSQL — `apps/worker` (enable with `RP_USE_QUEUE=1` on the web process, then `npm run worker`; default runs jobs inline in the web process) |
| Core packages | domain (taxonomy, features), policies (decision engine), observability (pipeline + queue), agent (orchestrator + multi-model LLM reasoning), providers/razorpay (demo-first adapters) — `packages/*` |
| Database | Prisma 7 + PostgreSQL (driver adapter `@prisma/adapter-pg`) — `packages/database` (canonical schema: `packages/database/prisma/schema.prisma`) |
| ML service | FastAPI + scikit-learn calibrated logistic regression — `services/ml` |

## Pipeline

```
webhook → durable WebhookEvent row (idempotent) → Transaction + RevenueCase
        → ML score (model.joblib) → LLM reasoning (diagnose + recommend + explain)
        → decision under policy guardrails (authoritative)
        → RecoveryAction → execution → Outcome verification → ₹ recovered measured
```

The AI layer is explicit about who does what:

> **AI recommends. Policy authorizes. Razorpay executes. Evidence verifies.**

- The **ML model** scores recovery probability with a calibrated logistic regression served by FastAPI (fails loudly if unreachable — never silently swaps in a heuristic).
- The **LLM reasoning layer** (`packages/agent/src/llm`) proposes a diagnosis, a preferred action, and a human-readable rationale — with multi-key, multi-provider failover (Gemini + Groq via their OpenAI-compatible endpoints). The LLM **never moves money**: its output is advisory and the deterministic DecisionEngine always wins.
- The **DecisionEngine** is the authoritative gate, enforcing per-merchant policy (max retries, cooldown, approval threshold, stopping rules).
- The **executor** (`dispatchLiveAction`) is the only thing that touches Razorpay — in live mode it creates real Payment Links and resolves outcomes only from real provider events.

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
ML_SERVICE_URL="http://127.0.0.1:8001"
ML_INTERNAL_TOKEN="<shared secret for the ML service admin endpoints>"
#    Optional live mode:
#    RAZORPAY_MODE=live and RAZORPAY_WEBHOOK_SECRET=<from Razorpay dashboard>
#    Optional LLM reasoning (multi-key failover; deterministic fallback if unset):
#    GEMINI_API_KEY=...  GEMINI_API_KEY_2=...  GEMINI_API_KEY_3=...
#    GROQ_API_KEY=...    GROQ_API_KEY_2=...

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
# in services/ml, with a matching ML_INTERNAL_TOKEN:
#   $env:ML_INTERNAL_TOKEN="<shared secret>"; uvicorn src.main:app --port 8001

# 6. Reproduce the headline numbers (500 synthetic failures through the real pipeline)
npm run demo:500
```

Demo sign-in: `owner@revenuepulse.dev` / `demo1234`

## Measured results (batch experiment, 500 cases, seeded)

`npm run demo:500` runs **500** synthetic Razorpay failures through the real production pipeline (`processJob → evaluateRecovery → dispatchLiveAction → verifyOutcome`) and writes a machine-readable report to `evidence/batch-report.json`. Seed 20260823 — deterministic, reproducible.

Latest run (committed in `evidence/batch-report.json`):

- 500 failed payments ingested, 500 diagnosed, 500 decided & executed, **500 outcomes verified**, 296 recovered.
- Total at risk **₹25.5L** → gross **₹15.3L recovered (59.9% by amount)**, measured action cost ₹165.
- **RevenuePulse net ₹15.28L vs retry-everything net ₹13.23L → +₹2.05L uplift**, and vs ₹0 for no intervention.
- The retry-all baseline runs through the **same seeded ground-truth simulator** — not an expected-value shortcut, so the comparison is honest.

```powershell
# Reproduce from a clean-state DB (starts ML service on :8001, seeds, runs 500 cases)
npm run demo:500
```

(For a quick N=100 smoke run: `npm run experiment` or `npx tsx scripts/batch-experiment.ts 100`.)

## Deploy

Containerized. Three images built from the monorepo root, orchestrated by `docker-compose.yml`:

- **web** — Next.js `output: 'standalone'` (`apps/web/Dockerfile`)
- **worker** — pg-boss job consumer (`apps/worker/Dockerfile`; optional — set `RP_USE_QUEUE=1` on the web process to route jobs to it)
- **ml** — FastAPI prediction service (`services/ml/Dockerfile`)

No Redis is required: the job queue (pg-boss) and all persistence live in PostgreSQL. `ML_INTERNAL_TOKEN` must be set identically on the ML service and on any web/worker process that calls it (the service fails closed without it). LLM keys are optional (deterministic fallback otherwise).

```powershell
docker compose up -d --build   # db + ml + worker + web on :3000
```

For Railway, see `railway.toml` (single-managed-Postgres topology; set `DATABASE_URL`, `NEXTAUTH_SECRET`, `ML_SERVICE_URL`, `ML_INTERNAL_TOKEN`, optional `GEMINI_API_KEY*` / `GROQ_API_KEY*`).

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

- Model (v4): **logistic regression with isotonic calibration** — it won an honest head-to-head against histogram gradient boosting on held-out ROC-AUC (0.774 vs 0.771; the boosting candidate must win by >0.01 to displace the transparent baseline). Both scores are published in `services/ml/metrics.json` under `model_selection`.
- Training data is **synthetic but industry-calibrated**: 80,769 intervention outcomes whose generative process matches published 2025–26 subscription-recovery benchmarks — insufficient funds 55–70% recovery with timed retries, expired cards ~40% only with card-update outreach (and ~26% of failure volume), transient issuer/network errors up to 78%, voluntary cancellations <10%, blended smart-dunning tier 65–75%. Sources: Recurly Research, Stripe decline-code encyclopedia, SaaS Payment Failure Report 2026 (linked in `metrics.json → benchmark_sources`).
- Labels mean "a retry-style intervention eventually recovered this payment". Held-out metrics live in `services/ml/metrics.json` and are exposed verbatim at `GET /model-info` and on the dashboard's model strip.
- Measured 500-case result: **gross ₹15.3L of ₹25.5L at-risk money (59.9%) recovered vs ₹13.2L (51.9%) under retry-everything (+₹2.05L net uplift)** with zero actions stuck awaiting approval — reported in `evidence/batch-report.json`.

## Import template

Download a ready-to-fill CSV from `/ingest` ("Download sample CSV", served from
`apps/web/public/samples/revenuepulse-sample-payments.csv`). It contains the canonical
headers (`payment_id, created_at, status, method, amount, error_code,
error_description, email, phone, currency`) plus eight realistic example rows covering
every major failure category. Replace the rows with your own data — only `amount`
is strictly required; every other column sharpens diagnosis and recovery fit.

## Honesty guarantees (what is real vs simulated)

**The trained model is load-bearing.** Every production decision path (`evaluateRecovery` in the pipeline) calls the FastAPI service that serves `model.joblib`; predictions persist with the real served version (currently `baseline-recovery-v4.0.1` with 80,769 rows) on every Prediction row and in audit evidence. If the model service is unreachable, the pipeline job **fails loudly** — it never silently substitutes a hand-coded heuristic. A labeled fallback (`RP_ML_FALLBACK=heuristic`, version string `heuristic-fallback-v1`) exists for dev environments without Python.

**The LLM is advisory, never authoritative.** The multi-model reasoning layer (`packages/agent/src/llm/client.ts`) proposes a diagnosis, recommended action, and rationale for each case, and its output (provider, model, recommendation) is recorded in the audit trail. It **cannot** move money: the deterministic DecisionEngine makes the only decision the executor is allowed to act on, so even a hallucinating LLM cannot cause an unauthorized charge. If no LLM key is configured (or every provider fails), the pipeline logs `succeeded:false` with a deterministic fallback and continues — the reasoning layer is strictly an enhancement to the audit trail.

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

## Environment knobs

| Variable | Default | Meaning |
|---|---|---|
| `RAZORPAY_MODE` | `demo` | `demo` simulates outcomes; `live` executes against the real API |
| `RP_USE_QUEUE` | off (`inline`) | `1` routes pipeline jobs through pg-boss; run `npm run worker` to consume them |
| `RP_VERIFY_POLL_SECONDS` | `300` | Background live-outcome poll interval inside the web server; `0` disables |
| `RP_DEMO_FALLBACK` | on in dev, **off in production** | `1` allows the anonymous demo tenant in production; `0` forces it off everywhere |
| `ML_SERVICE_URL` | `http://127.0.0.1:8001` | FastAPI service serving `model.joblib`; pipeline fails loudly without it |
| `ML_INTERNAL_TOKEN` | — | Shared secret the web/worker send to ML admin endpoints; ML service fails closed (503) without it |
| `GEMINI_API_KEY` / `_2` / `_3` | — | Gemini keys for the LLM reasoning layer (tried in order, failover on error) |
| `GROQ_API_KEY` / `_2` | — | Groq keys for the LLM reasoning layer (tried in order, failover on error) |
