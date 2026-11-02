from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    hosted_provider: Literal["none", "anthropic"] = Field(default="none", alias="HOSTED_PROVIDER")
    anthropic_api_key: SecretStr | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    hosted_model: str = Field(default="claude-opus-5-5", alias="HOSTED_MODEL")
    hosted_effort: Literal["low", "medium", "high", "xhigh", "max"] = Field(default="medium", alias="HOSTED_EFFORT")
    # Only for tests / a reviewed egress proxy; defaults to the public API.
    hosted_base_url: str | None = Field(default=None, alias="HOSTED_BASE_URL")

    max_evidence_items: int = Field(default=24, alias="MAX_EVIDENCE_ITEMS", ge=1, le=100)

    @model_validator(mode="after")
    def _production_rules(self) -> Settings:
        if self.env == "production" and not self.service_token:
            raise ValueError("AI_SERVICE_TOKEN is required in production")
        if self.hosted_provider == "anthropic" and not self.anthropic_api_key:
            raise ValueError("ANTHROPIC_API_KEY is required when HOSTED_PROVIDER=anthropic")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
