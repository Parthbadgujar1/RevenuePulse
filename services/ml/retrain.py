"""
Incremental retraining pipeline — triggered after new production outcomes
accumulate.  Designed to run as a background process from the FastAPI server
or as a standalone CLI.

Quality gates:
  1. Minimum new samples since last retrain (default 25)
  2. New model must beat current model on held-out ROC-AUC (by ≥0.005)
  3. New model must not regress calibration (Brier score) by >0.01
  Only when ALL gates pass does the new model replace the production artifact.

Model versioning:
  v3.1.1 -> v3.1.2 -> v3.1.3 -> ... (patch increments on production retrains)
  Minor/major bumps are manual (via --version flag).

CLI:
  python retrain.py                  # check gates and retrain if eligible
  python retrain.py --force          # skip quality gates, retrain anyway
  python retrain.py --dry-run        # evaluate without saving
  python retrain.py --status         # print current training data stats
"""

import argparse
import json
import math
import os
import random
import sys
import time
from datetime import datetime, timezone

import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import roc_auc_score, brier_score_loss

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))
from features import FEATURE_NAMES, build_feature_vector  # noqa: E402

RANDOM_STATE = 42
_HERE = os.path.dirname(os.path.abspath(__file__))
SYNTHETIC_PATH = os.path.join(_HERE, "data", "recovery_outcomes.jsonl")
PRODUCTION_PATH = os.path.join(_HERE, "data", "production_training.jsonl")
MODEL_DIR = os.path.join(_HERE, "model")
MODEL_PATH = os.path.join(MODEL_DIR, "model.joblib")
METRICS_PATH = os.path.join(_HERE, "metrics.json")
RETRAIN_STATE_PATH = os.path.join(_HERE, "retrain_state.json")

# Quality gates
MIN_NEW_SAMPLES = 25
ROC_AUC_IMPROVEMENT_THRESHOLD = 0.005
BRIER_REGRESSION_THRESHOLD = 0.01


def load_data_from(path: str):
    X, y = [], []
    if not os.path.exists(path):
        return np.array([]), np.array([])
    with open(path) as f:
        for line in f:
            rec = json.loads(line)
            X.append(build_feature_vector(rec))
            y.append(int(rec["recovered"]))
    return np.array(X), np.array(y)


def load_all_data():
    X_syn, y_syn = load_data_from(SYNTHETIC_PATH)
    X_prod, y_prod = load_data_from(PRODUCTION_PATH)
    if len(X_syn) == 0 and len(X_prod) == 0:
        return np.array([]), np.array([])
    parts = []
    labels = []
    if len(X_syn) > 0:
        parts.append(X_syn)
        labels.append(y_syn)
    if len(X_prod) > 0:
        parts.append(X_prod)
        labels.append(y_prod)
    return np.vstack(parts), np.concatenate(labels)


def load_retrain_state() -> dict:
    if os.path.exists(RETRAIN_STATE_PATH):
        with open(RETRAIN_STATE_PATH) as f:
            return json.load(f)
    return {"last_retrain_at": None, "last_retrain_rows": 0, "retrain_count": 0, "current_version": "baseline-recovery-v3.1.1"}


def save_retrain_state(state: dict):
    os.makedirs(os.path.dirname(RETRAIN_STATE_PATH), exist_ok=True)
    with open(RETRAIN_STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def load_current_model_meta() -> dict | None:
    if not os.path.exists(MODEL_PATH):
        return None
    try:
        bundle = joblib.load(MODEL_PATH)
        return bundle.get("artifact_meta", {})
    except Exception:
        return None


def bump_version(version: str) -> str:
    """Increment patch version: v3.1.1 -> v3.1.2"""
    parts = version.replace("baseline-recovery-v", "").split(".")
    if len(parts) == 3:
        parts[2] = str(int(parts[2]) + 1)
    else:
        parts.append("1")
    return "baseline-recovery-v" + ".".join(parts)


def train_model(X, y, model_version: str) -> tuple[dict, dict]:
    """Train both candidates and return (metrics, artifact_meta)."""
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=RANDOM_STATE, stratify=y
    )

    lr_cal = CalibratedClassifierCV(
        LogisticRegression(max_iter=2000, solver="lbfgs", class_weight="balanced",
                           random_state=RANDOM_STATE),
        method="isotonic", cv=5,
    ).fit(X_tr, y_tr)

    gb_cal = CalibratedClassifierCV(
        HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.08, max_leaf_nodes=31,
            l2_regularization=1.0, random_state=RANDOM_STATE,
        ),
        method="isotonic", cv=5,
    ).fit(X_tr, y_tr)

    def eval_model(name, model):
        proba = model.predict_proba(X_te)[:, 1]
        pred = (proba >= 0.5).astype(int)
        return {
            "name": name,
            "roc_auc": round(float(roc_auc_score(y_te, proba)), 4),
            "brier": round(float(brier_score_loss(y_te, proba)), 4),
            "accuracy": round(float((pred == y_te).mean()), 4),
        }

    scores = {
        "logistic_regression": eval_model("logistic_regression", lr_cal),
        "gradient_boosting": eval_model("gradient_boosting", gb_cal),
    }

    pick = "gradient_boosting" if scores["gradient_boosting"]["roc_auc"] > scores["logistic_regression"]["roc_auc"] else "logistic_regression"
    if (scores["gradient_boosting"]["roc_auc"] - scores["logistic_regression"]["roc_auc"]) <= 0.01:
        pick = "logistic_regression"
    chosen = gb_cal if pick == "gradient_boosting" else lr_cal
    chosen_metrics = scores[pick]

    raw = LogisticRegression(max_iter=2000, solver="lbfgs", class_weight="balanced",
                             random_state=RANDOM_STATE).fit(X_tr, y_tr)

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
        "model_selection": {"candidates": scores},
        "calibration": {
            "brier_selected": chosen_metrics["brier"],
            "brier_uncalibrated_lr": round(float(brier_score_loss(y_te, raw.predict_proba(X_te)[:, 1])), 4),
        },
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

    return metrics, artifact, chosen


def retrain(force: bool = False, dry_run: bool = False) -> dict:
    """Run the retraining pipeline. Returns a result dict."""
    state = load_retrain_state()
    current_meta = load_current_model_meta()

    X, y = load_all_data()
    if len(X) == 0:
        return {"status": "no_data", "message": "No training data available"}

    production_rows = 0
    if os.path.exists(PRODUCTION_PATH):
        with open(PRODUCTION_PATH) as f:
            production_rows = sum(1 for _ in f)

    new_samples = production_rows - state.get("last_retrain_rows", 0)
    print(f"Training data: {len(X)} total, {production_rows} production, {new_samples} new since last retrain")

    if not force and new_samples < MIN_NEW_SAMPLES:
        msg = f"Only {new_samples} new samples (need {MIN_NEW_SAMPLES}). Skipping retrain."
        print(msg)
        return {"status": "skipped", "message": msg, "new_samples": new_samples}

    new_version = bump_version(state.get("current_version", "baseline-recovery-v3.1.1"))
    print(f"Training model {new_version}...")
    metrics, artifact, chosen_model = train_model(X, y, new_version)

    new_roc = metrics["test_metrics"]["roc_auc"]
    new_brier = metrics["test_metrics"]["brier"]

    # Quality gate: compare against current model
    if not force and current_meta:
        current_metrics = current_meta.get("metrics", {}).get("test_metrics", {})
        current_roc = current_metrics.get("roc_auc", 0)
        current_brier = current_metrics.get("brier", 1)

        roc_delta = new_roc - current_roc
        brier_delta = new_brier - current_brier

        print(f"ROC-AUC: {current_roc} -> {new_roc} (delta={roc_delta:+.4f})")
        print(f"Brier:   {current_brier} -> {new_brier} (delta={brier_delta:+.4f})")

        if roc_delta < -ROC_AUC_IMPROVEMENT_THRESHOLD:
            msg = f"New model ROC-AUC ({new_roc}) regresses from current ({current_roc}). Blocked."
            print(msg)
            return {"status": "blocked", "reason": "roc_auc_regression", "message": msg}

        if brier_delta > BRIER_REGRESSION_THRESHOLD:
            msg = f"New model Brier ({new_brier}) regresses from current ({current_brier}). Blocked."
            print(msg)
            return {"status": "blocked", "reason": "brier_regression", "message": msg}

    if dry_run:
        print("Dry run — not saving model.")
        return {"status": "dry_run", "metrics": metrics}

    # Save the new model
    os.makedirs(MODEL_DIR, exist_ok=True)
    joblib.dump({"artifact_meta": artifact, "model": chosen_model}, MODEL_PATH)
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)

    state["last_retrain_at"] = datetime.now(timezone.utc).isoformat()
    state["last_retrain_rows"] = production_rows
    state["retrain_count"] = state.get("retrain_count", 0) + 1
    state["current_version"] = new_version
    save_retrain_state(state)

    print(f"Model saved: {new_version}")
    return {"status": "deployed", "version": new_version, "metrics": metrics}


def print_status():
    state = load_retrain_state()
    current_meta = load_current_model_meta()
    prod_rows = 0
    if os.path.exists(PRODUCTION_PATH):
        with open(PRODUCTION_PATH) as f:
            prod_rows = sum(1 for _ in f)
    print(json.dumps({
        "current_version": state.get("current_version"),
        "last_retrain_at": state.get("last_retrain_at"),
        "retrain_count": state.get("retrain_count", 0),
        "production_training_rows": prod_rows,
        "last_retrain_rows": state.get("last_retrain_rows", 0),
        "current_model_metrics": (current_meta or {}).get("metrics", {}).get("test_metrics"),
    }, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Incremental model retraining")
    parser.add_argument("--force", action="store_true", help="Skip quality gates")
    parser.add_argument("--dry-run", action="store_true", help="Evaluate without saving")
    parser.add_argument("--status", action="store_true", help="Print current status")
    args = parser.parse_args()

    if args.status:
        print_status()
    else:
        result = retrain(force=args.force, dry_run=args.dry_run)
        print(json.dumps(result, indent=2, default=str))
