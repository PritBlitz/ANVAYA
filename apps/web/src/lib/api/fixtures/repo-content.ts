/**
 * DEVELOPMENT FIXTURE — source files for demo repositories.
 * Used only by the fixture adapter so that search, citations, file viewing, and diffs
 * operate on real, line-addressable content. Never imported by production code paths.
 */

export interface FixtureFile {
  path: string;
  language: string | null;
  content: string;
  excluded?: string; // exclusion reason
}

const refreshTs = `import { TokenStore } from "./token-store";
import { decodeJwt, isExpired } from "./token";
import { http } from "../lib/http";
import { logger } from "../lib/logger";

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Exchanges a refresh token for a new access/refresh token pair.
 * The identity provider rotates refresh tokens: each refresh token is single-use.
 */
export async function refreshSession(store: TokenStore): Promise<RefreshResult> {
  const current = await store.read();
  if (!current) {
    throw new Error("No session to refresh");
  }

  if (!isExpired(current.accessToken, 30)) {
    return current;
  }

  // NOTE: concurrent callers each issue their own refresh request.
  const response = await http.post<RefreshResult>("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
  });

  if (response.status === 400) {
    logger.warn("refresh rejected", { reason: response.data });
    await store.clear();
    throw new Error("Session expired");
  }

  const next = response.data;
  const claims = decodeJwt(next.accessToken);
  await store.write({ ...next, expiresAt: claims.exp * 1000 });
  return next;
}

export async function getAccessToken(store: TokenStore): Promise<string> {
  const session = await refreshSession(store);
  return session.accessToken;
}
`;

const tokenTs = `export interface JwtClaims {
  sub: string;
  exp: number;
  iat: number;
  scope?: string;
}

export function decodeJwt(token: string): JwtClaims {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("Malformed token");
  }
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json) as JwtClaims;
}

/**
 * Returns true when the token expires within \`skewSeconds\`.
 * Refresh token expiry is handled by the identity provider, not here.
 */
export function isExpired(token: string, skewSeconds = 0): boolean {
  const { exp } = decodeJwt(token);
  const now = Math.floor(Date.now() / 1000);
  return exp - skewSeconds <= now;
}
`;

const tokenStoreTs = `export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface TokenStore {
  read(): Promise<StoredSession | null>;
  write(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private session: StoredSession | null = null;

  async read() {
    return this.session;
  }

  async write(session: StoredSession) {
    this.session = session;
  }

  async clear() {
    this.session = null;
  }
}
`;

const chargeTs = `import { http } from "../lib/http";
import { Money, roundMinor } from "./money";

export interface ChargeRequest {
  customerId: string;
  amount: Money;
  description?: string;
}

export interface Charge {
  id: string;
  status: "pending" | "succeeded" | "failed";
  amount: Money;
}

/**
 * Creates a charge with the payment processor.
 * Retries on network failure. The processor supports idempotency keys,
 * but this client does not send one yet.
 */
export async function createCharge(request: ChargeRequest, attempt = 0): Promise<Charge> {
  const amount = { ...request.amount, minor: roundMinor(request.amount) };
  try {
    const response = await http.post<Charge>("/v1/charges", {
      customer: request.customerId,
      amount: amount.minor,
      currency: amount.currency,
      description: request.description,
    });
    return response.data;
  } catch (error) {
    if (attempt < 2) {
      return createCharge(request, attempt + 1);
    }
    throw error;
  }
}
`;

const moneyTs = `export interface Money {
  currency: "USD" | "EUR" | "JPY" | "INR";
  minor: number;
}

const DECIMALS: Record<Money["currency"], number> = { USD: 2, EUR: 2, JPY: 0, INR: 2 };

export function roundMinor(money: Money): number {
  const factor = 10 ** DECIMALS[money.currency];
  return Math.round((money.minor / factor) * factor);
}

export function format(money: Money, locale = "en-US"): string {
  const decimals = DECIMALS[money.currency];
  return new Intl.NumberFormat(locale, { style: "currency", currency: money.currency }).format(
    money.minor / 10 ** decimals,
  );
}
`;

const webhooksTs = `import crypto from "node:crypto";
import type { Request, Response } from "express";
import { logger } from "../lib/logger";

const SIGNATURE_HEADER = "x-processor-signature";
const TOLERANCE_SECONDS = 300;

export function verifySignature(rawBody: Buffer, header: string, secret: string): boolean {
  const [timestamp, signature] = header.split(",");
  if (!timestamp || !signature) return false;
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (age > TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac("sha256", secret).update(\`\${timestamp}.\${rawBody}\`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export async function handleWebhook(req: Request, res: Response) {
  const header = req.header(SIGNATURE_HEADER);
  if (!header || !verifySignature(req.body as Buffer, header, process.env.WEBHOOK_SECRET ?? "")) {
    res.status(401).end();
    return;
  }
  const event = JSON.parse((req.body as Buffer).toString("utf8"));
  logger.info("webhook received", { type: event.type, id: event.id });
  res.status(204).end();
}
`;

const httpTs = `export interface HttpResponse<T> {
  status: number;
  data: T;
}

const BASE_URL = process.env.PROCESSOR_URL ?? "https://processor.example";

async function request<T>(method: string, path: string, body?: unknown): Promise<HttpResponse<T>> {
  const response = await fetch(\`\${BASE_URL}\${path}\`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T;
  return { status: response.status, data };
}

export const http = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
};
`;

const loggerTs = `type Level = "debug" | "info" | "warn" | "error";

function log(level: Level, message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, message, ...fields, ts: new Date().toISOString() });
  (level === "error" ? console.error : console.log)(line);
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => log("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => log("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => log("error", m, f),
};
`;

const refreshTest = `import { describe, expect, it, vi } from "vitest";
import { refreshSession } from "../../src/auth/refresh";
import { MemoryTokenStore } from "../../src/auth/token-store";
import { http } from "../../src/lib/http";

vi.mock("../../src/lib/http");

describe("refreshSession", () => {
  it("returns the current session when the access token is still valid", async () => {
    const store = new MemoryTokenStore();
    await store.write({ accessToken: validToken(), refreshToken: "r1", expiresAt: 0 });
    const result = await refreshSession(store);
    expect(result.refreshToken).toBe("r1");
    expect(http.post).not.toHaveBeenCalled();
  });

  it("clears the store when the provider rejects the refresh token", async () => {
    const store = new MemoryTokenStore();
    await store.write({ accessToken: expiredToken(), refreshToken: "r1", expiresAt: 0 });
    vi.mocked(http.post).mockResolvedValue({ status: 400, data: {} });
    await expect(refreshSession(store)).rejects.toThrow("Session expired");
    expect(await store.read()).toBeNull();
  });
});

function validToken() {
  return token(Math.floor(Date.now() / 1000) + 3600);
}
function expiredToken() {
  return token(Math.floor(Date.now() / 1000) - 10);
}
function token(exp: number) {
  return ["h", Buffer.from(JSON.stringify({ sub: "u", exp, iat: 0 })).toString("base64url"), "s"].join(".");
}
`;

const moneyTest = `import { describe, expect, it } from "vitest";
import { roundMinor } from "../../src/payments/money";

describe("roundMinor", () => {
  it("keeps integer minor units unchanged", () => {
    expect(roundMinor({ currency: "USD", minor: 1999 })).toBe(1999);
  });

  it("handles zero-decimal currencies", () => {
    expect(roundMinor({ currency: "JPY", minor: 500 })).toBe(500);
  });
});
`;

const readme = `# payments-api

Payment orchestration service for Acme. Handles customer sessions, charges,
and processor webhooks.

## Development

    npm install
    npm test

## Architecture

See docs/architecture.md. Authentication uses rotating refresh tokens issued by
the identity provider; every refresh token is single-use.
`;

const architectureMd = `# Architecture

## Modules

- \`src/auth\` — session refresh and token parsing. Refresh tokens rotate on every use.
- \`src/payments\` — charge creation, money arithmetic, processor webhooks.
- \`src/lib\` — HTTP client and structured logger.

## Decisions

- ADR-004: Webhooks are verified with HMAC-SHA256 over \`timestamp.body\` with a
  5 minute tolerance. Replay protection by event id is not yet implemented.
- ADR-006: Charges must be idempotent at the processor boundary.
`;

const packageJson = `{
  "name": "payments-api",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "express": "^5.1.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^4.0.0"
  }
}
`;

const pyPipeline = `from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class Feature:
    name: str
    value: float


def normalise(features: Iterable[Feature]) -> list[Feature]:
    """Scale feature values into [0, 1] using min-max normalisation."""
    items = list(features)
    if not items:
        return []
    lo = min(f.value for f in items)
    hi = max(f.value for f in items)
    span = hi - lo or 1.0
    return [Feature(f.name, (f.value - lo) / span) for f in items]
`;

const pyTrain = `import json
from pathlib import Path

from .features import Feature, normalise


def load(path: Path) -> list[Feature]:
    rows = json.loads(path.read_text())
    return [Feature(r["name"], float(r["value"])) for r in rows]


def train(path: Path) -> dict[str, float]:
    features = normalise(load(path))
    return {f.name: f.value for f in features}
`;

const notebook = `{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}`;

export const PAYMENTS_API_FILES: FixtureFile[] = [
  { path: "README.md", language: "markdown", content: readme },
  { path: "package.json", language: "json", content: packageJson },
  { path: "docs/architecture.md", language: "markdown", content: architectureMd },
  { path: "src/auth/refresh.ts", language: "typescript", content: refreshTs },
  { path: "src/auth/token.ts", language: "typescript", content: tokenTs },
  { path: "src/auth/token-store.ts", language: "typescript", content: tokenStoreTs },
  { path: "src/payments/charge.ts", language: "typescript", content: chargeTs },
  { path: "src/payments/money.ts", language: "typescript", content: moneyTs },
  { path: "src/payments/webhooks.ts", language: "typescript", content: webhooksTs },
  { path: "src/lib/http.ts", language: "typescript", content: httpTs },
  { path: "src/lib/logger.ts", language: "typescript", content: loggerTs },
  { path: "test/auth/refresh.test.ts", language: "typescript", content: refreshTest },
  { path: "test/payments/money.test.ts", language: "typescript", content: moneyTest },
  { path: ".env.example", language: null, content: "", excluded: "secret" },
  { path: "node_modules/.package-lock.json", language: null, content: "", excluded: "dependency" },
  { path: "dist/index.js", language: null, content: "", excluded: "build_output" },
];

export const ML_PIPELINE_FILES: FixtureFile[] = [
  {
    path: "README.md",
    language: "markdown",
    content: "# ml-pipeline\n\nFeature engineering and training jobs.\n",
  },
  { path: "pipeline/features.py", language: "python", content: pyPipeline },
  { path: "pipeline/train.py", language: "python", content: pyTrain },
  {
    path: "notebooks/exploration.ipynb",
    language: "jupyter",
    content: notebook,
    excluded: "unsupported_language",
  },
  { path: "models/weights.bin", language: null, content: "", excluded: "binary" },
];

export function filesForRepository(fullName: string): FixtureFile[] {
  if (fullName.endsWith("/ml-pipeline")) return ML_PIPELINE_FILES;
  return PAYMENTS_API_FILES;
}
