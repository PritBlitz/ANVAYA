"""Ollama adapter — the default local provider (FR-AI-002).

Concurrency is bounded by a semaphore (one request at a time by default on
CPU-only hardware). Structured output uses Ollama's JSON-schema `format`
option; results are still validated by generation.py.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from ..errors import AiError, provider_timeout, provider_unavailable
from ..prompts import BuiltPrompt
from ..schemas import GenerateRequest, ProviderHealth
from .base import EmbeddingResult, RawGeneration


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        max_concurrency: int,
        timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url, timeout=timeout_seconds, transport=transport, follow_redirects=False
        )
        self._sem = asyncio.Semaphore(max_concurrency)
        self._digests: dict[str, str] = {}

    async def post(self, path: str, body: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        async with self._sem:
            try:
                res = await self._client.post(path, json=body, timeout=timeout)
            except httpx.TimeoutException as exc:
                raise provider_timeout("ollama") from exc
            except httpx.HTTPError as exc:
                raise provider_unavailable("ollama") from exc
        if res.status_code == 404:
            raise AiError(
                503, "MODEL_NOT_AVAILABLE", f"The configured model is not installed in Ollama ({body.get('model')})."
            )
        if res.status_code >= 400:
            raise provider_unavailable("ollama", f"status {res.status_code}")
        data = res.json()
        if not isinstance(data, dict):
            raise provider_unavailable("ollama", "malformed response")
        return data

    async def tags(self) -> list[dict[str, Any]]:
        try:
            res = await self._client.get("/api/tags", timeout=5)
            res.raise_for_status()
        except httpx.HTTPError as exc:
            raise provider_unavailable("ollama") from exc
        models = res.json().get("models", [])
        return [m for m in models if isinstance(m, dict)]

    async def digest(self, model: str) -> str:
        """Model version = Ollama digest prefix, so index vectors are tied to exact weights."""
        if model not in self._digests:
            for m in await self.tags():
                name = str(m.get("name", ""))
                if name == model or name == f"{model}:latest":
                    self._digests[model] = str(m.get("digest", "unknown"))[:12]
            self._digests.setdefault(model, "unknown")
        return self._digests[model]

    async def aclose(self) -> None:
        await self._client.aclose()


class OllamaProvider:
    name = "ollama"
    mode = "local"

    def __init__(self, client: OllamaClient, model: str, context_tokens: int) -> None:
        self.client = client
        self.model = model
        self.context_tokens = context_tokens

    async def generate(
        self,
        prompt: BuiltPrompt,
        request: GenerateRequest,
        max_output_tokens: int,
        timeout_seconds: float,
        repair_note: str | None,
    ) -> RawGeneration:
        messages = [{"role": "system", "content": prompt.system}, {"role": "user", "content": prompt.user}]
        if repair_note:
            messages.append({"role": "user", "content": repair_note})
        body = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "format": grammar_safe_schema(prompt.schema),
            "options": {
                "temperature": REPAIR_TEMPERATURE if request.task == "repair" else 0,
                "num_predict": max_output_tokens,
                "num_ctx": self.context_tokens,
            },
        }
        data = await self.client.post("/api/chat", body, timeout=timeout_seconds)
        message = data.get("message") or {}
        return RawGeneration(
            text=str(message.get("content", "")),
            model=self.model,
            input_tokens=int(data.get("prompt_eval_count") or 0),
            output_tokens=int(data.get("eval_count") or 0),
            estimated_cost_microunits=0,
        )

    async def health(self) -> ProviderHealth:
        try:
            names = [str(m.get("name")) for m in await self.client.tags()]
        except AiError as exc:
            return ProviderHealth(provider="ollama", mode="local", available=False, detail=exc.code)
        ok = self.model in names or f"{self.model}:latest" in names
        return ProviderHealth(
            provider="ollama",
            mode="local",
            available=ok,
            models=names,
            detail=None if ok else f"model {self.model} not installed",
        )


# JSON-schema keywords Ollama compiles into llama.cpp grammar repetitions. Large
# bounds (e.g. maxLength 500 inside an array of up to 12 items) exceed the
# grammar's repetition limit and crash the runner. They are removed only from
# the grammar hint; the full schema is still enforced on the parsed output.
# At temperature 0 a repair can repeat the broken file exactly, so a retry could never differ.
REPAIR_TEMPERATURE = 0.3

_GRAMMAR_UNSAFE_KEYS = frozenset({"maxLength", "minLength", "pattern", "maxItems", "minItems", "format"})


def grammar_safe_schema(schema: Any) -> Any:
    """Returns a copy of ``schema`` without keywords that blow up grammar compilation."""
    if isinstance(schema, dict):
        return {
            k: grammar_safe_schema(v)
            for k, v in schema.items()
            if k not in _GRAMMAR_UNSAFE_KEYS or not isinstance(v, (int, str))
        }
    if isinstance(schema, list):
        return [grammar_safe_schema(v) for v in schema]
    return schema


class OllamaEmbeddingProvider:
    name = "ollama"

    def __init__(self, client: OllamaClient, model: str) -> None:
        self.client = client
        self.model = model

    async def embed(self, texts: list[str], input_type: str) -> EmbeddingResult:
        # nomic-embed-text expects task prefixes for asymmetric retrieval.
        prefix = "search_query: " if input_type == "query" else "search_document: "
        inputs = [prefix + t for t in texts] if "nomic" in self.model else texts
        data = await self.client.post("/api/embed", {"model": self.model, "input": inputs, "truncate": True})
        vectors = data.get("embeddings")
        if not isinstance(vectors, list) or len(vectors) != len(texts):
            raise provider_unavailable("ollama", "malformed embedding response")
        return EmbeddingResult(
            model=self.model,
            model_version=await self.client.digest(self.model),
            vectors=vectors,
            input_tokens=data.get("prompt_eval_count"),
        )

    async def health(self) -> ProviderHealth:
        try:
            names = [str(m.get("name")) for m in await self.client.tags()]
        except AiError as exc:
            return ProviderHealth(provider="ollama", mode="local", available=False, detail=exc.code)
        ok = self.model in names or f"{self.model}:latest" in names
        return ProviderHealth(provider="ollama", mode="local", available=ok, models=names)
