"""Anvaya internal AI service (ARCHITECTURE §4.3).

Owns provider adapters, prompts, output schemas and embeddings. Does NOT own
user authorization, GitHub writes, database access, filesystem or shell access.
Only the control plane calls it, authenticated with a shared bearer token.

Run: uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8001
"""

from __future__ import annotations

import hmac
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .config import Settings, get_settings
from .errors import AiError
from .generation import Providers, generate
from .schemas import EmbedRequest, EmbedResponse, GenerateRequest, GenerateResponse, HealthRequest, ProviderHealth


class JsonFormatter(logging.Formatter):
    """Structured logs. Prompts, evidence and outputs are never logged — only metadata."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
            "logger": record.name,
            "service": "anvaya-ai",
        }
        for key in ("task", "provider", "attempts", "in", "out", "request_id", "trace_id", "span_id", "path", "status", "duration_ms", "code"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        return json.dumps(payload)


def _configure_logging(level: str) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger("anvaya")
    root.handlers = [handler]
    root.setLevel(level.upper() if level.upper() in logging.getLevelNamesMapping() else "INFO")
    root.propagate = False


log = logging.getLogger("anvaya.ai")


_TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$")


def parse_traceparent(value: str | None) -> dict[str, str]:
    """W3C trace context from the control plane, for log correlation with API/worker traces (B-6)."""
    m = _TRACEPARENT.match((value or "").strip().lower())
    if not m or m.group(1) == "0" * 32:
        return {}
    return {"trace_id": m.group(1), "span_id": m.group(2)}


def create_app(settings: Settings | None = None, providers: Providers | None = None) -> FastAPI:
    settings = settings or get_settings()
    _configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.providers = providers or Providers.from_settings(settings)
        yield
        await app.state.providers.ollama_client.aclose()

    app = FastAPI(
        title="Anvaya AI Service", version="0.1.0", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan
    )
    app.state.settings = settings

    @app.middleware("http")
    async def request_context(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        rid = request.headers.get("x-request-id") or f"ai_{uuid.uuid4()}"
        trace_ctx = parse_traceparent(request.headers.get("traceparent"))
        started = time.monotonic()
        response = await call_next(request)
        response.headers["X-Request-Id"] = rid[:128]
        log.info(
            "request",
            extra={
                "request_id": rid[:128],
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": int((time.monotonic() - started) * 1000),
                **trace_ctx,
            },
        )
        return response

    @app.exception_handler(AiError)
    async def ai_error(_: Request, exc: AiError) -> JSONResponse:
        log.warning("request failed", extra={"code": exc.code, "status": exc.status})
        return JSONResponse(
            status_code=exc.status,
            content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        issues = [
            {"path": ".".join(str(p) for p in e.get("loc", [])), "message": e.get("msg", "")} for e in exc.errors()[:20]
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": {"code": "VALIDATION_FAILED", "message": "Invalid request.", "details": {"issues": issues}}
            },
        )

    @app.exception_handler(Exception)
    async def unexpected(_: Request, exc: Exception) -> JSONResponse:
        log.error("unexpected error", extra={"code": type(exc).__name__})
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "INTERNAL_ERROR", "message": "An unexpected error occurred.", "details": {}}},
        )

    def require_token(request: Request) -> None:
        expected = settings.service_token
        if expected is None:
            if settings.env == "production":
                raise AiError(401, "UNAUTHENTICATED", "Service token required.")
            return
        header = request.headers.get("authorization", "")
        provided = header[7:] if header.startswith("Bearer ") else ""
        if not hmac.compare_digest(provided.encode(), expected.encode()):
            raise AiError(401, "UNAUTHENTICATED", "Invalid service token.")

    def get_providers(request: Request) -> Providers:
        p: Providers = request.app.state.providers
        return p

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/internal/v1/generate", dependencies=[Depends(require_token)])
    async def generate_route(body: GenerateRequest, providers: Providers = Depends(get_providers)) -> GenerateResponse:  # noqa: B008
        return await generate(body, providers, settings)

    @app.post("/internal/v1/embeddings", dependencies=[Depends(require_token)])
    async def embed_route(body: EmbedRequest, providers: Providers = Depends(get_providers)) -> EmbedResponse:  # noqa: B008
        started = time.monotonic()
        res = await providers.embeddings.embed(body.texts, body.input_type)
        dims = {len(v) for v in res.vectors}
        if dims != {settings.embedding_dimension}:
            raise AiError(
                502,
                "EMBEDDING_DIMENSION_MISMATCH",
                f"Embedding model returned dimension(s) {sorted(dims)}; expected {settings.embedding_dimension}.",
            )
        return EmbedResponse(
            provider=providers.embeddings.name,
            model=res.model,
            model_version=res.model_version,
            dimension=settings.embedding_dimension,
            embeddings=res.vectors,
            usage={"input_tokens": res.input_tokens},
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    @app.post("/internal/v1/providers/health", dependencies=[Depends(require_token)])
    async def provider_health(body: HealthRequest, providers: Providers = Depends(get_providers)) -> ProviderHealth:  # noqa: B008
        try:
            provider = providers.for_mode(body.mode, body.provider)
        except AiError as exc:
            return ProviderHealth(provider=body.provider or "none", mode=body.mode, available=False, detail=exc.code)
        return await provider.health()

    return app
