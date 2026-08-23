from src.main import app, RecoveryFeatures
from fastapi.testclient import TestClient

client = TestClient(app)

# Test with a high-probability case
features = RecoveryFeatures(
    amount=2000000,  # 20,000
    failure_category='bank_failure',
    payment_method='card',
    historical_success_rate=0.7,
    number_of_previous_failures=1,
    time_since_failure_hours=2,
    transaction_hour=14,
    retry_count=0,
    is_subscription=True,
    merchant_historical_rate=0.6,
    failure_category_historical_rate=0.5,
    amount_percentile=0.7
)

resp = client.post('/predict', json={
    'features': features.model_dump(),
    'model_version': 'baseline-v1.0.0'
})
data = resp.json()
print('Prediction response (high probability):')
print(f'  Probability: {data["probability"]}')
print(f'  Expected value: {data["expected_recovery_value"]}')
print(f'  Confidence: {data["confidence"]}')
print(f'  Model: {data["model_version"]}')
print(f'  Contributions: {data["feature_contributions"]}')

# Test with a low-probability case (should tend toward DO_NOTHING)
features2 = RecoveryFeatures(
    amount=500,  # 5
    failure_category='customer_cancellation',
    payment_method='upi',
    historical_success_rate=0.1,
    number_of_previous_failures=3,
    time_since_failure_hours=48,
    transaction_hour=10,
    retry_count=2,
    is_subscription=False,
    merchant_historical_rate=0.2,
    failure_category_historical_rate=0.1,
    amount_percentile=0.05
)

resp2 = client.post('/predict', json={
    'features': features2.model_dump(),
    'model_version': 'baseline-v1.0.0'
})
data2 = resp2.json()
print('\nPrediction response (low probability):')
print(f'  Probability: {data2["probability"]}')
print(f'  Expected value: {data2["expected_recovery_value"]}')

# Test model info
resp3 = client.get('/model-info')
data3 = resp3.json()
print(f'\nModel info: {data3["name"]} v{data3["version"]}')

resp4 = client.get('/health')
data4 = resp4.json()
print(f'Health: {data4["status"]}')