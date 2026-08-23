from src.main import app, RecoveryFeatures
from fastapi.testclient import TestClient

client = TestClient(app)

features = RecoveryFeatures(
    amount=2000000,
    failure_category='bank_failure',
    payment_method='card',
    historical_success_rate=0.8,
    number_of_previous_failures=1,
    time_since_failure_hours=2,
    transaction_hour=14,
    retry_count=0,
    is_subscription=True,
    merchant_historical_rate=0.7,
    failure_category_historical_rate=0.6,
    amount_percentile=0.7
)
r = client.post('/predict', json={'features': features.model_dump(), 'case_id': 'case_high'})
d = r.json()
print('high:', 'p=', d['probability'], 'ev=', d['expected_recovery_value'], 'model=', d['model_version'])

f2 = features.model_dump()
f2.update({'failure_category': 'customer_cancellation', 'historical_success_rate': 0.1,
           'retry_count': 3, 'time_since_failure_hours': 90, 'merchant_historical_rate': 0.2})
r2 = client.post('/predict', json={'features': f2, 'case_id': 'case_low'})
d2 = r2.json()
print('low: ', 'p=', d2['probability'], 'ev=', d2['expected_recovery_value'])

info = client.get('/model-info').json()
print('type:', info['type'])
print('label defn:', info['label_definition'])
print('roc_auc:', info['held_out_test_metrics']['roc_auc'], '| brier_cal:', info['held_out_test_metrics']['brier_calibrated'])

h = client.get('/health').json()
print('health:', h['status'], h['model_version'])

assert d['probability'] > d2['probability'], 'ranking must separate cases'
print('RANKING OK')
