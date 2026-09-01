# Demo

RevenuePulse is an **AI Revenue Recovery Agent**: from a failed payment to
verified, recovered money. This guide walks through a full, single-command demo
and then step-by-step exploration of the dashboard.

## Prerequisites

- Node 20+ and PostgreSQL running locally (`DATABASE_URL` in `.env`, default
  `postgresql://postgres:password@localhost:5432/revenuepulse?schema=public`).
- Python 3.10+ for the ML service (optional for the headless demo — the
  pipeline fails loudly without it, and `RP_ML_FALLBACK=heuristic` is available
  for dev environments without Python).

## One command

```powershell
npm run demo
```

This runs: schema push + Prisma generate → generate synthetic ML data → train
the model → seed demo data → run the 100-case seeded batch experiment and print
the funnel + money + strategy comparison. It reproduces the headline numbers
(gross ₹3.36L / 67.1% vs 47.2% retry-all, +₹99.5k uplift).

## Full interactive demo

1. **Start services**
   ```powershell
   # terminal 1 — pipeline worker (consumes pg-boss jobs)
   npm run worker
   # terminal 2 — web dashboard
   npx next dev   # in apps/web — http://localhost:3000
   # terminal 3 — ML service (optional)
   uvicorn src.main:app --port 8001   # in services/ml
   ```

2. **Sign in** → `owner@revenuepulse.dev` / `demo1234`

3. **Generate + run a simulated cohort** — open the **Demo Lab**, choose a seed,
   generate a checkout/promises/ingest batch and run it. Every case flows
   through diagnose → predict → decide → execute → verify, and each case shows
   a **source badge** (🟣 Demo Lab · 🟢 File Import · 🟠 Razorpay API Sync ·
   🔵 Razorpay Webhook).

4. **Explore the dashboard** — KPI cards (recovered gross vs net recovery after
   cost), revenue pulse, leakage by category, recent cases and AI-generated
   revenue-intelligence insights computed from live rows.

5. **Live recovery (optional)** — connect Razorpay Key ID + Key Secret under
   *Integrations* (validated against the live API, stored encrypted) and either
   webhook (`RAZORPAY_MODE=live`) or REST-sync failed payments. Live actions
   enter `OUTCOME_PENDING` and resolve **only** from a real captured payment —
   nothing is simulated.

## Honesty notes

- Demo (simulated) outcomes are drawn from an independent seeded
  ground-truth propensity and stamped `SIMULATED_DEMO` in the audit trail.
- Live outcomes are never fabricated; the source, provider ref, and model
  version are recorded per outcome.
- The dashboard computes every KPI from persisted rows; nothing is hardcoded.
