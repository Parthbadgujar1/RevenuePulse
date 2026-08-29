"""
Synthetic Recovery Outcome Data Generator — v4 (context-rich).

Every row represents a FAILED transaction that received a recovery
intervention. The label `recovered` is drawn from a latent generative
process grounded in published 2025-2026 dunning benchmarks AND, critically,
DEPENDS ON THE SAME FEATURES THE MODEL SEES at inference time:

  v4 additions (context awareness the v3 model could not exploit):
  - `intervention` is now a FEATURE (v3 dropped it from the vector, so the
    model averaged over interventions it could not observe)
  - `contact_channel`, `merchant_vertical`, `day_of_week`,
    `customer_tenure_days`, `plan_tier` add behavioral + segment context
  - intervention assignment is CATEGORY-AWARE (realistic ops routing, e.g.
    expired cards go to payment_method_recovery, timeouts to retry_later),
    so the model learns *which* action fits *which* context.

  Benchmarks (unchanged anchors):
    - Recurly: recovery windows 2-12 days, insufficient-funds recovery >45%
    - Stripe: insufficient_funds 55-70%, timeouts 70-85%, expired 35-55%
      WITH card-update outreach (<10% without), fraud/cancel 5-15%
    - Timing: retries best 8-11 AM local, midweek/payday

Target: P(eventually_recovered | failed, context, intervention).
"""

import json
import random
from datetime import datetime, timezone

import numpy as np

FAILURE_CATEGORIES = [
    "insufficient_funds",
    "bank_failure",
    "auth_failure",
    "expired_instrument",
    "network_timeout",
    "customer_cancellation",
    "repeated_failure",
    "payment_method_degradation",
    "subscription_failure",
    "unknown",
]

FAILURE_MIX = {
    "expired_instrument": 0.26,
    "insufficient_funds": 0.24,
    "bank_failure": 0.20,
    "auth_failure": 0.08,
    "network_timeout": 0.07,
    "customer_cancellation": 0.06,
    "repeated_failure": 0.04,
    "payment_method_degradation": 0.03,
    "subscription_failure": 0.015,
    "unknown": 0.005,
}

CATEGORY_BASE_RECOVERY = {
    "insufficient_funds": 0.50,
    "bank_failure": 0.45,
    "auth_failure": 0.42,
    "expired_instrument": 0.18,
    "network_timeout": 0.70,
    "customer_cancellation": 0.06,
    "repeated_failure": 0.25,
    "payment_method_degradation": 0.35,
    "subscription_failure": 0.50,
    "unknown": 0.40,
}

PAYMENT_METHODS = ["card", "upi", "netbanking", "wallet"]
METHOD_WEIGHTS = {"card": 0.52, "upi": 0.27, "netbanking": 0.12, "wallet": 0.09}

CONTACT_CHANNELS = ["email", "sms", "whatsapp", "phone", "none"]
CHANNEL_WEIGHTS = {"email": 0.35, "sms": 0.20, "whatsapp": 0.25, "phone": 0.10, "none": 0.10}

MERCHANT_VERTICALS = ["saas", "ecommerce", "b2b", "fintech", "other"]

INTERVENTIONS = [
    "retry_later",
    "timed_reminder",
    "checkout_recovery",
    "subscription_recovery",
    "payment_method_recovery",
    "human_escalation",
    "none",
]

# Realistic ops routing: for each failure category, which interventions are
# actually applied (weights). The model learns these conditional patterns.
INTERVENTION_ROUTING = {
    "insufficient_funds": {"timed_reminder": 0.40, "retry_later": 0.35, "human_escalation": 0.15, "none": 0.10},
    "bank_failure": {"retry_later": 0.55, "timed_reminder": 0.20, "human_escalation": 0.10, "none": 0.15},
    "auth_failure": {"retry_later": 0.45, "payment_method_recovery": 0.25, "checkout_recovery": 0.15, "none": 0.15},
    "expired_instrument": {"payment_method_recovery": 0.70, "timed_reminder": 0.15, "none": 0.15},
    "network_timeout": {"retry_later": 0.60, "timed_reminder": 0.15, "none": 0.25},
    "customer_cancellation": {"none": 0.60, "human_escalation": 0.25, "timed_reminder": 0.15},
    "repeated_failure": {"human_escalation": 0.35, "none": 0.30, "payment_method_recovery": 0.20, "timed_reminder": 0.15},
    "payment_method_degradation": {"payment_method_recovery": 0.55, "retry_later": 0.25, "none": 0.20},
    "subscription_failure": {"subscription_recovery": 0.45, "timed_reminder": 0.25, "retry_later": 0.15, "none": 0.15},
    "unknown": {"retry_later": 0.40, "none": 0.30, "timed_reminder": 0.15, "checkout_recovery": 0.15},
}

# Intervention effectiveness per category, mirrored from the shared lift table
# (packages/policies/src/intervention-lifts.ts) so training data, the demo
# simulator and the decision engine never diverge.
# Format: category -> intervention -> delta probability
INTERVENTION_EFFECT = {
    "insufficient_funds": {"retry_later": 0.10, "timed_reminder": 0.07, "human_escalation": 0.06, "checkout_recovery": 0.03, "subscription_recovery": 0.03, "payment_method_recovery": -0.02, "none": 0.0},
    "bank_failure": {"retry_later": 0.06, "timed_reminder": 0.01, "human_escalation": 0.06, "checkout_recovery": 0.04, "subscription_recovery": 0.03, "payment_method_recovery": -0.02, "none": 0.0},
    "auth_failure": {"retry_later": 0.06, "timed_reminder": 0.01, "human_escalation": 0.06, "checkout_recovery": 0.08, "subscription_recovery": 0.03, "payment_method_recovery": 0.08, "none": 0.0},
    "expired_instrument": {"retry_later": -0.18, "timed_reminder": 0.01, "human_escalation": 0.06, "checkout_recovery": 0.04, "subscription_recovery": 0.03, "payment_method_recovery": 0.24, "none": 0.0},
    "network_timeout": {"retry_later": 0.14, "timed_reminder": 0.01, "human_escalation": 0.06, "checkout_recovery": 0.04, "subscription_recovery": 0.03, "payment_method_recovery": -0.02, "none": 0.0},
    "customer_cancellation": {"retry_later": 0.0, "timed_reminder": 0.01, "human_escalation": -0.02, "checkout_recovery": 0.04, "subscription_recovery": 0.03, "payment_method_recovery": -0.02, "none": 0.0},
    "repeated_failure": {"retry_later": 0.0, "timed_reminder": 0.01, "human_escalation": 0.06, "checkout_recovery": 0.04, "subscription_recovery": 0.03, "payment_method_recovery": 0.10, "none": 0.0},
    "payment_method_degradation": {"retry_later": -0.18, "timed_reminder": 0.01, "human_escalation": 0.06, "checkout_recovery": 0.04, "subscription_recovery": 0.03, "payment_method_recovery": 0.16, "none": 0.0},
    "subscription_failure": {"retry_later": 0.0, "timed_reminder": 0.05, "human_escalation": 0.06, "checkout_recovery": 0.04, "subscription_recovery": 0.09, "payment_method_recovery": -0.02, "none": 0.0},
    "unknown": {"retry_later": 0.0, "timed_reminder": 0.01, "human_escalation": 0.06, "checkout_recovery": 0.04, "subscription_recovery": 0.03, "payment_method_recovery": -0.02, "none": 0.0},
}

# Channel effectiveness: richer channels drive better outcomes for human-touch
# interventions; fully passive "none" is cheapest but weakest on hard fails.
CHANNEL_EFFECT = {"email": 0.0, "sms": -0.02, "whatsapp": 0.03, "phone": 0.05, "none": -0.05}

VERTICAL_EFFECT = {"saas": 0.03, "ecommerce": 0.0, "b2b": 0.05, "fintech": -0.02, "other": 0.0}


def _logistic(x: float) -> float:
    return 1 / (1 + np.exp(-x))


def _pick(rng, keys, weights) -> str:
    return rng.choices(list(keys), weights=[weights[k] for k in keys], k=1)[0]


_CATEGORIES = list(FAILURE_MIX.keys())
_CATEGORY_P = [FAILURE_MIX[c] for c in _CATEGORIES]
_METHODS = list(METHOD_WEIGHTS.keys())
_METHOD_P = [METHOD_WEIGHTS[m] for m in _METHODS]
_CHANNELS = list(CHANNEL_WEIGHTS.keys())
_CHANNEL_P = [CHANNEL_WEIGHTS[c] for c in _CHANNELS]


def generate_row(rng: random.Random, amount_mult: float = 1.0) -> dict:
    category = rng.choices(_CATEGORIES, weights=_CATEGORY_P, k=1)[0]
    method = rng.choices(_METHODS, weights=_METHOD_P, k=1)[0]
    vertical = rng.choice(MERCHANT_VERTICALS)
    channel = rng.choices(_CHANNELS, weights=_CHANNEL_P, k=1)[0]

    # Category-aware intervention routing (the signal the model must learn).
    routing = INTERVENTION_ROUTING[category]
    intervention = _pick(rng, routing, routing)

    # Context: day of week (0=Mon..6=Sun), tenure, plan tier, hour.
    day_of_week = rng.randint(0, 6)
    tenure_days = round(min(1825.0, rng.lognormvariate(np.log(180), 1.1)), 1)
    plan_tier = rng.choices([0.0, 1.0, 2.0], weights=[0.4, 0.4, 0.2])[0]
    hour_of_day = rng.randint(0, 23)

    hist_rate = round(rng.uniform(0.05, 0.95), 2)
    prev_failures = rng.randint(0, 5)
    hours_since = round(min(720.0, rng.lognormvariate(np.log(48), 0.9)), 1)
    retry_count = rng.randint(0, 3)
    is_subscription = rng.random() < 0.35
    merchant_rate = round(rng.uniform(0.2, 0.9), 2)
    cat_rate = round(CATEGORY_BASE_RECOVERY[category] + rng.uniform(-0.08, 0.08), 2)
    amount_percentile = round(rng.random(), 4)
    amount_paise = int(
        min(20_000_000 * amount_mult, max(5_000, rng.lognormvariate(np.log(200_000 * amount_mult), 1.05)))
    )

    # --- Latent recovery logit (ground truth), using ALL model-visible context
    base = CATEGORY_BASE_RECOVERY[category]
    effect = INTERVENTION_EFFECT[category].get(intervention, 0.0)
    is_payday_morning = 8 <= hour_of_day <= 11 and day_of_week in (0, 1, 3, 4)
    logit = (
        np.log(base / (1 - base))                       # category anchor (low enough that context matters)
        + 1.5 * (hist_rate - 0.5)                       # customer health
        - 0.18 * (prev_failures - 2)                    # prior failures hurt
        - 0.010 * (hours_since - 48)                    # decay vs typical 2-day window
        - 0.25 * (retry_count - 1)                      # retry fatigue
        + 0.28 * is_subscription                        # subscriptions stickier
        + 1.2 * (merchant_rate - 0.5)
        + 0.8 * (cat_rate - base)
        - 0.6 * (abs(amount_percentile - 0.5) - 0.25)   # extreme tickets harder
        + (0.08 if is_payday_morning else -0.01)        # payday-morning window
        + 0.0015 * (np.log1p(tenure_days) - np.log1p(180))  # established accounts recover better
        + 0.15 * (plan_tier - 1.0)                      # premium plans get white-glove
        + 1.6 * effect                                  # intervention effectiveness (model-visible!)
        + VERTICAL_EFFECT[vertical] * 2.0
        + CHANNEL_EFFECT[channel] * 2.0
        + rng.gauss(0, 0.22)                            # irreducible noise (σ=0.22)
    )
    p_recover = max(0.01, min(0.99, _logistic(logit)))
    recovered = int(rng.random() < p_recover)

    return {
        "case_id": f"case_{rng.randrange(10**10):08d}",
        "amount": amount_paise,
        "failure_category": category,
        "payment_method": method,
        "historical_success_rate": hist_rate,
        "number_of_previous_failures": prev_failures,
        "time_since_failure_hours": hours_since,
        "transaction_hour": hour_of_day,
        "retry_count": retry_count,
        "is_subscription": is_subscription,
        "merchant_historical_rate": merchant_rate,
        "failure_category_historical_rate": max(0.01, min(0.99, cat_rate)),
        "amount_percentile": amount_percentile,
        "day_of_week": day_of_week,
        "customer_tenure_days": tenure_days,
        "plan_tier": plan_tier,
        "contact_channel": channel,
        "merchant_vertical": vertical,
        "intervention": intervention,
        "recovered": recovered,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def main(num_samples: int = 80000, output_path: str = None) -> None:
    output_path = output_path or "services/ml/data/recovery_outcomes.jsonl"
    rng = random.Random(42)
    rows = [generate_row(rng) for _ in range(num_samples)]

    with open(output_path, "w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")

    n_rec = sum(r["recovered"] for r in rows)
    print(f"Generated {num_samples} failed-payment intervention records (v4 context-rich)")
    print(f"  Recovered:     {n_rec} ({n_rec / num_samples * 100:.1f}%)")
    print(f"  Not recovered: {num_samples - n_rec}")

    by_cat: dict = {}
    for r in rows:
        c = r["failure_category"]
        a, b = by_cat.get(c, (0, 0))
        by_cat[c] = (a + r["recovered"], b + 1)
    print("  Volume share & recovery rate by category:")
    total = sum(b for _, b in by_cat.values())
    for c, (a, b) in sorted(by_cat.items(), key=lambda kv: -kv[1][1]):
        print(f"    {c}: {b / total * 100:.1f}% of volume, recovers {a / b * 100:.1f}%")

    print("  Intervention mix:")
    by_int: dict = {}
    for r in rows:
        k = r["intervention"]
        a, b = by_int.get(k, (0, 0))
        by_int[k] = (a + r["recovered"], b + 1)
    for k, (a, b) in sorted(by_int.items(), key=lambda kv: -kv[1][1]):
        print(f"    {k}: {(b / total) * 100:.1f}% of volume, recovers {a / b * 100:.1f}%")

    print(f"  Output: {output_path}")


if __name__ == "__main__":
    import sys

    args = sys.argv[1:]
    n = int(args[0]) if args else 80000
    out = args[1] if len(args) > 1 else None
    main(n, out)