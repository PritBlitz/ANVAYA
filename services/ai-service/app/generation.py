"""Provider routing and structured generation (ARCHITECTURE §7, AI_WORKFLOW §4/§10)."""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from .config import Settings
from .errors import AiError, invalid_output, provider_not_configured, provider_timeout
from .prompts import build_prompt
from .providers.anthropic_hosted import build_anthropic_provider
from .providers.base import EmbeddingProvider, GenerationProvider
from .providers.mock import MockEmbeddingProvider, MockProvider
from .providers.ollama import OllamaClient, OllamaEmbeddingProvider, OllamaProvider
from .schemas import OUTPUT_SCHEMAS, GenerateRequest, GenerateResponse, Usage

log = logging.getLogger("anvaya.ai.generation")


@dataclass
class Providers:
    mock: GenerationProvider
    local: GenerationProvider
    cloud: GenerationProvider | None
    embeddings: EmbeddingProvider
    ollama_client: OllamaClient

    @classmethod
    def from_settings(cls, s: Settings) -> Providers:
        client = OllamaClient(s.ollama_base_url, s.ollama_max_concurrency, s.ollama_timeout_seconds)
        emb: EmbeddingProvider = (
            MockEmbeddingProvider(s.embedding_dimension)
            if s.embedding_provider == "mock"
            else OllamaEmbeddingProvider(client, s.ollama_embedding_model)
        )
        return cls(
            mock=MockProvider(),
            local=OllamaProvider(client, s.ollama_generation_model, s.ollama_context_tokens),
            cloud=(
                build_anthropic_provider(
                    s.anthropic_api_key.get_secret_value(), s.hosted_model, s.hosted_effort, s.hosted_base_url
                )
                if s.hosted_provider == "anthropic" and s.anthropic_api_key
                else None
            ),
            embeddings=emb,
            ollama_client=client,
        )

    def for_mode(self, mode: str, provider: str | None) -> GenerationProvider:
        """Resolve exactly the requested mode. Never silently substitutes another provider (FR-AI-004)."""
        if mode == "mock":
            chosen: GenerationProvider | None = self.mock
        elif mode == "local":
            chosen = self.local
        else:
            chosen = self.cloud
        if chosen is None:
            raise provider_not_configured(mode)
        if provider is not None and provider != chosen.name:
            raise AiError(422, "PROVIDER_MISMATCH", f"Provider '{provider}' is not available for mode '{mode}'.")
        return chosen


def _extract_json(text: str) -> object:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("\n") + 1 :] if "\n" in text else text
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object found")
    return json.loads(text[start : end + 1])


def _cited_ids(output: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    citations = output.get("citations")
    for c in citations if isinstance(citations, list) else []:
        if isinstance(c, dict) and isinstance(c.get("evidence_id"), str):
            ids.add(c["evidence_id"])
    findings = output.get("findings")
    for f in findings if isinstance(findings, list) else []:
        refs = f.get("evidence_ids") if isinstance(f, dict) else None
        if isinstance(refs, list):
            ids.update(i for i in refs if isinstance(i, str))
    return ids


async def generate(req: GenerateRequest, providers: Providers, settings: Settings) -> GenerateResponse:
    started = time.monotonic()
    provider = providers.for_mode(req.mode, req.provider)
    if req.model is not None and req.mode != "mock" and req.model != getattr(provider, "model", None):
        raise AiError(422, "MODEL_NOT_ALLOWED", "The requested model is not configured for this provider.")

    prompt = build_prompt(
        req.task, req.intent, req.evidence, req.context, req.budget.max_input_tokens, settings.max_evidence_items
    )
    schema_type = OUTPUT_SCHEMAS[req.task]
    deadline = started + req.budget.timeout_seconds

    input_tokens = 0
    output_tokens = 0
    cost: int | None = 0
    repair_note: str | None = None
    last_error = ""
    model_name = ""
    for attempt in range(2):  # initial + at most one schema-repair attempt
        remaining = deadline - time.monotonic()
        if remaining <= 1:
            raise provider_timeout(provider.name)
        raw = await provider.generate(prompt, req, req.budget.max_output_tokens, remaining, repair_note)
        model_name = raw.model
        input_tokens += raw.input_tokens
        output_tokens += raw.output_tokens
        cost = None if cost is None or raw.estimated_cost_microunits is None else cost + raw.estimated_cost_microunits
        try:
            parsed = schema_type.model_validate(_extract_json(raw.text))
            output = parsed.model_dump(mode="json")
            unknown = _cited_ids(output) - set(prompt.evidence_included)
            if unknown:
                # A citation to evidence the model was never shown is a fabrication (FR-REP-010).
                raise ValueError(f"cited unknown evidence ids: {sorted(unknown)[:5]}")
            log.info(
                "generation ok",
                extra={
                    "task": req.task,
                    "provider": provider.name,
                    "attempts": attempt + 1,
                    "in": input_tokens,
                    "out": output_tokens,
                },
            )
            return GenerateResponse(
                task=req.task,
                provider=provider.name,
                model=model_name,
                mode=req.mode,
                prompt_version=prompt.version,
                output=output,
                evidence_included=prompt.evidence_included,
                usage=Usage(input_tokens=input_tokens, output_tokens=output_tokens, estimated_cost_microunits=cost),
                duration_ms=int((time.monotonic() - started) * 1000),
                schema_repair_attempted=attempt > 0,
            )
        except (ValueError, ValidationError) as exc:
            last_error = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
            repair_note = (
                "Your previous response did not conform to the required JSON schema "
                f"({last_error[:200]}). Respond again with only a JSON object that matches the schema exactly."
            )
    raise invalid_output(req.task, last_error)
