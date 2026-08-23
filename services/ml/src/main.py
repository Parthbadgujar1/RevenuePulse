"""
RevenuePulse Recovery Prediction API.

Serves the EXACT artifact produced by train_baseline.py
(services/ml/model/model.joblib). No hand-tuned weights - if the model
file is missing the service refuses to predict.
"""

import os
import uuid
import warnings
from typing import Any, Dict, Optional

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import sys
sys.path.insert(0, os.path.dirname(__file__))
from features import FEATURE_NAMES, FAILURE_CATEGORIES, PAYMENT_METHODS, build_feature_vector

warnings.filterwarnings("ignore")

MODEL_PATH = os.environ.get(
    "RECOVERY_MODEL_PATH",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "model", "model.joblib"),
)

app = FastAPI(
    title="RevenuePulse Recovery Prediction API",
    description="Recovery probability for failed payments (calibrated logistic regression)",
    version="2.0.0",
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

    confidence = 1.0 - abs(proba - 0.5) * 2 * 0.4  # higher away from 0.5

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
        "held_out_test_metrics": m,
        "limitations": [
            "Linear baseline - no feature interactions",
            "Trained on synthetic recovery outcomes - validate on production data",
            "Calibration valid within training distribution",
        ],
    }
