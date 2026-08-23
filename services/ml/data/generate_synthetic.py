"""
Synthetic Data Generator for Baseline Model Training
Generates realistic transaction data with known recovery patterns.
"""

import numpy as np
import json
import random
from datetime import datetime, timedelta
from typing import List, Dict, Any


# Failure category mappings
FAILURE_CATEGORIES = [
    "insufficient_funds",
    "bank_failure",
    "auth_failure",
    "expired_instrument",
    "network_timeout",
    "customer_cancellation",
    "unknown",
    "repeated_failure",
    "payment_method_degradation",
    "subscription_failure",
]

PAYMENT_METHODS = ["card", "upi", "netbanking", "wallet"]


def random_amount(min_amount: int = 100, max_amount: int = 500000) -> int:
    """Generate random transaction amount in paise."""
    return random.randint(min_amount, max_amount)


def random_hour() -> int:
    """Generate random hour of day (0-23)."""
    return random.randint(0, 23)


def random_success_rate() -> float:
    """Generate random historical success rate (0-1)."""
    return round(random.uniform(0.1, 0.9), 2)


def main(
    num_samples: int = 10000,
    output_path: str = "services/ml/data/synthetic_transactions.json",
) -> None:
    """
    Generate synthetic transaction data for baseline model training.
    
    The data includes:
    - Successful payments (no recovery needed)
    - Failed transactions with various failure categories
    - Known recovery probabilities based on features
    
    Output format: JSONL (one JSON object per line)
    """
    
    records = []
    
    for i in range(num_samples):
        # Determine if this is a success or failure
        # 70% success rate baseline
        is_success = random.random() > 0.3
        
        amount = random_amount()
        failure_category = random.choice(FAILURE_CATEGORIES) if not is_success else "success"
        payment_method = random.choice(PAYMENT_METHODS)
        historical_success_rate = random_success_rate()
        number_of_previous_failures = random.randint(0, 5)
        time_since_failure_hours = random.uniform(0, 72) if not is_success else 0
        transaction_hour = random_hour()
        retry_count = random.randint(0, 3) if not is_success else 0
        is_subscription = random.random() > 0.7  # 30% subscription failures
        merchant_historical_rate = random_success_rate()
        failure_category_historical_rate = random_success_rate()
        amount_percentile = random.random()
        
        record = {
            "case_id": f"case_{i:06d}",
            "is_success": is_success,
            "amount": amount,
            "failure_category": failure_category,
            "payment_method": payment_method,
            "historical_success_rate": historical_success_rate,
            "number_of_previous_failures": number_of_previous_failures,
            "time_since_failure_hours": round(time_since_failure_hours, 1),
            "transaction_hour": transaction_hour,
            "retry_count": retry_count,
            "is_subscription": is_subscription,
            "merchant_historical_rate": merchant_historical_rate,
            "failure_category_historical_rate": failure_category_historical_rate,
            "amount_percentile": round(amount_percentile, 4),
            "generated_at": datetime.utcnow().isoformat(),
        }
        
        records.append(record)
    
    # Write as JSONL
    with open(output_path, 'w') as f:
        for record in records:
            f.write(json.dumps(record) + '\n')
    
    # Print summary
    success_count = sum(1 for r in records if r["is_success"])
    failure_count = num_samples - success_count
    categories_count: Dict[str, int] = {}
    for r in records:
        if not r["is_success"]:
            cat = r["failure_category"]
            categories_count[cat] = categories_count.get(cat, 0) + 1
    
    print(f"Generated {num_samples} synthetic transaction records")
    print(f"  Successes: {success_count} ({success_count/num_samples*100:.1f}%)")
    print(f"  Failures: {failure_count} ({failure_count/num_samples*100:.1f}%)")
    print(f"  Failure categories:")
    for cat, count in sorted(categories_count.items(), key=lambda x: -x[1]):
        print(f"    {cat}: {count} ({count/failure_count*100:.1f}%)")
    print(f"  Output: {output_path}")


if __name__ == "__main__":
    import sys
    args = sys.argv[1:]
    n = int(args[0]) if args else 10000
    out = args[1] if len(args) > 1 else "services/ml/data/synthetic_transactions.json"
    main(n, out)