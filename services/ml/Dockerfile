# syntax=docker/dockerfile:1
# RevenuePulse ML Service (FastAPI recovery prediction) — build from repo root:
#   docker build -t revenuepulse-ml -f services/ml/Dockerfile .

FROM python:3.12-slim AS base
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# ── Dependencies ───────────────────────────────────────────────────────────
COPY services/ml/requirements.txt services/ml/
RUN pip install --no-cache-dir -r services/ml/requirements.txt

# ── Runtime ────────────────────────────────────────────────────────────────
COPY services/ml/src ./src
COPY services/ml/model ./model
COPY services/ml/data ./data
COPY services/ml/train_baseline.py ./train_baseline.py
COPY services/ml/drift.py ./drift.py

# Fix python path for uvicorn (module is src.main:app)
WORKDIR /app/src
EXPOSE 8000
ENV RECOVERY_MODEL_PATH=/app/model/model.joblib
ENV PORT=8000

# Shell form so $PORT is expanded — Railway assigns its own port per service.
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT}
