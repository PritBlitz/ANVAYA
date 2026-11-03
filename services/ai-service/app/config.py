from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

HOSTED_ADAPTERS = frozenset({"anthropic", "openai_compatible"})


class Settings(BaseSettings):
    """AI service configuration. Validated at startup; secrets are never logged."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    env: Literal["development", "test", "production"] = Field(default="development", alias="NODE_ENV")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    # Shared secret for calls from the control plane. Required in production.
    service_token: str | None = Field(default=None, alias="AI_SERVICE_TOKEN", min_length=16)

    # Local inference (default provider).
    ollama_base_url: str = Field(default="http://127.0.0.1:11434", alias="OLLAMA_BASE_URL")
    ollama_generation_model: str = Field(default="qwen2.5-coder:7b", alias="OLLAMA_GENERATION_MODEL")
    ollama_embedding_model: str = Field(default="nomic-embed-text", alias="OLLAMA_EMBEDDING_MODEL")
    # On constrained CPU-only hardware: one request at a time, short context (AI_WORKFLOW §8).
    ollama_max_concurrency: int = Field(default=1, alias="OLLAMA_MAX_CONCURRENCY", ge=1, le=16)
    ollama_context_tokens: int = Field(default=4096, alias="OLLAMA_CONTEXT_TOKENS", ge=1024, le=131072)
    ollama_timeout_seconds: float = Field(default=300, alias="OLLAMA_TIMEOUT_SECONDS", gt=0)

    # Embeddings are always local: "ollama" in normal operation, "mock" for tests/dev without Ollama.
    embedding_provider: Literal["ollama", "mock"] = Field(default="ollama", alias="EMBEDDING_PROVIDER")
    embedding_dimension: int = Field(default=768, alias="EMBEDDING_DIMENSION")

    # Hosted inference is opt-in; no hosted adapter is enabled unless explicitly configured.
    # "none", or a comma-separated list of adapters: "anthropic", "openai_compatible".
    hosted_provider: str = Field(default="none", alias="HOSTED_PROVIDER", max_length=100)
    anthropic_api_key: SecretStr | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    hosted_model: str = Field(default="claude-opus-5-5", alias="HOSTED_MODEL")
    hosted_effort: Literal["low", "medium", "high", "xhigh", "max"] = Field(default="medium", alias="HOSTED_EFFORT")
    # Only for tests / a reviewed egress proxy; defaults to the public API.
    hosted_base_url: str | None = Field(default=None, alias="HOSTED_BASE_URL")

    # OpenAI-compatible chat-completions endpoint (OpenAI, or a self-hosted vLLM / llama.cpp / LiteLLM server).
    openai_compat_base_url: str | None = Field(default=None, alias="OPENAI_COMPAT_BASE_URL")
    # Optional for self-hosted servers without authentication. Server environment only; never logged.
    openai_compat_api_key: SecretStr | None = Field(default=None, alias="OPENAI_COMPAT_API_KEY")
    openai_compat_model: str | None = Field(default=None, alias="OPENAI_COMPAT_MODEL", max_length=100)
    # How structured output is requested: strict JSON schema, JSON mode, or prompt-only (always validated).
    openai_compat_response_format: Literal["json_schema", "json_object", "none"] = Field(
        default="json_schema", alias="OPENAI_COMPAT_RESPONSE_FORMAT"
    )
    openai_compat_max_tokens_param: Literal["max_tokens", "max_completion_tokens"] = Field(
        default="max_tokens", alias="OPENAI_COMPAT_MAX_TOKENS_PARAM"
    )
    # Optional list prices (USD per million tokens) for the advisory cost estimate; unset = unknown cost.
    openai_compat_price_input_per_mtok: float | None = Field(
        default=None, alias="OPENAI_COMPAT_PRICE_INPUT_PER_MTOK", ge=0
    )
    openai_compat_price_output_per_mtok: float | None = Field(
        default=None, alias="OPENAI_COMPAT_PRICE_OUTPUT_PER_MTOK", ge=0
    )
    # Plain http is refused in production unless the operator explicitly allows it (private network).
    openai_compat_allow_http: bool = Field(default=False, alias="OPENAI_COMPAT_ALLOW_HTTP")

    max_evidence_items: int = Field(default=24, alias="MAX_EVIDENCE_ITEMS", ge=1, le=100)

    @property
    def hosted_providers(self) -> frozenset[str]:
        names = {p.strip() for p in self.hosted_provider.split(",") if p.strip()}
        return frozenset(names - {"none"})

    @model_validator(mode="after")
    def _production_rules(self) -> Settings:
        if self.env == "production" and not self.service_token:
            raise ValueError("AI_SERVICE_TOKEN is required in production")
        unknown = self.hosted_providers - HOSTED_ADAPTERS
        if unknown:
            raise ValueError(f"HOSTED_PROVIDER lists unknown adapters: {sorted(unknown)}")
        if "anthropic" in self.hosted_providers and not self.anthropic_api_key:
            raise ValueError("ANTHROPIC_API_KEY is required when HOSTED_PROVIDER includes anthropic")
        if "openai_compatible" in self.hosted_providers:
            if not self.openai_compat_base_url or not self.openai_compat_model:
                raise ValueError("OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_MODEL are required for openai_compatible")
            url = self.openai_compat_base_url.lower()
            if not url.startswith(("https://", "http://")):
                raise ValueError("OPENAI_COMPAT_BASE_URL must be an http(s) URL")
            if self.env == "production" and url.startswith("http://") and not self.openai_compat_allow_http:
                raise ValueError(
                    "OPENAI_COMPAT_BASE_URL must use https in production (or set OPENAI_COMPAT_ALLOW_HTTP)"
                )
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
