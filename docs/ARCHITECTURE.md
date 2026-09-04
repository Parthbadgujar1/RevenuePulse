# RevenuePulse — Architecture & the Genuine AI Agent

RevenuePulse is a revenue-recovery platform for subscription businesses. It watches
Razorpay payment failures, diagnoses *why* each one failed, predicts how likely it is
to recover, and orchestrates recovery actions — retries, reminders, instrument
upgrades, human escalation — under per-merchant policy guardrails. Every action is
executed, its outcome verified, and the money recovered is measured.

The whole design rests on one principle:

> **AI recommends. Policy authorizes. Razorpay executes. Evidence verifies.**

---

## 1. The money pipeline (end to end)

```
Razorpay webhook (or file import / REST sync)
        │   HMAC-verified in live mode; idempotent by provider event id
        ▼
WebhookEvent (durable row) ──► Transaction + RevenueCase
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  evaluateRecovery (packages/observability/src/queue.ts)      │
│                                                             │
│  1. DIAGNOSE — deterministic failure taxonomy maps the       │
│     provider error code to a rooted cause                    │
│  2. SCORE    — ML model (FastAPI serving model.joblib)       │
│               predicts recovery probability                  │
│  3. REASON   — LLM proposes diagnosis + action + rationale   │
│               (advisory only)                                │
│  4. DECIDE   — DecisionEngine enforces per-merchant policy    │
│               (max retries, cooldown, approval threshold,    │
│               stopping rules)  ← AUTHORITATIVE               │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
        RecoveryAction (idempotent upsert)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  EXECUTOR (packages/observability/src/razorpay-live.ts)      │
│   • live mode  → Razorpay Payment Link (real money)          │
│   • demo mode  → independent seeded ground-truth simulator   │
│   CASE → OUTCOME_PENDING … resolves ONLY from a real         │
│   provider event or API status (never fabricated)            │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
        Outcome (verified) → ₹ recovered, cost, net measured
                               │
                               ▼
        AuditLog (every AI recommendation + decision + execution)
```

The pipeline is a strict state machine: `DETECTED → DIAGNOSED → SCORED → REASONED →
POLICY_CHECK → APPROVAL_REQUIRED/APPROVED → EXECUTING → EXECUTED → OUTCOME_PENDING →
RECOVERED / FAILED / STOPPED`.

## 2. Where the AI actually is

There are **two** AI layers, and it is critical they are not conflated.

### 2a. The ML model — predictive, load-bearing

- A calibrated logistic-regression model (`services/ml/model/model.joblib`, served by
  FastAPI at `POST /predict`) predicts the probability a failed payment recovers.
- It is the **authoritative probability source**. If the service is unreachable the
  pipeline job fails loudly — it never silently substitutes a hand-coded heuristic
  (a labeled `RP_ML_FALLBACK=heuristic` opt-in exists for dev machines only).
- Each prediction is persisted with its real served model version and exposed
  honestly (`GET /model-info`, `services/ml/metrics.json`).
- It was selected by an honest head-to-head vs gradient boosting on held-out ROC-AUC
  and is calibrated with isotonic regression.

### 2b. The LLM reasoning layer — advisory, never authoritative

`packages/agent/src/llm/client.ts` is a genuine multi-model reasoning client:

- Supports **multiple providers** (Gemini + Groq) and **multiple keys each**
  (`GEMINI_API_KEY[_2|_3]`, `GROQ_API_KEY[_2]`), tried in order with failover —
  an auth error or 5xx on one key rolls to the next, then to the other provider.
- Calls OpenAI-compatible `chat/completions` endpoints with **structured-JSON output**
  (`response_format: json_object`) and **strict schema validation** client-side:
  the diagnosis category must be a known `FailureCategory`, the action a known
  `InterventionType`, confidence in `[0,1]` — anything else is rejected and the next
  provider is tried.
- Produces `{ diagnosis{category,confidence,evidence[]}, recommendedAction, rationale,
  keyFactors }` — a diagnosis, a recommendation, and an explanation.

> **Why the LLM cannot move money.** The DecisionEngine is deterministic code, not a
> model. Its result is the only signal the executor is allowed to act on. A hallucinating
> or adversarial LLM output cannot authorize a charge — at worst it makes a
> mislabeled recommendation that the audit trail records but the policy gate ignores.

### 2c. The agent orchestrator

`packages/agent/src/orchestrator/index.ts` (`AgentOrchestrator.orchestrate`) is the
production hook: diagnose → retrieve context → score → propose → explain. Its output is
the explainable diagnosis + rationale persisted to the audit trail, and it never
executes money actions. The executor (`dispatchLiveAction`) is the only code that
touches Razorpay.

## 3. Policy & compliance (Track 03 requirements)

The `DecisionEngine` (`packages/policies/src`) is deterministically authoritative:

- **Per-merchant guardrails**: max incentive %, max recovery value, max retries,
  max contacts, min recovery probability, min expected net, human-approval threshold
  (₹10k default), cooldown, case lifetime.
- **Stopping rules**: `stopOnCustomerDecline`, `stopOnRepeatedFailure`,
  `stopOnPolicyViolation` — a declined customer or a repeated failure stops the loop.
- **Compliant escalation**: above the approval threshold, the action queues as
  `ACTION_PENDING` with a `pending` approval status and a notification is raised — a
  human must approve before execution.
- **Audit trail**: every `agent_orchestrated` entry records the LLM provider/model,
  recommended vs final action, policy allowed/violations, and the diagnosis. Every
  `recovery_predicted` entry records the served model version and probability.

## 4. Measured money (not aspirational)

`scripts/batch-experiment.ts` runs up to 500 synthetic Razorpay failures through the
**real production pipeline** and measures actual outcomes. Baselines run through the
**same seeded ground-truth simulator** — so the comparison is honest, never circular.

See `evidence/batch-report.json` (committed) for the latest 500-case run:
gross ₹16.0L recovered of ₹25.5L at risk (62.7%), net +₹3.01L vs retry-everything.
Re-running `demo:500` reproduces these numbers exactly (seeded cohort, stable
per-payment tx-ids, seeded outcome draws, pinned model artifact).

## 5. Deployment

- `docker-compose.yml`: `db` (Postgres 15) + `ml` (FastAPI) + `worker` (pg-boss) + `web`
  (Next.js standalone). Redis is **not** used — the queue is pg-boss on Postgres.
- `railway.toml`: single-managed-Postgres topology; web/worker/ml as separate services.
- Secrets: `ML_INTERNAL_TOKEN` (shared, ML fails closed without it), `NEXTAUTH_SECRET`,
  Razorpay keys (AES-256-GCM encrypted at rest), optional LLM keys.
