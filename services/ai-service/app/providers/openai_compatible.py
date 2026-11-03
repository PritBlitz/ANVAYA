"""Hosted inference adapter for OpenAI-compatible chat-completions APIs (releases/V1.md work package B).

Covers OpenAI itself and self-hosted servers that implement ``POST /v1/chat/completions``
(vLLM, llama.cpp server, LiteLLM, ...). The same rules as the Claude adapter apply:

* Opt-in only: the adapter exists when ``HOSTED_PROVIDER`` lists ``openai_compatible`` with a
  configured base URL and model, and the control plane only routes here when the workspace
  policy selects this provider with an acknowledged data disclosure (FR-AI-003/008).
* No fallback in either direction (FR-AI-004): failures, refusals, rate limits and timeouts
  are reported as errors; no other provider or model is tried, and there are no hidden retries.
* The request carries only the prompt built by the shared prompt builder (redacted, untrusted
  evidence fenced). The API key comes from server environment only and is never logged.
* Output is JSON-schema constrained where the server supports it and is always validated by
  the Pydantic schema in generation.py.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..errors import AiError, provider_timeout, provider_unavailable
from ..prompts import BuiltPrompt
from ..schemas import GenerateRequest, ProviderHealth
from .anthropic_hosted import claude_output_schema
from .base import RawGeneration

log = logging.getLogger("anvaya.ai.openai_compatible")

PROVIDER_NAME = "openai_compatible"


def _retry_after(value: str | None) -> int:
    try:
        return max(1, min(3600, int(float(value or "30"))))
    except ValueError:
        return 30


def strict_json_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Structured-outputs subset: unsupported keywords removed, every object closed and all of its
    properties listed as required (OpenAI strict mode). Pydantic still enforces the full schema."""
    adapted = claude_output_schema(schema)

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(v) for v in node]
        if not isinstance(node, dict):
            return node
        out = {k: walk(v) for k, v in node.items() if k != "default"}
        if isinstance(out.get("properties"), dict):
            out["required"] = list(out["properties"].keys())
        return out

    return walk(adapted)  # type: ignore[no-any-return]


class OpenAICompatibleProvider:
    name = PROVIDER_NAME
    mode = "cloud"

    def __init__(
        self,
        client: httpx.AsyncClient,
        model: str,
        *,
        response_format: str = "json_schema",
        max_tokens_param: str = "max_tokens",
        price_per_mtok: tuple[float, float] | None = None,
    ) -> None:
        self.client = client
        self.model = model
        self.response_format = response_format
        self.max_tokens_param = max_tokens_param
        self.price_per_mtok = price_per_mtok

    def _cost(self, input_tokens: int, output_tokens: int) -> int | None:
        if self.price_per_mtok is None:
            return None
        return round(input_tokens * self.price_per_mtok[0] + output_tokens * self.price_per_mtok[1])

    def _format(self, prompt: BuiltPrompt) -> dict[str, Any] | None:
        if self.response_format == "json_schema":
            return {
                "type": "json_schema",
                "json_schema": {"name": "anvaya_output", "strict": True, "schema": strict_json_schema(prompt.schema)},
            }
        if self.response_format == "json_object":
            return {"type": "json_object"}
        return None

    async def generate(
        self,
        prompt: BuiltPrompt,
        request: GenerateRequest,
        max_output_tokens: int,
        timeout_seconds: float,
        repair_note: str | None,
    ) -> RawGeneration:
        user = f"{prompt.user}\n\n{repair_note}" if repair_note else prompt.user
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "system", "content": prompt.system}, {"role": "user", "content": user}],
            self.max_tokens_param: max_output_tokens,
            "temperature": 0,
        }
        fmt = self._format(prompt)
        if fmt is not None:
            body["response_format"] = fmt
        try:
            res = await self.client.post("chat/completions", json=body, timeout=timeout_seconds)
        except httpx.TimeoutException as exc:
            raise provider_timeout(self.name) from exc
        except httpx.HTTPError as exc:
            raise provider_unavailable(self.name) from exc

        if res.status_code in (401, 403):
            raise AiError(503, "PROVIDER_NOT_CONFIGURED", "The hosted provider rejected the configured credentials.")
        if res.status_code == 429:
            raise AiError(
                429,
                "PROVIDER_RATE_LIMITED",
                "The hosted provider is rate limiting requests. Retry later.",
                {"retry_after_seconds": _retry_after(res.headers.get("retry-after"))},
            )
        if res.status_code in (400, 404, 413, 422):
            log.warning("hosted request rejected", extra={"status": res.status_code})
            raise AiError(502, "PROVIDER_BAD_REQUEST", "The hosted provider rejected the request.")
        if res.status_code >= 400:
            raise provider_unavailable(self.name, f"status {res.status_code}")

        try:
            payload = res.json()
            choice = payload["choices"][0]
            message = choice.get("message") or {}
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise provider_unavailable(self.name, "malformed response") from exc
        finish = choice.get("finish_reason")
        if message.get("refusal") or finish == "content_filter":
            raise AiError(
                422,
                "PROVIDER_REFUSED",
                "The hosted model declined this request.",
                {"category": "content_filter" if finish == "content_filter" else "refusal"},
            )
        text = message.get("content") or ""
        if not isinstance(text, str):
            text = ""
        usage = payload.get("usage") or {}
        input_tokens = int(usage.get("prompt_tokens") or 0)
        output_tokens = int(usage.get("completion_tokens") or 0)
        served = str(payload.get("model") or self.model)
        if finish == "length":
            log.warning("hosted output hit the token limit", extra={"model": served})
        return RawGeneration(
            text=text,
            model=served,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            estimated_cost_microunits=self._cost(input_tokens, output_tokens),
        )

    async def aclose(self) -> None:
        await self.client.aclose()

    async def health(self) -> ProviderHealth:
        try:
            res = await self.client.get("models", timeout=10)
        except httpx.HTTPError as exc:
            return ProviderHealth(
                provider=self.name, mode="cloud", available=False, models=[self.model], detail=type(exc).__name__
            )
        if res.status_code in (401, 403):
            return ProviderHealth(
                provider=self.name, mode="cloud", available=False, models=[self.model], detail="invalid credentials"
            )
        if res.status_code >= 400:
            return ProviderHealth(
                provider=self.name,
                mode="cloud",
                available=False,
                models=[self.model],
                detail=f"status {res.status_code}",
            )
        try:
            ids = {str(m.get("id")) for m in res.json().get("data", []) if isinstance(m, dict)}
        except (ValueError, AttributeError):
            ids = set()
        if ids and self.model not in ids:
            return ProviderHealth(
                provider=self.name,
                mode="cloud",
                available=False,
                models=[self.model],
                detail=f"model {self.model} not available",
            )
        return ProviderHealth(provider=self.name, mode="cloud", available=True, models=[self.model], detail=None)


def build_openai_compatible_provider(
    base_url: str,
    api_key: str | None,
    model: str,
    *,
    response_format: str = "json_schema",
    max_tokens_param: str = "max_tokens",
    price_per_mtok: tuple[float, float] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> OpenAICompatibleProvider:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    client = httpx.AsyncClient(
        base_url=base_url.rstrip("/") + "/", headers=headers, transport=transport, follow_redirects=False
    )
    return OpenAICompatibleProvider(
        client, model, response_format=response_format, max_tokens_param=max_tokens_param, price_per_mtok=price_per_mtok
    )
