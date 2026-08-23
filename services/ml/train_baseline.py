"""
Train Baseline Recovery Prediction Model
Trains the transparent logistic regression model on synthetic data
and evaluates on held-out test set.
"""

import json
import numpy as np
import os
from datetime import datetime
from typing import Any, Dict
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import (
    roc_auc_score,
    precision_recall_fscore_support,
    accuracy_score,
    confusion_matrix,
)
from sklearn.calibration import CalibratedClassifierCV
import numpy as onp

# Constants
TRAIN_SIZE = 0.8
RANDOM_STATE = 42
MODEL_OUTPUT = "services/ml/baseline_model.json"
METRICS_OUTPUT = "services/ml/metrics.json"


def load_synthetic_data(path: str = "services/ml/data/synthetic_transactions.json") -> tuple:
    """Load synthetic data and prepare features/labels."""
    X, y = [], []
    
    with open(path, 'r') as f:
        for line in f:
            record = json.loads(line.strip())
            
            # Skip if no failure category (success cases)
            if record["failure_category"] == "success":
                # For success, label = 0 (no recovery needed)
                y.append(0)
                # Build feature vector
                feat = build_feature_vector(record)
                X.append(feat)
            else:
                # Failure cases - label = 1 (needs recovery attempt)
                y.append(1)
                feat = build_feature_vector(record)
                X.append(feat)
    
    return np.array(X), np.array(y)


def build_feature_vector(record: Dict[str, Any]) -> list:
    """Build feature vector from a synthetic record."""
    return [
        np.log(max(record["amount"], 1)),  # amount_log
        {"insufficient_funds": 1, "bank_failure": 2, "auth_failure": 3,
         "expired_instrument": 4, "network_timeout": 5, "customer_cancellation": 6,
         "unknown": 7, "repeated_failure": 8, "payment_method_degradation": 9,
         "subscription_failure": 10}.get(record["failure_category"], 0),
        1 if record["payment_method"] == "card" else 0,  # payment_method_card
        record["historical_success_rate"],
        record["number_of_previous_failures"],
        record["time_since_failure_hours"] / 24,  # convert to days
        record["transaction_hour"] / 24,  # normalize
        record["retry_count"],
        1 if record["is_subscription"] else 0,  # is_subscription
        record["merchant_historical_rate"],
        record["failure_category_historical_rate"],
        record["amount_percentile"],
    ]


def train_model(
    data_path: str = "services/ml/data/synthetic_transactions.json",
    output_model: str = MODEL_OUTPUT,
    output_metrics: str = METRICS_OUTPUT,
) -> None:
    """Train the baseline logistic regression model."""
    
    print(f"Loading data from {data_path}...")
    X, y = load_synthetic_data(data_path)
    
    print(f"Dataset shape: {X.shape}")
    print(f"Positive class rate: {np.mean(y):.4f} ({np.sum(y)} positives out of {len(y)})")
    
    # Split into train/test
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=RANDOM_STATE, stratify=y
    )
    
    print(f"Train set: {len(X_train)} samples")
    print(f"Test set: {len(X_test)} samples")
    
    # Train logistic regression
    print("Training logistic regression model...")
    model = LogisticRegression(
        random_state=RANDOM_STATE,
        class_weight="balanced",  # Handle class imbalance
        max_iter=1000,
        solver="lbfgs",
    )
    
    model.fit(X_train, y_train)
    
    # Evaluate on test set
    print("Evaluating on test set...")
    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)[:, 1]
    
    # Calculate metrics
    accuracy = accuracy_score(y_test, y_pred)
    try:
        roc_auc = roc_auc_score(y_test, y_prob)
    except Exception as e:
        roc_auc = float("nan")
        print(f"Warning: Could not compute ROC-AUC: {e}")
    
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_test, y_pred, average="binary"
    )
    
    # Confusion matrix
    tn, fp, fn, tp = confusion_matrix(y_test, y_pred).ravel()
    
    # Expected business metrics
    # Assuming amount is available - for now use synthetic averages
    # Precision at different recall thresholds
    
    # Calibration: fit isotonic regression or Platt scaling
    # Using CalibratedClassifierCV for isotonic calibration
    print("Calibrating probabilities...")
    calibrator = CalibratedClassifierCV(
        estimator=model, method="isotonic", cv=5
    )
    calibrator.fit(X_train, y_train)
    
    # Calibrated probabilities on test set
    y_prob_calibrated = calibrator.predict_proba(X_test)[:, 1]
    calibrated_accuracy = accuracy_score(y_test, (y_prob_calibrated > 0.5).astype(int))
    
    # Store model and metrics
    model_data = {
        "model_version": "baseline-v1.0.0",
        "trained_at": datetime.utcnow().isoformat(),
        "features": [
            "amount_log",
            "failure_category_encoded",
            "payment_method_card",
            "historical_success_rate",
            "previous_failures",
            "time_since_failure_days",
            "transaction_hour_normalized",
            "retry_count",
            "is_subscription",
            "merchant_historical_rate",
            "failure_category_historical_rate",
            "amount_percentile",
        ],
        "model_type": "logistic_regression",
        "coefficients": model.coef_[0].tolist(),
        "intercept": float(model.intercept_[0]),
        "class_weights": model.class_weight,
        "calibrator": {
            "method": "isotonic",
            "trained": True,
        },
        "metrics": {
            "train_accuracy": accuracy,
            "test_accuracy": calibrated_accuracy,
            "test_roc_auc": round(roc_auc, 4) if not np.isnan(roc_auc) else None,
            "test_precision": round(precision, 4),
            "test_recall": round(recall, 4),
            "test_f1": round(f1, 4),
            "tn": int(tn),
            "fp": int(fp),
            "fn": int(fn),
            "tp": int(tp),
        },
    }
    
    # Write model
    with open(output_model, 'w') as f:
        json.dump(model_data, f, indent=2)
    
    # Write metrics
    num_samples = int(X.shape[0])
    metrics_data = {
        "model_version": "baseline-v1.0.0",
        "trained_at": datetime.utcnow().isoformat(),
        "dataset_size": num_samples,
        "train_test_split": {"train": int(len(X_train)), "test": int(len(X_test))},
        "metrics": {
            "accuracy": {
                "train": round(accuracy, 4),
                "test_calibrated": round(calibrated_accuracy, 4),
            },
            "roc_auc": {
                "test": round(roc_auc, 4) if not np.isnan(roc_auc) else None,
                "description": "Area under ROC curve - measures ranking quality"
            },
            "precision": {
                "test": round(precision, 4),
                "interpretation": "Of predicted recoveries, fraction that are actual recoveries"
            },
            "recall": {
                "test": round(recall, 4),
                "interpretation": "Of actual recoverable cases, fraction that are predicted"
            },
            "f1": {
                "test": round(f1, 4),
                "interpretation": "Harmonic mean of precision and recall"
            },
            "confusion_matrix": {
                "true_negatives": int(tn),
                "false_positives": int(fp),
                "false_negatives": int(fn),
                "true_positives": int(tp),
            },
        },
    }
    
    with open(output_metrics, 'w') as f:
        json.dump(metrics_data, f, indent=2)
    
    # Print summary
    print("\n" + "=" * 60)
    print("BASELINE MODEL TRAINING COMPLETE")
    print("=" * 60)
    print(f"\nTest Set Metrics:")
    print(f"  Accuracy (calibrated): {calibrated_accuracy:.4f}")
    print(f"  ROC-AUC: {roc_auc:.4f}" if not np.isnan(roc_auc) else "  ROC-AUC: N/A")
    print(f"  Precision: {precision:.4f}")
    print(f"  Recall: {recall:.4f}")
    print(f"  F1: {f1:.4f}")
    print(f"\nConfusion Matrix:")
    print(f"  True Positives: {tp} (correctly predicted recoverable)")
    print(f"  False Positives: {fp} (predicted recoverable but not)")
    print(f"  False Negatives: {fn} (recoverable but not predicted)")
    print(f"  True Negatives: {tn} (correctly predicted unrecoverable)")
    print(f"\nModel saved to: {output_model}")
    print(f"Metrics saved to: {output_metrics}")


if __name__ == "__main__":
    # Allow overriding data path and output locations
    data_path = None
    model_out = None
    metrics_out = None
    
    args = __import__("sys").argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--data" and i + 1 < len(args):
            data_path = args[i + 1]
            i += 2
        elif args[i] == "--model" and i + 1 < len(args):
            model_out = args[i + 1]
            i += 2
        elif args[i] == "--metrics" and i + 1 < len(args):
            metrics_out = args[i + 1]
            i += 2
        else:
            i += 1
    
    train_model(
        data_path or "services/ml/data/synthetic_transactions.json",
        model_out or MODEL_OUTPUT,
        metrics_out or METRICS_OUTPUT,
    )