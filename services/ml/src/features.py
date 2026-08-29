"""
Shared feature engineering for training AND serving.

This module is THE single source of truth for how a RecoveryFeatures
record becomes a model input vector. train_baseline.py, retrain.py,
src/main.py and drift.py all import it, guaranteeing identical feature
pipelines across training and production inference.

Feature families (v4 — context-aware):
  - Failure category (one-hot) — WHAT went wrong
  - Payment method (one-hot)  — HOW the attempt was made
  - Intervention (one-hot)    — WHICH recovery action was applied (v4: this
    was previously dropped, making the label unidentifiable per action)
  - Contact channel (one-hot) — HOW the customer was reached
  - Merchant vertical (one-hot)  — business segment context
  - Numeric context: amount, customer health, timing decay, retry fatigue,
    merchant/category base rates, day-of-week, account tenure, plan tier

Every downstream consumer (FastAPI schema, TS ml-client) maps to the exact
field names below; `build_feature_vector` uses defensive .get() defaults so
legacy records (production_training.jsonl without the new context keys)
load without breaking.
"""

from typing import Dict, List

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

PAYMENT_METHODS = ["card", "upi", "netbanking", "wallet"]

# Intervention catalog — mirrors the domain InterventionType values. "none"
# means no outreach was applied (baseline auto-recovery / do-nothing).
INTERVENTIONS = [
    "retry_later",
    "timed_reminder",
    "checkout_recovery",
    "subscription_recovery",
    "payment_method_recovery",
    "human_escalation",
    "none",
]

CONTACT_CHANNELS = ["email", "sms", "whatsapp", "phone", "none"]

MERCHANT_VERTICALS = ["saas", "ecommerce", "b2b", "fintech", "other"]

NUMERIC_FEATURES = [
    "amount_log",
    "historical_success_rate",
    "number_of_previous_failures",
    "time_since_failure_days",
    "transaction_hour_norm",
    "retry_count",
    "is_subscription",
    "merchant_historical_rate",
    "failure_category_historical_rate",
    "amount_percentile",
    "day_of_week_norm",
    "customer_tenure_days_log",
    "plan_tier_norm",
]

FEATURE_NAMES: List[str] = (
    NUMERIC_FEATURES
    + [f"category_{c}" for c in FAILURE_CATEGORIES]
    + [f"method_{m}" for m in PAYMENT_METHODS]
    + [f"intervention_{c}" for c in INTERVENTIONS]
    + [f"channel_{c}" for c in CONTACT_CHANNELS]
    + [f"vertical_{c}" for c in MERCHANT_VERTICALS]
)


def _get(record: Dict, key: str, default=None):
    """Read a record field with a safe default for legacy rows."""
    val = record.get(key)
    return default if val is None else val


def build_feature_vector(record: Dict) -> List[float]:
    """Build the exact model input vector from a feature record/dict.

    All categoricals use a defensive 'unknown'/'none' fallback so records
    that predate a feature still produce a valid vector.
    """
    import math

    category = _get(record, "failure_category", "unknown") or "unknown"
    method = _get(record, "payment_method", "unknown") or "unknown"
    intervention = _get(record, "intervention", "none") or "none"
    channel = _get(record, "contact_channel", "none") or "none"
    vertical = _get(record, "merchant_vertical", "other") or "other"

    try:
        amount_log = math.log(max(float(_get(record, "amount", 1)), 1))
    except (TypeError, ValueError):
        amount_log = math.log(1)

    def _f(key: str, default: float = 0.0) -> float:
        try:
            return float(_get(record, key, default))
        except (TypeError, ValueError):
            return default

    def _i(key: str, default: int = 0) -> int:
        try:
            return int(_get(record, key, default))
        except (TypeError, ValueError):
            return default

    # Time-since-failure normalized to "days" (training data stores hours).
    # Clamp to a sane window (max 30 days ~ 720h) to avoid outlier blowups.
    hours_since = max(0.0, _f("time_since_failure_hours", 0.0))
    time_since_failure_days = min(hours_since / 24.0, 30.0)

    # Day of week: 0=Mon .. 6=Sun, normalized to [0,1] (payday/weekend lift).
    day_of_week = _i("day_of_week", 2)  # default Wed (neutral)
    day_of_week_norm = min(max(day_of_week, 0), 6) / 6.0

    # Account tenure in days -> log1p normalized against a 5-year cap (~1825d).
    tenure_days = max(0.0, _f("customer_tenure_days", 365.0))
    tenure_log = math.log1p(min(tenure_days, 1825.0))
    tenure_norm_scale = math.log1p(1825.0)

    plan_tier = min(max(_f("plan_tier", 0.0), 0.0), 2.0)  # basic=0,standard=1,premium=2

    numeric = [
        amount_log,                                # amount_log
        _f("historical_success_rate", 0.5),        # customer health
        float(_i("number_of_previous_failures", 0)),
        time_since_failure_days,                   # time_since_failure_days
        min(max(_f("transaction_hour", 12.0), 0.0), 23.0) / 23.0,
        float(_i("retry_count", 0)),               # retry fatigue
        1.0 if _i("is_subscription", 0) == 1 else 0.0,
        _f("merchant_historical_rate", 0.5),
        _f("failure_category_historical_rate", 0.4),
        _f("amount_percentile", 0.5),
        day_of_week_norm,                          # day_of_week_norm
        tenure_log / tenure_norm_scale,            # customer_tenure_days_log
        plan_tier / 2.0,                           # plan_tier_norm
    ]

    one_hot_cat = [1.0 if category == c else 0.0 for c in FAILURE_CATEGORIES]
    one_hot_method = [1.0 if method == m else 0.0 for m in PAYMENT_METHODS]
    one_hot_int = [1.0 if intervention == c else 0.0 for c in INTERVENTIONS]
    one_hot_channel = [1.0 if channel == c else 0.0 for c in CONTACT_CHANNELS]
    one_hot_vertical = [1.0 if vertical == c else 0.0 for c in MERCHANT_VERTICALS]

    return numeric + one_hot_cat + one_hot_method + one_hot_int + one_hot_channel + one_hot_vertical