from __future__ import annotations

from typing import Any


class AiError(Exception):
    """Normalized error. Rendered as {"error": {"code", "message", "details"}}; never leaks provider payloads."""

    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def provider_unavailable(provider: str, reason: str = "unreachable") -> AiError:
    return AiError(503, "PROVIDER_UNAVAILABLE", f"Model provider '{provider}' is unavailable ({reason}).")


def provider_not_configured(mode: str) -> AiError:
    return AiError(
        503, "PROVIDER_NOT_CONFIGURED", f"No provider is configured for mode '{mode}'. No fallback is attempted."
    )


def provider_timeout(provider: str) -> AiError:
    return AiError(504, "PROVIDER_TIMEOUT", f"Model provider '{provider}' timed out.")


def invalid_output(task: str, detail: str) -> AiError:
    return AiError(
        422,
        "INVALID_MODEL_OUTPUT",
        f"The model output for '{task}' failed schema validation after one repair attempt.",
        {"reason": detail[:300]},
    )


def budget_exceeded(message: str) -> AiError:
    return AiError(429, "BUDGET_EXCEEDED", message)
