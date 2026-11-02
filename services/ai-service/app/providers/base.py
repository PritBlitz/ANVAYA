from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ..prompts import BuiltPrompt
from ..schemas import GenerateRequest, ProviderHealth


@dataclass(frozen=True)
class RawGeneration:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    estimated_cost_microunits: int | None = None


@dataclass(frozen=True)
class EmbeddingResult:
    model: str
    model_version: str
    vectors: list[list[float]]
    input_tokens: int | None = None


class GenerationProvider(Protocol):
    """Common adapter interface (ARCHITECTURE §7). Structured generation is layered on top in generation.py."""

    name: str
    mode: str

    async def generate(
        self,
        prompt: BuiltPrompt,
        request: GenerateRequest,
        max_output_tokens: int,
        timeout_seconds: float,
        repair_note: str | None,
    ) -> RawGeneration: ...

    async def health(self) -> ProviderHealth: ...


class EmbeddingProvider(Protocol):
    name: str

    async def embed(self, texts: list[str], input_type: str) -> EmbeddingResult: ...

    async def health(self) -> ProviderHealth: ...
