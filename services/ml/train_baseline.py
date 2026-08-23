"""
Train the baseline recovery-probability model.

Target: P(recovered | failed transaction, intervention applied)
- positive class = intervention eventually recovered the money
- model: logistic regression + isotonic calibration (transparent baseline)
- artifact: services/ml/model/model.joblib (loaded verbatim by the API)
"""

import json
import os
import joblib
import numpy as np
from datetime import datetime, timezone
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import (
    roc_auc_score,
    average_precision_score,
    brier_score_loss,
    precision_recall_fscore_support,
)

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))
from features import FEATURE_NAMES, build_feature_vector  # noqa: E402

RANDOM_STATE = 42
DATA_PATH = "services/ml/data/recovery_outcomes.jsonl"
MODEL_DIR = "services/ml/model"
MODEL_PATH = os.path.join(MODEL_DIR, "model.joblib")
METRICS_PATH = "services/ml/metrics.json"


def load_data(path=DATA_PATH):
    X, y = [], []
    with open(path) as f:
        for line in f:
            rec = json.loads(line)
            X.append(build_feature_vector(rec))
            y.append(int(rec["recovered"]))
    return np.array(X), np.array(y)


def main():
    X, y = load_data()
    print(f"Dataset: {X.shape[0]} rows x {X.shape[1]} features "
          f"({y.mean()*100:.1f}% recovered)")

    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=RANDOM_STATE, stratify=y
    )

    base = LogisticRegression(
        max_iter=2000, solver="lbfgs", class_weight="balanced",
        random_state=RANDOM_STATE,
    )
    print("Training logistic regression...")
    calibrated = CalibratedClassifierCV(base, method="isotonic", cv=5)
    calibrated.fit(X_tr, y_tr)

    # --- Held-out evaluation ---
    proba = calibrated.predict_proba(X_te)[:, 1]
    pred = (proba >= 0.5).astype(int)
    roc = roc_auc_score(y_te, proba)
    pr = average_precision_score(y_te, proba)
    brier = brier_score_loss(y_te, proba)
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_te, pred, average="binary", zero_division=0
    )
    acc = float((pred == y_te).mean())

    # Uncalibrated comparison to show calibration value
    raw = LogisticRegression(
        max_iter=2000, solver="lbfgs", class_weight="balanced",
        random_state=RANDOM_STATE,
    ).fit(X_tr, y_tr)
    raw_brier = brier_score_loss(y_te, raw.predict_proba(X_te)[:, 1])

    metrics = {
        "task": "recovery_probability_prediction",
        "label_definition": "recovered=1 if intervention recovered money else 0",
        "dataset_rows": int(X.shape[0]),
        "train_rows": int(len(y_tr)),
        "test_rows": int(len(y_te)),
        "positive_rate_train": round(float(y_tr.mean()), 4),
        "test_metrics": {
            "roc_auc": round(float(roc), 4),
            "pr_auc": round(float(pr), 4),
            "precision": round(float(precision), 4),
            "recall": round(float(recall), 4),
            "f1": round(float(f1), 4),
            "accuracy": round(acc, 4),
            "brier_calibrated": round(float(brier), 4),
            "brier_uncalibrated": round(float(raw_brier), 4),
        },
    }

    artifact = {
        "model_version": "baseline-recovery-v2.0.0",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "model_type": "logistic_regression_isotonic_calibrated",
        "feature_names": FEATURE_NAMES,
        "feature_count": len(FEATURE_NAMES),
        "coefficients_raw": raw.coef_[0].tolist(),
        "metrics": metrics,
    }

    os.makedirs(MODEL_DIR, exist_ok=True)
    joblib.dump({"artifact_meta": artifact, "model": calibrated}, MODEL_PATH)
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)

    print(json.dumps(metrics["test_metrics"], indent=2))
    print(f"Model saved to {MODEL_PATH}")


if __name__ == "__main__":
    main()
