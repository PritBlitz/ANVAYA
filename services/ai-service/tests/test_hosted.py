"""Hosted (cloud) adapter: request shape, structured output, cost, refusals and no-fallback behaviour."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import anthropic
import httpx2
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.generation import Providers
from app.main import create_app
from app.providers.anthropic_hosted import AnthropicProvider, claude_output_schema, estimate_cost_microunits
from app.providers.mock import MockEmbeddingProvider, MockProvider
from app.providers.ollama import OllamaClient, OllamaProvider

from .test_service import AUTH, TOKEN, gen

MODEL = "claude-opus-5-5"


def settings(**overrides: str) -> Settings:
    values = {"AI_SERVICE_TOKEN": TOKEN, "EMBEDDING_PROVIDER": "mock", "NODE_ENV": "test", **overrides}
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


def hosted_providers(handler: Callable[[httpx2.Request], httpx2.Response]) -> Providers:
    http = anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(handler))
    client = anthropic.AsyncAnthropic(api_key="sk-ant-test", base_url="https://claude.test", http_client=http, max_retries=0)
    ollama = OllamaClient("http://ollama.test", 1, 30)
    return Providers(
        mock=MockProvider(),
        local=OllamaProvider(ollama, "qwen-test", 4096),
        cloud=AnthropicProvider(client, MODEL, "medium"),
        embeddings=MockEmbeddingProvider(768),
        ollama_client=ollama,
    )


def message(text: str, stop: str = "end_turn", **extra: Any) -> dict[str, Any]:
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": MODEL,
        "content": [{"type": "text", "text": text}],
        "stop_reason": stop,
        "stop_sequence": None,
        "usage": {"input_tokens": 1000, "output_tokens": 200},
        **extra,
    }


def qa(evidence_id: str) -> str:
    return json.dumps({"answer": "In file1.", "citations": [{"evidence_id": evidence_id, "supports": "x"}], "limitations": [], "insufficient_evidence": False})


def cloud(**extra: Any) -> dict[str, Any]:
    return gen("repository_qa", mode="cloud", provider="anthropic", **extra)


def test_cloud_generation_uses_structured_output_and_reports_cost() -> None:
    seen: list[dict[str, Any]] = []

    def handler(req: httpx2.Request) -> httpx2.Response:
        seen.append({"url": str(req.url), "headers": dict(req.headers), "body": json.loads(req.content)})
        return httpx2.Response(200, json=message(qa("ev-1")))

    with TestClient(create_app(settings(), hosted_providers(handler))) as c:
        res = c.post("/internal/v1/generate", json=cloud(), headers=AUTH)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["provider"] == "anthropic" and body["model"] == MODEL and body["mode"] == "cloud"
    # $4 / $20 per MTok → 1000*4 + 200*20 microunits.
    assert body["usage"] == {"input_tokens": 1000, "output_tokens": 200, "estimated_cost_microunits": 8000}
    sent = seen[0]
    assert sent["url"].endswith("/v1/messages")
    assert sent["headers"]["x-api-key"] == "sk-ant-test"
    b = sent["body"]
    assert b["model"] == MODEL and b["system"] and b["messages"][0]["role"] == "user"
    assert "UNTRUSTED DATA" in b["system"]
    assert b["max_tokens"] >= 512
    fmt = b["output_config"]["format"]
    assert fmt["type"] == "json_schema" and fmt["schema"]["additionalProperties"] is False
    assert b["output_config"]["effort"] == "medium"
    dumped = json.dumps(fmt["schema"])
    assert "maxLength" not in dumped and "maxItems" not in dumped
    assert "thinking" not in b and "temperature" not in b


def test_refusal_is_an_error_not_a_fallback() -> None:
    calls = 0

    def handler(req: httpx2.Request) -> httpx2.Response:
        nonlocal calls
        calls += 1
        return httpx2.Response(200, json=message("", stop="refusal", stop_details={"type": "refusal", "category": "cyber", "explanation": None}))

    with TestClient(create_app(settings(), hosted_providers(handler))) as c:
        res = c.post("/internal/v1/generate", json=cloud(), headers=AUTH)
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "PROVIDER_REFUSED"
    assert res.json()["error"]["details"] == {"category": "cyber"}
    assert calls == 1


@pytest.mark.parametrize(
    ("status", "code"),
    [(429, "PROVIDER_RATE_LIMITED"), (401, "PROVIDER_NOT_CONFIGURED"), (400, "PROVIDER_BAD_REQUEST"), (529, "PROVIDER_UNAVAILABLE")],
)
def test_upstream_errors_map_to_explicit_codes(status: int, code: str) -> None:
    def handler(req: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(status, json={"type": "error", "error": {"type": "x", "message": "nope"}})

    with TestClient(create_app(settings(), hosted_providers(handler))) as c:
        res = c.post("/internal/v1/generate", json=cloud(), headers=AUTH)
    assert res.json()["error"]["code"] == code


def test_cloud_is_not_configured_without_opt_in() -> None:
    with TestClient(create_app(settings())) as c:
        res = c.post("/internal/v1/generate", json=cloud(), headers=AUTH)
    assert res.status_code == 503 and res.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"


def test_opt_in_requires_an_api_key() -> None:
    with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
        settings(HOSTED_PROVIDER="anthropic")
    s = settings(HOSTED_PROVIDER="anthropic", ANTHROPIC_API_KEY="sk-ant-x")
    assert Providers.from_settings(s).cloud is not None
    assert "sk-ant-x" not in repr(s)


def test_other_models_are_refused() -> None:
    with TestClient(create_app(settings(), hosted_providers(lambda r: httpx2.Response(200, json=message(qa("ev-1")))))) as c:
        res = c.post("/internal/v1/generate", json=cloud(model="claude-haiku-5-5"), headers=AUTH)
    assert res.json()["error"]["code"] == "MODEL_NOT_ALLOWED"


def test_health_checks_the_configured_model() -> None:
    def handler(req: httpx2.Request) -> httpx2.Response:
        assert req.url.path.endswith(f"/v1/models/{MODEL}")
        return httpx2.Response(200, json={"type": "model", "id": MODEL, "display_name": "Claude Opus 5.5", "created_at": "2026-01-01T00:00:00Z"})

    with TestClient(create_app(settings(), hosted_providers(handler))) as c:
        res = c.post("/internal/v1/providers/health", json={"mode": "cloud"}, headers=AUTH)
    assert res.json() == {"provider": "anthropic", "mode": "cloud", "available": True, "models": [MODEL], "detail": None}


def test_schema_adaptation_and_pricing() -> None:
    schema = {
        "type": "object",
        "properties": {"a": {"type": "string", "maxLength": 5}, "n": {"type": "array", "maxItems": 3, "items": {"$ref": "#/$defs/X"}}},
        "$defs": {"X": {"type": "object", "properties": {"maxLength": {"type": "integer", "minimum": 0}}}},
    }
    out = claude_output_schema(schema)
    assert out["additionalProperties"] is False
    assert out["properties"]["a"] == {"type": "string"}
    assert out["$defs"]["X"] == {"type": "object", "properties": {"maxLength": {"type": "integer"}}, "additionalProperties": False}
    assert schema["properties"]["a"]["maxLength"] == 5
    assert estimate_cost_microunits("claude-sonnet-5-5", 1_000_000, 0) == 2_000_000
    assert estimate_cost_microunits("unknown", 1, 1) is None


def test_rate_limit_carries_retry_after() -> None:
    def handler(req: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(429, headers={"retry-after": "17"}, json={"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}})

    with TestClient(create_app(settings(), hosted_providers(handler))) as c:
        res = c.post("/internal/v1/generate", json=cloud(), headers=AUTH)
    assert res.status_code == 429
    assert res.json()["error"]["details"] == {"retry_after_seconds": 17}
