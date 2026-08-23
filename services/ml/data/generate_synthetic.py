"""
Synthetic Recovery Outcome Data Generator.

Every row represents a FAILED transaction that received a recovery
intervention. The label `recovered` is drawn from a realistic latent
process: category base recoverability, customer history, time decay,
retry fatigue, intervention effectiveness and amount effects.

This makes the learning target true RECOVERY PROBABILITY
(P(eventually_recovered | failed, intervened)), NOT "is it a failure".
"""

import numpy as np
import json
import random
from datetime import datetime, timezone

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

# Latent recoverability per category (drives the generative process)
CATEGORY_BASE_RECOVERY = {
    "insufficient_funds": 0.55,
    "bank_failure": 0.60,
    "auth_failure": 0.65,
    "expired_instrument": 0.35,
    "network_timeout": 0.70,
    "customer_cancellation": 0.15,
    "repeated_failure": 0.30,
    "payment_method_degradation": 0.45,
    "subscription_failure": 0.50,
    "unknown": 0.40,
}

PAYMENT_METHODS = ["card", "upi", "netbanking", "wallet"]

INTERVENTIONS = ["retry_later", "payment_method_recovery", "escalate_human"]
INTERVENTION_EFFECTIVENESS = {
    "retry_later": 1.00,
    "payment_method_recovery": 1.15,
    "escalate_human": 1.25,
}


def _logistic(x: float) -> float:
    return 1 / (1 + np.exp(-x))


def generate_row(rng: random.Random) -> dict:
    category = rng.choice(FAILURE_CATEGORIES)
    method = rng.choice(PAYMENT_METHODS)
    intervention = rng.choice(INTERVENTIONS)

    hist_rate = round(rng.uniform(0.05, 0.95), 2)          # customer success rate
    prev_failures = rng.randint(0, 5)
    hours_since = round(rng.uniform(0, 96), 1)
    hour_of_day = rng.randint(0, 23)
    retry_count = rng.randint(0, 3)
    is_subscription = rng.random() < 0.3
    merchant_rate = round(rng.uniform(0.2, 0.9), 2)
    cat_rate = round(
        CATEGORY_BASE_RECOVERY[category] + rng.uniform(-0.08, 0.08), 2
    )
    amount_percentile = round(rng.random(), 4)
    amount_paise = int(rng.uniform(100, 500000))

    # --- Latent recovery logit (ground-truth generative process) ---
    logit = (
        2.2 * CATEGORY_BASE_RECOVERY[category] - 0.8
        + 1.5 * (hist_rate - 0.5)
        - 0.18 * prev_failures
        - 0.012 * hours_since                      # time decay
        - 0.25 * retry_count                       # retry fatigue
        + 0.4 * is_subscription
        + 1.2 * (merchant_rate - 0.5)
        + 0.8 * (cat_rate - 0.5)
        - 0.6 * abs(amount_percentile - 0.5)       # extreme amounts harder
        + np.log(max(INTERVENTION_EFFECTIVENESS[intervention], 0.1))
        + rng.gauss(0, 0.35)                       # irreducible noise
    )
    p_recover = min(0.98, max(0.02, _logistic(logit)))
    recovered = int(rng.random() < p_recover)

    return {
        "case_id": f"case_{rng.randrange(10**8):08d}",
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
        "intervention": intervention,
        "recovered": recovered,   # LABEL: outcome of the intervention
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def main(num_samples: int = 12000, output_path: str = None) -> None:
    output_path = output_path or "services/ml/data/recovery_outcomes.jsonl"
    rng = random.Random(42)
    rows = [generate_row(rng) for _ in range(num_samples)]

    with open(output_path, "w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")

    n_rec = sum(r["recovered"] for r in rows)
    print(f"Generated {num_samples} failed-payment intervention records")
    print(f"  Recovered:     {n_rec} ({n_rec/num_samples*100:.1f}%)")
    print(f"  Not recovered: {num_samples-n_rec}")
    by_cat: dict = {}
    for r in rows:
        c = r["failure_category"]
        a, b = by_cat.get(c, (0, 0))
        by_cat[c] = (a + r["recovered"], b + 1)
    print("  Recovery rate by category:")
    for c, (a, b) in sorted(by_cat.items(), key=lambda kv: -kv[1][1]):
        print(f"    {c}: {a/b*100:.1f}% of {b}")
    print(f"  Output: {output_path}")


if __name__ == "__main__":
    import sys
    args = sys.argv[1:]
    n = int(args[0]) if args else 12000
    out = args[1] if len(args) > 1 else None
    main(n, out)
