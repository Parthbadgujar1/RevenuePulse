"""
Shared feature engineering for training AND serving.

This module is THE single source of truth for how a RecoveryFeatures
record becomes a model input vector. train_baseline.py and src/main.py
both import it, guaranteeing identical feature pipelines.
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
]

FEATURE_NAMES: List[str] = (
    NUMERIC_FEATURES
    + [f"category_{c}" for c in FAILURE_CATEGORIES]
    + [f"method_{m}" for m in PAYMENT_METHODS]
)


def build_feature_vector(record: Dict) -> List[float]:
    """Build the exact model input vector from a feature record/dict."""
    import math

    category = record["failure_category"]
    method = record["payment_method"]

    numeric = [
        math.log(max(record["amount"], 1)),                       # amount_log
        float(record["historical_success_rate"]),
        float(record["number_of_previous_failures"]),
        float(record["time_since_failure_hours"]) / 96.0,          # normalized days
        float(record["transaction_hour"]) / 23.0,
        float(record["retry_count"]),
        1.0 if record["is_subscription"] else 0.0,
        float(record["merchant_historical_rate"]),
        float(record["failure_category_historical_rate"]),
        float(record["amount_percentile"]),
    ]

    one_hot_cat = [1.0 if category == c else 0.0 for c in FAILURE_CATEGORIES]
    one_hot_method = [1.0 if method == m else 0.0 for m in PAYMENT_METHODS]

    return numeric + one_hot_cat + one_hot_method
