"""Hosted inference adapter for Claude (B-1, ARCHITECTURE §7 "cloud" mode).

Opt-in only: the adapter exists when ``HOSTED_PROVIDER=anthropic`` and an API
key is configured, and the control plane only routes here when the workspace
policy enables cloud mode with an acknowledged data disclosure. There is no
fallback in either direction: a failure, refusal or timeout is reported as an
error, never answered by another provider or model (FR-AI-004). The request
carries only the prompt the shared prompt builder produced (already redacted,
with untrusted evidence fenced), so nothing beyond the disclosed categories
leaves the service.
"""

from __future__ import annotations

import copy
import logging
from typing import Any

import anthropic

from ..errors import AiError, provider_timeout, provider_unavailable
from ..prompts import BuiltPrompt
from ..schemas import GenerateRequest, ProviderHealth
from .base import RawGeneration

log = logging.getLogger("anvaya.ai.anthropic")

# USD per million tokens (input, output), first-party API list prices. Used only
# for the advisory ``estimated_cost_microunits`` (1 microunit = 1e-6 USD), which
# is therefore tokens x price-per-MTok.
PRICING_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-fable-5-1": (10.0, 50.0),
}

# Structured outputs reject these keywords; they are still enforced on the parsed
# output by the Pydantic schema in generation.py.
_UNSUPPORTED = frozenset(
    {"minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "pattern"}
)
# Thinking tokens count toward max_tokens; keep headroom so the JSON is not cut off.
_THINKING_HEADROOM = 8000


def claude_output_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Adapts a Pydantic JSON schema to the structured-outputs subset: strips unsupported
    constraints and closes every object with ``additionalProperties: false``."""

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(v) for v in node]
        if not isinstance(node, dict):
            return node
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k in _UNSUPPORTED and not isinstance(v, (dict, list)):
                continue
            if k in ("properties", "$defs", "definitions") and isinstance(v, dict):
                out[k] = {name: walk(sub) for name, sub in v.items()}
            else:
                out[k] = walk(v)
        if out.get("type") == "object" or "properties" in out:
            out["additionalProperties"] = False
        return out

    return walk(copy.deepcopy(schema))  # type: ignore[no-any-return]


def estimate_cost_microunits(model: str, input_tokens: int, output_tokens: int) -> int | None:
    price = PRICING_PER_MTOK.get(model)
    if price is None:
        return None
    return round(input_tokens * price[0] + output_tokens * price[1])


class AnthropicProvider:
    name = "anthropic"
    mode = "cloud"

    def __init__(self, client: anthropic.AsyncAnthropic, model: str, effort: str) -> None:
        self.client = client
        self.model = model
        self.effort = effort

    async def generate(
        self,
        prompt: BuiltPrompt,
        request: GenerateRequest,
        max_output_tokens: int,
        timeout_seconds: float,
        repair_note: str | None,
    ) -> RawGeneration:
        messages: list[dict[str, Any]] = [{"role": "user", "content": prompt.user}]
        if repair_note:
            messages[0]["content"] = f"{prompt.user}\n\n{repair_note}"
        try:
            response = await self.client.with_options(timeout=timeout_seconds, max_retries=1).messages.create(  # type: ignore[call-overload]
                model=self.model,
                max_tokens=max_output_tokens + _THINKING_HEADROOM,
                system=prompt.system,
                messages=messages,
                output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": claude_output_schema(prompt.schema)}},
            )
        except anthropic.APITimeoutError as exc:
            raise provider_timeout(self.name) from exc
        except anthropic.AuthenticationError as exc:
            raise AiError(503, "PROVIDER_NOT_CONFIGURED", "The hosted provider rejected the configured credentials.") from exc
        except anthropic.RateLimitError as exc:
            raise AiError(429, "PROVIDER_RATE_LIMITED", "The hosted provider is rate limiting requests. Retry later.") from exc
        except anthropic.BadRequestError as exc:
            log.warning("hosted request rejected", extra={"status": exc.status_code})
            raise AiError(502, "PROVIDER_BAD_REQUEST", "The hosted provider rejected the request.") from exc
        except anthropic.APIStatusError as exc:
            raise provider_unavailable(self.name, f"status {exc.status_code}") from exc
        except anthropic.APIConnectionError as exc:
            raise provider_unavailable(self.name) from exc

        stop = getattr(response, "stop_reason", None)
        if stop == "refusal":
            details = getattr(response, "stop_details", None)
            category = getattr(details, "category", None) if details is not None else None
            raise AiError(422, "PROVIDER_REFUSED", "The hosted model declined this request.", {"category": category})
        text = "".join(getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text")
        usage = response.usage
        served = str(getattr(response, "model", None) or self.model)
        input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
        output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
        if stop == "max_tokens":
            log.warning("hosted output hit max_tokens", extra={"model": served})
        return RawGeneration(
            text=text,
            model=served,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            estimated_cost_microunits=estimate_cost_microunits(self.model, input_tokens, output_tokens),
        )

    async def health(self) -> ProviderHealth:
        try:
            await self.client.with_options(timeout=10, max_retries=0).models.retrieve(self.model)
        except anthropic.AuthenticationError:
            return ProviderHealth(provider=self.name, mode="cloud", available=False, models=[self.model], detail="invalid credentials")
        except anthropic.NotFoundError:
            return ProviderHealth(provider=self.name, mode="cloud", available=False, models=[self.model], detail=f"model {self.model} not available")
        except (anthropic.APIStatusError, anthropic.APIConnectionError) as exc:
            return ProviderHealth(provider=self.name, mode="cloud", available=False, models=[self.model], detail=type(exc).__name__)
        return ProviderHealth(provider=self.name, mode="cloud", available=True, models=[self.model], detail=None)


def build_anthropic_provider(api_key: str, model: str, effort: str, base_url: str | None = None) -> AnthropicProvider:
    client = anthropic.AsyncAnthropic(api_key=api_key, base_url=base_url, max_retries=1)
    return AnthropicProvider(client, model, effort)
