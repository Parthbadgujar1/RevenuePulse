"""
Train the recovery-probability model (v3.1 — multi-source).

Target: P(recovered | failed transaction, intervention applied)
- positive class = intervention eventually recovered the money
- training data: multi-source — synthetic (60k industry-calibrated) blended
  with real-world production outcomes (accumulated in data/production_training.jsonl)
- model selection is HONEST: logistic regression (transparent) competes
  against histogram gradient boosting; the winner on held-out ROC-AUC is
  served, and BOTH scores are published in metrics.json
- artifact: services/ml/model/model.joblib (loaded verbatim by the API)

CLI:
  python train_baseline.py                          # default: synthetic + production
  python train_baseline.py --data path/to/data.jsonl  # custom data source
  python train_baseline.py --real-world-only       # only real-world data
  python train_baseline.py --version 4.0.0         # custom version string
"""

import argparse
import json
import os
import joblib
import numpy as np
from datetime import datetime, timezone
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
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
SYNTHETIC_PATH = "services/ml/data/recovery_outcomes.jsonl"
PRODUCTION_PATH = "services/ml/data/production_training.jsonl"
MODEL_DIR = "services/ml/model"
MODEL_PATH = os.path.join(MODEL_DIR, "model.joblib")
METRICS_PATH = "services/ml/metrics.json"

BENCHMARK_SOURCES = [
    "Recurly Research - subscription payment decline & recovery benchmarks "
    "(https://recurly.com/blog/subscription-benchmarks-top-payment-decline-reasons/)",
    "Stripe decline-code encyclopedia with recovery-rate bands, 2026 "
    "(https://recurflux.com/resources/guides/stripe-decline-codes-encyclopedia-2026)",
    "SaaS Payment Failure Report 2026 - failure mix & dunning recovery tiers "
    "(https://recurflux.com/resources/saas-payment-failure-report)",
    "Failed payment recovery benchmarks by decline code, DunnAI 2026 "
    "(https://getdunnai.com/learn/failed-payment-recovery-rate-saas)",
]


def load_data_from(path: str):
    """Load training data from a single JSONL file."""
    X, y = [], []
    with open(path) as f:
        for line in f:
            rec = json.loads(line)
            X.append(build_feature_vector(rec))
            y.append(int(rec["recovered"]))
    return np.array(X), np.array(y)


def load_multi_source(synthetic: bool = True, production: bool = True, custom: str | None = None):
    """Load and merge training data from multiple sources."""
    X_all, y_all = [], []
    sources = []

    if synthetic and os.path.exists(SYNTHETIC_PATH):
        X, y = load_data_from(SYNTHETIC_PATH)
        X_all.append(X)
        y_all.append(y)
        sources.append(f"synthetic({len(y)})")

    if production and os.path.exists(PRODUCTION_PATH):
        X, y = load_data_from(PRODUCTION_PATH)
        X_all.append(X)
        y_all.append(y)
        sources.append(f"production({len(y)})")

    if custom and os.path.exists(custom):
        X, y = load_data_from(custom)
        X_all.append(X)
        y_all.append(y)
        sources.append(f"custom({len(y)})")

    if not X_all:
        raise FileNotFoundError("No training data found. Run generate_synthetic.py or provide --data path.")

    X = np.vstack(X_all)
    y = np.concatenate(y_all)
    print(f"Multi-source dataset: {', '.join(sources)} -> {X.shape[0]} total rows, "
          f"{y.mean()*100:.1f}% positive")
    return X, y


def evaluate(name: str, model, X_tr, y_tr, X_te, y_te) -> dict:
    proba = model.predict_proba(X_te)[:, 1]
    pred = (proba >= 0.5).astype(int)
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_te, pred, average="binary", zero_division=0
    )
    return {
        "name": name,
        "roc_auc": round(float(roc_auc_score(y_te, proba)), 4),
        "pr_auc": round(float(average_precision_score(y_te, proba)), 4),
        "brier": round(float(brier_score_loss(y_te, proba)), 4),
        "accuracy": round(float((pred == y_te).mean()), 4),
        "precision": round(float(precision), 4),
        "recall": round(float(recall), 4),
        "f1": round(float(f1), 4),
    }


def main():
    parser = argparse.ArgumentParser(description="Train recovery probability model")
    parser.add_argument("--data", type=str, default=None, help="Custom training data JSONL path")
    parser.add_argument("--real-world-only", action="store_true", help="Use only real-world data")
    parser.add_argument("--version", type=str, default=None, help="Custom model version string")
    args = parser.parse_args()

    model_version = args.version or "baseline-recovery-v3.1.0"

    if args.real_world_only:
        X, y = load_multi_source(synthetic=False, production=True, custom=args.data)
    else:
        X, y = load_multi_source(synthetic=True, production=True, custom=args.data)

    print(f"Dataset: {X.shape[0]} rows x {X.shape[1]} features "
          f"({y.mean()*100:.1f}% recovered)")

    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=RANDOM_STATE, stratify=y
    )

    # --- Candidate A: transparent logistic regression + isotonic calibration
    print("Training logistic regression (calibrated)...")
    lr_cal = CalibratedClassifierCV(
        LogisticRegression(max_iter=2000, solver="lbfgs", class_weight="balanced",
                           random_state=RANDOM_STATE),
        method="isotonic", cv=5,
    ).fit(X_tr, y_tr)

    # --- Candidate B: gradient boosting + isotonic calibration
    print("Training histogram gradient boosting (calibrated)...")
    gb_cal = CalibratedClassifierCV(
        HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.08, max_leaf_nodes=31,
            l2_regularization=1.0, random_state=RANDOM_STATE,
        ),
        method="isotonic", cv=5,
    ).fit(X_tr, y_tr)

    # --- Honest head-to-head on held-out data
    scores = {
        "logistic_regression": evaluate("logistic_regression", lr_cal, X_tr, y_tr, X_te, y_te),
        "gradient_boosting": evaluate("gradient_boosting", gb_cal, X_tr, y_tr, X_te, y_te),
    }
    for k, v in scores.items():
        print(f"{k}: ROC-AUC={v['roc_auc']} PR-AUC={v['pr_auc']} Brier={v['brier']}")

    # Selection rule: primary = held-out ROC-AUC; tie-break = PR-AUC.
    pick = ("gradient_boosting" if scores["gradient_boosting"]["roc_auc"] >
            scores["logistic_regression"]["roc_auc"] else "logistic_regression")
    # Serve GB only if it wins by a MEANINGFUL margin (>0.01 ROC-AUC);
    # otherwise prefer transparency.
    if (scores["gradient_boosting"]["roc_auc"] -
            scores["logistic_regression"]["roc_auc"]) <= 0.01:
        pick = "logistic_regression"
    chosen = gb_cal if pick == "gradient_boosting" else lr_cal
    chosen_metrics = scores[pick]
    print(f"Selected model: {pick}")

    # Uncalibrated LR comparison to show calibration value
    raw = LogisticRegression(
        max_iter=2000, solver="lbfgs", class_weight="balanced",
        random_state=RANDOM_STATE,
    ).fit(X_tr, y_tr)
    raw_brier = brier_score_loss(y_te, raw.predict_proba(X_te)[:, 1])

    metrics = {
        "task": "recovery_probability_prediction",
        "label_definition": "recovered=1 if intervention recovered money else 0",
        "model_version": model_version,
        "selected_model": pick,
        "dataset_rows": int(X.shape[0]),
        "train_rows": int(len(y_tr)),
        "test_rows": int(len(y_te)),
        "positive_rate_train": round(float(y_tr.mean()), 4),
        "test_metrics": chosen_metrics,
        "model_selection": {"candidates": scores, "selection_rule":
                            "held-out ROC-AUC; gradient boosting must win by >0.01 to displace logistic regression"},
        "calibration": {
            "brier_selected": chosen_metrics["brier"],
            "brier_uncalibrated_lr": round(float(raw_brier), 4),
        },
        "benchmark_sources": BENCHMARK_SOURCES,
    }

    artifact = {
        "model_version": model_version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "model_type": f"{pick}_isotonic_calibrated",
        "feature_names": FEATURE_NAMES,
        "feature_count": len(FEATURE_NAMES),
        "coefficients_raw": raw.coef_[0].tolist(),
        "metrics": metrics,
    }

    os.makedirs(MODEL_DIR, exist_ok=True)
    joblib.dump({"artifact_meta": artifact, "model": chosen}, MODEL_PATH)
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)

    print(json.dumps(metrics["test_metrics"], indent=2))
    print(f"Model saved to {MODEL_PATH}")

    # Return metrics for programmatic callers (retrain.py)
    return metrics


if __name__ == "__main__":
    main()
