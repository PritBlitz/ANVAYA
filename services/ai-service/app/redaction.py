from __future__ import annotations

import re

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
        "[REDACTED_PRIVATE_KEY]",
    ),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,255}\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "[REDACTED_AWS_KEY_ID]"),
    (re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b"), "[REDACTED_API_KEY]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "[REDACTED_JWT]"),
    (
        re.compile(r"((?:password|passwd|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*)([\"']?)[^\s\"']{6,}\2", re.I),
        r"\1[REDACTED]",
    ),
]


def redact(text: str) -> str:
    """Defence-in-depth redaction applied to evidence before it enters a prompt and to anything logged."""
    for pattern, repl in _PATTERNS:
        text = pattern.sub(repl, text)
    return text
