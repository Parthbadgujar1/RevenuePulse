"""
RevenuePulse Recovery Prediction API.

Serves the EXACT artifact produced by train_baseline.py
(services/ml/model/model.joblib). No hand-tuned weights - if the model
file is missing the service refuses to predict.

Endpoints:
  POST /predict          — recovery probability prediction
  GET  /health           — model load status
  GET  /model-info       — model metadata, metrics, limitations
  GET  /drift            — data drift report (PSI per feature)
  POST /retrain          — trigger incremental retrain (background)
  POST /log-training-data — record a training example from production outcome
  GET  /retrain-status   — retraining pipeline status
"""

import os
import uuid
import warnings
from typing import Any, Dict, List, Optional

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends, Header
from pydantic import BaseModel, Field

import sys
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from features import FEATURE_NAMES, FAILURE_CATEGORIES, PAYMENT_METHODS, build_feature_vector  # noqa: E402

warnings.filterwarnings("ignore")

MODEL_PATH = os.environ.get(
    "RECOVERY_MODEL_PATH",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "model", "model.joblib"),
)

# Comma-separated internal tokens sent by the worker on admin endpoints.
# When unset, admin endpoints fail CLOSED (401) so a deploy without the
# secret cannot silently expose retrain/logging to the public internet.
ADMIN_TOKENS = [
    t.strip()
    for t in os.environ.get(
        "ML_INTERNAL_TOKEN",
        os.environ.get("RP_ML_TOKEN", ""),
    ).split(",")
    if t.strip()
]


def require_internal_token(authorization: str = Header(default="")) -> None:
    """Reject admin calls that do not present an internal Bearer token."""
    if not ADMIN_TOKENS:
        raise HTTPException(
            status_code=503,
            detail=(
                "ML_INTERNAL_TOKEN is not configured on this instance; "
                "admin endpoints are unavailable."
            ),
        )
    token = (authorization or "").removeprefix("Bearer ").strip()
    if token not in ADMIN_TOKENS:
        raise HTTPException(status_code=401, detail="Invalid or missing internal token")


app = FastAPI(
    title="RevenuePulse Recovery Prediction API",
    description="Recovery probability for failed payments (calibrated logistic regression, v4 context-aware)",
    version="4.0.0",
)


class RecoveryFeatures(BaseModel):
    amount: float = Field(..., description="Transaction amount in paise")
    failure_category: str
    payment_method: str
    historical_success_rate: float = Field(..., ge=0, le=1)
    number_of_previous_failures: int = Field(..., ge=0)
    time_since_failure_hours: float = Field(..., ge=0)
    transaction_hour: int = Field(..., ge=0, le=23)
    retry_count: int = Field(..., ge=0)
    is_subscription: bool
    merchant_historical_rate: float = Field(..., ge=0, le=1)
    failure_category_historical_rate: float = Field(..., ge=0, le=1)
    amount_percentile: float = Field(..., ge=0, le=1)
    # v4 context-aware features (all optional with safe defaults so legacy
    # callers and pre-v4 models keep working).
    intervention: str = Field(default="none", description="Recovery intervention applied")
    contact_channel: str = Field(default="none", description="Outreach channel used")
    merchant_vertical: str = Field(default="other", description="Merchant business vertical")
    day_of_week: int = Field(default=2, ge=0, le=6, description="0=Mon .. 6=Sun")
    customer_tenure_days: float = Field(default=365, ge=0, description="Account age in days")
    plan_tier: float = Field(default=0, ge=0, le=2, description="0=basic,1=standard,2=premium")


class PredictionRequest(BaseModel):
    features: RecoveryFeatures
    case_id: Optional[str] = None
    model_version: Optional[str] = None


class PredictionResponse(BaseModel):
    case_id: str
    probability: float
    expected_recovery_value: int
    confidence: float
    model_version: str
    feature_contributions: Dict[str, float]
    feature_snapshot: Dict[str, Any]


_model = None
_meta = None


def load_model():
    """Load the trained artifact once. Raises a clear error if absent."""
    global _model, _meta
    if _model is not None:
        return
    if not os.path.exists(MODEL_PATH):
        raise HTTPException(
            status_code=503,
            detail=(
                "Model artifact not found. Run `python services/ml/train_baseline.py` "
                "to produce services/ml/model/model.joblib before serving."
            ),
        )
    bundle = joblib.load(MODEL_PATH)
    _meta = bundle["artifact_meta"]
    _model = bundle["model"]


@app.post("/predict", response_model=PredictionResponse)
async def predict(request: PredictionRequest):
    load_model()

    f = request.features.model_dump()
    vec = np.array([build_feature_vector(f)])
    proba = float(_model.predict_proba(vec)[0][1])
    probability = min(0.99, max(0.01, proba))

    expected_value = int(round(f["amount"] * probability))

    # Linear contributions for transparency (coef x value per feature).
    # For the isotonic-calibrated ensemble we explain with the raw linear
    # coefficients stored in artifact_meta, rescaled to the final logit.
    try:
        coefs = np.asarray(_meta["coefficients_raw"])
        raw_logit_contribution = coefs * vec[0]
        pairs = sorted(
            zip(FEATURE_NAMES, raw_logit_contribution),
            key=lambda kv: abs(kv[1]),
            reverse=True,
        )[:8]
        contributions = {k: round(float(v), 4) for k, v in pairs}
    except Exception:
        contributions = {}

    # Record features for drift monitoring
    try:
        from drift import record_feature_vector
        record_feature_vector(f)
    except ImportError:
        pass

    # Confidence = calibrated model's own margin: max(p, 1-p) in [0.5, 1].
    # (The old formula peaked AT p=0.5, which rewarded maximum uncertainty.)
    confidence = max(proba, 1.0 - proba)

    return PredictionResponse(
        case_id=request.case_id or f"case_{uuid.uuid4().hex[:8]}",
        probability=round(probability, 4),
        expected_recovery_value=expected_value,
        confidence=round(confidence, 4),
        model_version=_meta["model_version"],
        feature_contributions=contributions,
        feature_snapshot={
            k: f[k]
            for k in (
                "amount", "failure_category", "payment_method",
                "historical_success_rate", "retry_count", "is_subscription",
                "intervention", "contact_channel", "merchant_vertical",
                "day_of_week", "customer_tenure_days", "plan_tier",
            )
        },
    )


@app.get("/health")
async def health():
    try:
        load_model()
        model_ok = True
    except Exception:
        model_ok = False
    return {
        "status": "healthy" if model_ok else "degraded_no_model",
        "model_version": _meta["model_version"] if _meta else None,
    }


@app.get("/model-info")
async def model_info():
    load_model()
    m = _meta["metrics"]["test_metrics"]
    return {
        "name": "Baseline Recovery Probability Model",
        "version": _meta["model_version"],
        "type": _meta["model_type"],
        "label_definition": _meta["metrics"]["label_definition"],
        "feature_count": _meta["feature_count"],
        "failure_categories": FAILURE_CATEGORIES,
        "payment_methods": PAYMENT_METHODS,
        "context_features": "v4: category, method, intervention, contact channel, merchant vertical, "
                            "day-of-week, account tenure, plan tier",
        "held_out_test_metrics": m,
        "limitations": [
            "Linear baseline - no explicit feature interactions (additive logit)",
            "Trained on synthetic + production data",
            "Calibration valid within training distribution",
        ],
    }


# ── Drift detection ──────────────────────────────────────────────────────────

@app.get("/drift")
async def drift_report():
    """Data drift report: PSI per feature, overall status."""
    try:
        from drift import compute_drift
        return compute_drift()
    except ImportError:
        return {"status": "drift_module_unavailable"}


# ── Incremental retraining ───────────────────────────────────────────────────

_retrain_lock = False


def _run_retrain_background(force: bool = False):
    """Background retraining task — runs in a thread."""
    global _retrain_lock
    try:
        from retrain import retrain as do_retrain
        result = do_retrain(force=force)
        print(f"[retrain] Completed: {result.get('status')} — {result.get('version', result.get('message', ''))}")
        # Reload the model if a new version was deployed
        if result.get("status") == "deployed":
            global _model, _meta
            _model = None
            _meta = None
            load_model()
            print(f"[retrain] Reloaded model: {_meta.get('model_version')}")
    except Exception as e:
        print(f"[retrain] Error: {e}")
    finally:
        _retrain_lock = False


@app.post("/retrain")
async def trigger_retrain(
    force: bool = False,
    background_tasks: BackgroundTasks = BackgroundTasks(),
    _auth: None = Depends(require_internal_token),
):
    """Trigger incremental model retraining in the background (admin only)."""
    global _retrain_lock
    if _retrain_lock:
        return {"status": "already_running", "message": "A retrain is already in progress"}
    _retrain_lock = True
    background_tasks.add_task(_run_retrain_background, force=force)
    return {"status": "started", "force": force}


@app.get("/retrain-status")
async def retrain_status():
    """Current retraining pipeline status."""
    try:
        from retrain import load_retrain_state
        state = load_retrain_state()
        return {
            "current_version": state.get("current_version"),
            "last_retrain_at": state.get("last_retrain_at"),
            "retrain_count": state.get("retrain_count", 0),
            "retrain_in_progress": _retrain_lock,
        }
    except ImportError:
        return {"status": "retrain_module_unavailable"}


# ── Production training data logging ──────────────────────────────────────────

PRODUCTION_DATA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "production_training.jsonl"
)


class TrainingDataPoint(BaseModel):
    features: RecoveryFeatures
    recovered: bool = Field(..., description="Whether the recovery intervention succeeded")
    intervention: str = Field(default="unknown", description="Intervention type applied")
    source: str = Field(default="production", description="Data source identifier")


@app.post("/log-training-data")
async def log_training_data(
    point: TrainingDataPoint,
    _auth: None = Depends(require_internal_token),
):
    """Record a production training data point for future retraining (admin only)."""
    import json as _json

    f = point.features.model_dump()
    record = {
        "case_id": f"prod_{uuid.uuid4().hex[:8]}",
        "amount": f["amount"],
        "failure_category": f["failure_category"],
        "payment_method": f["payment_method"],
        "historical_success_rate": f["historical_success_rate"],
        "number_of_previous_failures": f["number_of_previous_failures"],
        "time_since_failure_hours": f["time_since_failure_hours"],
        "transaction_hour": f["transaction_hour"],
        "retry_count": f["retry_count"],
        "is_subscription": f["is_subscription"],
        "merchant_historical_rate": f["merchant_historical_rate"],
        "failure_category_historical_rate": f["failure_category_historical_rate"],
        "amount_percentile": f["amount_percentile"],
        "day_of_week": f["day_of_week"],
        "customer_tenure_days": f["customer_tenure_days"],
        "plan_tier": f["plan_tier"],
        "contact_channel": f["contact_channel"],
        "merchant_vertical": f["merchant_vertical"],
        "intervention": point.intervention,
        "recovered": 1 if point.recovered else 0,
        "source": point.source,
        "logged_at": uuid.uuid4().hex,  # placeholder timestamp
    }

    os.makedirs(os.path.dirname(PRODUCTION_DATA_PATH), exist_ok=True)
    with open(PRODUCTION_DATA_PATH, "a") as fh:
        fh.write(_json.dumps(record) + "\n")

    # Also record for drift monitoring
    try:
        from drift import record_feature_vector
        record_feature_vector(f)
    except ImportError:
        pass

    return {"status": "logged", "path": PRODUCTION_DATA_PATH}


@app.post("/log-prediction")
async def log_prediction(
    features: RecoveryFeatures,
    _auth: None = Depends(require_internal_token),
):
    """Record a prediction's features for drift monitoring (admin only)."""
    try:
        from drift import record_feature_vector
        record_feature_vector(features.model_dump())
    except ImportError:
        pass
    return {"status": "recorded"}
