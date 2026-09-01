"""
Convert a synthetic (industry-calibrated) payment sample CSV to the JSONL
training format used by train_baseline.py.

The input CSV is a GENERATED sample (synthetic_payment_sample_500.csv), not real
production data — @example.com emails, sequential pay_xxxx ids, and benchmark-
calibrated failure mixes. It is used to bootstrap/prototype the feature
pipeline; production retraining instead accumulates real verified outcomes in
data/production_training.jsonl (gitignored, regenerated from the live pipeline).

The CSV contains raw transaction data (status, method, amount, error_code, etc.).
This script:
  1. Maps Razorpay error_codes → model failure_categories
  2. Computes per-user historical features from the dataset
  3. Draws probabilistic recovery labels for failed records using
     category base rates (grounded in industry benchmarks)
  4. Outputs recovery_outcomes.jsonl compatible with the feature pipeline

Captured payments are included as recovered=1 (the money came in).
Failed payments get labels drawn from their category's base recovery rate,
giving the model realistic signal about what kinds of failures are recoverable.
"""

import csv
import json
import math
import random
import sys
from collections import defaultdict
from datetime import datetime, timezone

# ── Error code → failure category mapping ────────────────────────────────────
ERROR_CODE_TO_CATEGORY = {
    "AUTH_FAILURE": "auth_failure",
    "INVALID_CVV": "auth_failure",
    "INVALID_DETAILS": "auth_failure",
    "CARD_EXPIRED": "expired_instrument",
    "UPI_COLLECT_EXPIRED": "expired_instrument",
    "INSUFFICIENT_FUNDS": "insufficient_funds",
    "NETWORK_TIMEOUT": "network_timeout",
    "SERVICE_UNAVAILABLE": "network_timeout",
    "BANK_DECLINED": "bank_failure",
    "GATEWAY_ERROR": "bank_failure",
    "FRAUD_SUSPECTED": "customer_cancellation",
    "ACCOUNT_BLOCKED": "customer_cancellation",
    "CUSTOMER_CANCELLED": "customer_cancellation",
    "REPEATED_FAILURE": "repeated_failure",
    "LIMIT_EXCEEDED": "unknown",
    "DUPLICATE_PAYMENT": "unknown",
}

# Category base recovery rates (from generate_synthetic.py — industry-calibrated)
CATEGORY_BASE_RECOVERY = {
    "insufficient_funds": 0.62,
    "bank_failure": 0.52,
    "auth_failure": 0.48,
    "expired_instrument": 0.42,
    "network_timeout": 0.78,
    "customer_cancellation": 0.08,
    "repeated_failure": 0.30,
    "payment_method_degradation": 0.46,
    "subscription_failure": 0.58,
    "unknown": 0.45,
}


def convert(csv_path: str, output_path: str, seed: int = 42) -> dict:
    """Convert a payment CSV to recovery_outcomes.jsonl."""
    rng = random.Random(seed)

    rows = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)

    if not rows:
        print("No rows found in CSV")
        return {}

    # ── Per-user feature computation ─────────────────────────────────────────
    user_attempts: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        email = row.get("email", "").strip().lower()
        if email:
            user_attempts[email].append(row)

    # Per-user: count prior failures, success rate
    user_prior_failures: dict[str, int] = {}
    user_success_rate: dict[str, float] = {}
    for email, user_rows in user_attempts.items():
        sorted_rows = sorted(user_rows, key=lambda r: r.get("created_at", ""))
        prior_fails = 0
        total = 0
        captured = 0
        for i, r in enumerate(sorted_rows):
            user_prior_failures[(email, r.get("created_at", ""))] = prior_fails
            total += 1
            if r["status"] == "captured":
                captured += 1
            else:
                prior_fails += 1
        user_success_rate[email] = captured / max(1, total)

    # ── Global stats for amount_percentile ────────────────────────────────────
    all_amounts = sorted(float(r["amount"]) for r in rows)
    n_amounts = len(all_amounts)

    # Overall capture rate (merchant_historical_rate proxy)
    total_captured = sum(1 for r in rows if r["status"] == "captured")
    overall_capture_rate = total_captured / len(rows)

    # Per-category recovery rates from captured/total
    cat_stats: dict[str, tuple[int, int]] = defaultdict(lambda: [0, 0])
    for r in rows:
        error_code = r.get("error_code", "").strip()
        category = ERROR_CODE_TO_CATEGORY.get(error_code, "unknown")
        cat_stats[category][1] += 1
        if r["status"] == "captured":
            cat_stats[category][0] += 1

    # ── Convert each row ──────────────────────────────────────────────────────
    output_rows = []
    for row in rows:
        status = row["status"]
        error_code = row.get("error_code", "").strip()
        amount_inr = float(row["amount"])
        amount_paise = int(round(amount_inr * 100))
        method = row.get("method", "card").strip().lower()
        if method not in ("card", "upi", "netbanking", "wallet"):
            method = "card"

        # Map error code to failure category
        category = ERROR_CODE_TO_CATEGORY.get(error_code, "unknown")

        # Parse created_at for transaction hour
        created_at_str = row.get("created_at", "")
        try:
            created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
            tx_hour = created_at.hour
        except (ValueError, AttributeError):
            tx_hour = 12  # default noon

        # Per-user features
        email = row.get("email", "").strip().lower()
        user_key = (email, created_at_str)
        prior_failures = user_prior_failures.get(user_key, 0)
        hist_success_rate = user_success_rate.get(email, overall_capture_rate)

        # Amount percentile (rank-based)
        # Binary search for position
        lo, hi = 0, n_amounts - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if all_amounts[mid] < amount_inr:
                lo = mid + 1
            else:
                hi = mid
        amount_percentile = round(lo / max(1, n_amounts - 1), 4)

        # Category historical rate
        cat_captured, cat_total = cat_stats.get(category, (0, 0))
        cat_rate = round(cat_captured / max(1, cat_total), 4)

        # For captured payments: label = 1 (recovered)
        # For failed payments: draw from category base recovery rate
        if status == "captured":
            recovered = 1
        else:
            base_rate = CATEGORY_BASE_RECOVERY.get(category, 0.45)
            recovered = int(rng.random() < base_rate)

        record = {
            "case_id": f"synthetic_{row.get('payment_id', 'unknown')}",
            "amount": amount_paise,
            "failure_category": category,
            "payment_method": method,
            "historical_success_rate": round(hist_success_rate, 4),
            "number_of_previous_failures": prior_failures,
            "time_since_failure_hours": 0.0 if status == "captured" else 1.0,
            "transaction_hour": tx_hour,
            "retry_count": 0,
            "is_subscription": False,
            "merchant_historical_rate": round(overall_capture_rate, 4),
            "failure_category_historical_rate": max(0.01, min(0.99, cat_rate)),
            "amount_percentile": amount_percentile,
            "intervention": "retry_later" if status == "failed" else "none",
            "recovered": recovered,
            "source": "synthetic_payment_sample_500",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        output_rows.append(record)

    with open(output_path, "w") as f:
        for rec in output_rows:
            f.write(json.dumps(rec) + "\n")

    # Stats
    n_rec = sum(r["recovered"] for r in output_rows)
    n_failed = sum(1 for r in output_rows if r["recovered"] == 0)
    by_cat: dict = {}
    for r in output_rows:
        c = r["failure_category"]
        a, b = by_cat.get(c, (0, 0))
        by_cat[c] = (a + r["recovered"], b + 1)

    print(f"Converted {len(rows)} CSV rows -> {len(output_rows)} training records")
    print(f"  Recovered:     {n_rec} ({n_rec/len(output_rows)*100:.1f}%)")
    print(f"  Not recovered: {len(output_rows) - n_rec}")
    print("  Volume share & recovery rate by category:")
    total = sum(b for _, b in by_cat.values())
    for c, (a, b) in sorted(by_cat.items(), key=lambda kv: -kv[1][1]):
        print(f"    {c}: {b/total*100:.1f}% of volume, recovers {a/b*100:.1f}%")
    print(f"  Output: {output_path}")

    return {
        "total_rows": len(output_rows),
        "recovered": n_rec,
        "not_recovered": len(output_rows) - n_rec,
    }


if __name__ == "__main__":
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "services/ml/data/synthetic_payment_sample_500.csv"
    output_path = sys.argv[2] if len(sys.argv) > 2 else "services/ml/data/synthetic_training.jsonl"
    convert(csv_path, output_path)
