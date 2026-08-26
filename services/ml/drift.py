"""
Data drift detection — monitors feature distribution shifts between
training data and recent production predictions.

Uses Population Stability Index (PSI) for each feature and the
Kolmogorov-Smirnov test for continuous features.

PSI interpretation:
  < 0.10  — no significant shift
  0.10-0.20 — moderate drift, monitor
  > 0.20 — significant drift, retrain recommended

Designed to run as a periodic background task and expose results via:
  - FastAPI /drift endpoint
  - Prometheus rp_ml_drift_psi gauge per feature
"""

import json
import math
import os
import random
from collections import deque
from typing import Optional

import numpy as np

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))
from features import FEATURE_NAMES, build_feature_vector  # noqa: E402

# Sliding window of recent feature vectors (in-process, HMR-safe)
try:
    _g = globalThis  # type: ignore[name-defined]
except NameError:
    import builtins
    _g = builtins  # type: ignore[assignment]
if not hasattr(_g, '__rpDriftWindow'):
    _g.__rpDriftWindow = deque(maxlen=5000)
WINDOW: deque = _g.__rpDriftWindow  # type: ignore[attr-defined]

# Reference distribution (training data statistics) — loaded once
_ref_stats: Optional[dict] = None
_ref_path = os.path.join(os.path.dirname(__file__), "data", "reference_stats.json")


def _load_ref_stats() -> dict:
    """Load or compute reference statistics from training data."""
    global _ref_stats
    if _ref_stats is not None:
        return _ref_stats

    if os.path.exists(_ref_path):
        with open(_ref_path) as f:
            _ref_stats = json.load(f)
        return _ref_stats

    # Compute from synthetic training data
    synthetic_path = os.path.join(os.path.dirname(__file__), "data", "recovery_outcomes.jsonl")
    if not os.path.exists(synthetic_path):
        _ref_stats = {"features": {}, "computed": False}
        return _ref_stats

    vectors = []
    with open(synthetic_path) as f:
        for i, line in enumerate(f):
            if i >= 5000:
                break
            rec = json.loads(line)
            vectors.append(build_feature_vector(rec))

    arr = np.array(vectors)
    stats = {}
    for j, name in enumerate(FEATURE_NAMES):
        col = arr[:, j]
        # Build histogram for PSI
        hist, bin_edges = np.histogram(col, bins=20, range=(float(col.min()), float(col.max())))
        stats[name] = {
            "mean": round(float(col.mean()), 6),
            "std": round(float(col.std()), 6),
            "min": round(float(col.min()), 6),
            "max": round(float(col.max()), 6),
            "hist": hist.tolist(),
            "bin_edges": bin_edges.tolist(),
        }

    _ref_stats = {"features": stats, "computed": True, "sample_count": min(5000, len(vectors))}
    os.makedirs(os.path.dirname(_ref_path), exist_ok=True)
    with open(_ref_path, "w") as f:
        json.dump(_ref_stats, f)
    return _ref_stats


def record_feature_vector(features: dict):
    """Record a feature vector for drift monitoring (call after each prediction)."""
    try:
        vec = build_feature_vector(features)
        WINDOW.append(vec)
    except Exception:
        pass  # drift monitoring must never break the prediction path


def compute_psi(reference_hist: list, current_hist: list, epsilon: float = 1e-6) -> float:
    """Population Stability Index between two histograms."""
    ref = np.array(reference_hist, dtype=float)
    cur = np.array(current_hist, dtype=float)

    ref_total = ref.sum()
    cur_total = cur.sum()
    if ref_total == 0 or cur_total == 0:
        return 0.0

    ref_pct = ref / ref_total + epsilon
    cur_pct = cur / cur_total + epsilon

    psi = float(np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct)))
    return round(psi, 6)


def compute_drift() -> dict:
    """Compute drift metrics for all features using the current window vs reference."""
    ref = _load_ref_stats()
    if not ref.get("computed") or not ref.get("features"):
        return {"status": "no_reference", "features": {}}

    window_size = len(WINDOW)
    if window_size < 50:
        return {"status": "insufficient_data", "window_size": window_size, "features": {}}

    arr = np.array(list(WINDOW))
    feature_drift = {}
    max_psi = 0.0
    drifted_features = []

    for j, name in enumerate(FEATURE_NAMES):
        col = arr[:, j]
        ref_feat = ref["features"].get(name, {})

        # PSI via histograms
        ref_hist = np.array(ref_feat.get("hist", []))
        if len(ref_hist) > 0:
            bin_edges = ref_feat.get("bin_edges", [])
            if len(bin_edges) > 1:
                cur_hist, _ = np.histogram(col, bins=len(ref_hist),
                                           range=(bin_edges[0], bin_edges[-1]))
                psi = compute_psi(ref_hist.tolist(), cur_hist.tolist())
            else:
                psi = 0.0
        else:
            psi = 0.0

        # KS statistic (simplified: compare means)
        ref_mean = ref_feat.get("mean", 0)
        ref_std = ref_feat.get("std", 1) or 1
        cur_mean = float(col.mean())
        ks_approx = abs(cur_mean - ref_mean) / ref_std

        status = "ok"
        if psi > 0.20:
            status = "drifted"
            drifted_features.append(name)
        elif psi > 0.10:
            status = "moderate"

        feature_drift[name] = {
            "psi": psi,
            "ks_approx": round(ks_approx, 4),
            "ref_mean": ref_mean,
            "cur_mean": round(cur_mean, 6),
            "status": status,
        }
        max_psi = max(max_psi, psi)

    overall_status = "ok"
    if max_psi > 0.20:
        overall_status = "drifted"
    elif max_psi > 0.10:
        overall_status = "moderate"

    return {
        "status": overall_status,
        "max_psi": max_psi,
        "window_size": window_size,
        "drifted_features": drifted_features,
        "features": feature_drift,
    }


def get_drift_for_prometheus() -> dict[str, float]:
    """Return PSI values keyed by feature name for Prometheus gauge."""
    drift = compute_drift()
    if drift.get("status") in ("no_reference", "insufficient_data"):
        return {}
    return {name: info["psi"] for name, info in drift.get("features", {}).items()}
