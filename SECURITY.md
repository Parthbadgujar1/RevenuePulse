# Security

This document records the security model of RevenuePulse, structured around
data-in-transit, at-rest encryption, authentication/authorization, tenant
isolation, and the financial-integrity guards that protect the recovery
pipeline.

## Authentication & authorization

- **Dashboard auth** is session-based. A demo account `owner@revenuepulse.dev`
  is provided for local evaluation; production uses authenticated merchant
  contexts.
- **RBAC** (`packages/auth`) defines permissions such as `actions:approve`.
  Route-level gates (`requirePermission`, `requireMerchantContext`) enforce
  them and map violations to `403 Forbidden`.
- **Internal services** (the ML service, metrics endpoints) require an internal
  bearer token. `services/ml` endpoints (`/predict`, `/health`, `/model-info`,
  `/drift`, retraining) are gated by `require_internal_token`.

## Webhook integrity

- **Signature verification** (`packages/providers`): incoming Razorpay webhooks
  are HMAC-verified against the merchant's webhook secret.
- **Durable idempotency**: every webhook event is registered by stable
  `providerEventId` before processing; replays are acknowledged as duplicates
  and never double-processed.
- **Loud failure**: a webhook that cannot be durably enqueued is marked `FAILED`
  and answered with a non-2xx so Razorpay redelivers — a silent 200 is never
  used to drop an event that should become a recovery outcome.

## Tenant isolation

- All merchant-scoped reads go through `requireMerchantContext()`;
  cross-tenant case ids and entities resolve to nothing (404).
- The anonymous demo tenant is a dev-only convenience and is disabled in
  production unless `RP_DEMO_FALLBACK=1` is explicitly set.

## Secrets & data protection

- **Razorpay key secrets** are validated against the live API at connect time
  and stored AES-256-GCM encrypted at rest (`keySecretEncrypted`,
  `webhookSecretEncrypted`); they are decrypted only in memory at call time.
- The legacy plaintext `webhookSecret` column has been dropped (migration
  hardening). No plaintext secret fallback is used.
- The ML model is served behind a bearer token; metrics are bearer-token gated.

## Financial-integrity guarantees

These prevent both over-claiming and double-spend:

- **Money actions are gated by policy** (`packages/policies` decision engine +
  `isInterventionAllowed`), which fail closed on missing/NaN probabilities and
  enforce retry, contact, case-lifetime, cooldown, declined/repeated-failure,
  and economics guardrails against the *real* model output and live context.
- **Authorized ≠ recovered**: only a captured payment is recorded as recovered.
- **No fabricated provider references**: live execution creates a real Razorpay
  payment link or honestly records the action without one.
- **Exactly-once execution**: recovery actions claim `PENDING → EXECUTING`
  atomically; concurrent workers cannot double-execute, and re-execution of an
  already-`EXECUTED` action is refused.
- **Outcome correlation**: live outcomes are resolved only from a real provider
  event or a Razorpay API poll correlated through the payment link — never from
  the original failed payment.

## Verifying provider signatures

```ts
import { verifyRazorpaySignature } from '@rp/providers';
const result = verifyRazorpaySignature(rawBody, signatureHeader);
// result.valid / result.simulated
```

In live mode the router tries the environment secret first, then every active
per-merchant connection secret until one validates, so multi-tenant
attribution is by matching secret.

## Reporting

Security defects should be reported privately rather than in public issues.
