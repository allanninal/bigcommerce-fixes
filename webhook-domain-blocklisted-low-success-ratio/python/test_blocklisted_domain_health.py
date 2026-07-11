from webhook_domain_health import evaluate_webhook_health


def make_requests(domain, total, failures):
    entries = []
    for i in range(total):
        status = 500 if i < failures else 200
        entries.append({"timestamp": float(i), "domain": domain, "status_code": status})
    return entries


def test_domain_below_sample_size_is_not_evaluated():
    requests_ = make_requests("shop-a.example.com", 40, 40)
    result = evaluate_webhook_health(requests_)
    entry = result["shop-a.example.com"]
    assert entry["total"] == 40
    assert entry["success_ratio"] is None
    assert entry["at_risk"] is False


def test_domain_at_or_above_sample_with_low_ratio_is_at_risk():
    requests_ = make_requests("shop-b.example.com", 100, 15)
    result = evaluate_webhook_health(requests_)
    entry = result["shop-b.example.com"]
    assert entry["total"] == 100
    assert entry["success_ratio"] == 0.85
    assert entry["at_risk"] is True


def test_domain_at_sample_with_healthy_ratio_is_not_at_risk():
    requests_ = make_requests("shop-c.example.com", 120, 5)
    result = evaluate_webhook_health(requests_)
    entry = result["shop-c.example.com"]
    assert entry["total"] == 120
    assert round(entry["success_ratio"], 4) == round((120 - 5) / 120, 4)
    assert entry["at_risk"] is False


def test_ratio_exactly_at_threshold_is_not_at_risk():
    requests_ = make_requests("shop-d.example.com", 100, 10)
    result = evaluate_webhook_health(requests_)
    entry = result["shop-d.example.com"]
    assert entry["success_ratio"] == 0.90
    assert entry["at_risk"] is False


def test_ratio_just_below_threshold_is_at_risk():
    requests_ = make_requests("shop-e.example.com", 100, 11)
    result = evaluate_webhook_health(requests_)
    entry = result["shop-e.example.com"]
    assert entry["success_ratio"] == 0.89
    assert entry["at_risk"] is True


def test_multiple_domains_are_evaluated_independently():
    healthy = make_requests("healthy.example.com", 100, 2)
    flaky = make_requests("flaky.example.com", 150, 40)
    result = evaluate_webhook_health(healthy + flaky)
    assert result["healthy.example.com"]["at_risk"] is False
    assert result["flaky.example.com"]["at_risk"] is True


def test_empty_input_returns_empty_dict():
    assert evaluate_webhook_health([]) == {}


def test_custom_min_sample_and_threshold_are_respected():
    requests_ = make_requests("custom.example.com", 20, 5)
    result = evaluate_webhook_health(requests_, min_sample=10, threshold=0.80)
    entry = result["custom.example.com"]
    assert entry["total"] == 20
    assert entry["success_ratio"] == 0.75
    assert entry["at_risk"] is True
