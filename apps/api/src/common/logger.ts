import { pino, type Logger } from 'pino';
import { traceIds } from '../telemetry/tracing.js';
import { requestContext } from './request-context.js';

/** Keys whose values are always redacted from structured logs. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  '*.private_key',
  '*.secret',
  '*.api_key',
];

let root: Logger | undefined;

export function createRootLogger(level: string, service = 'anvaya-api'): Logger {
  root = pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const rid = requestContext.requestId();
      return { ...(rid ? { request_id: rid } : {}), ...traceIds() };
    },
  });
  return root;
}

/** Service name from the entrypoint, so module-level loggers created before bootstrap are labelled correctly. */
function defaultServiceName(): string {
  const entry = process.argv[1] ?? '';
  if (entry.includes('main.worker')) return 'anvaya-worker';
  if (entry.includes('migrate.cli')) return 'anvaya-migrate';
  return 'anvaya-api';
}

export function rootLogger(): Logger {
  root ??= createRootLogger(process.env.LOG_LEVEL ?? 'info', defaultServiceName());
  return root;
}

export function logger(component: string): Logger {
  return rootLogger().child({ component });
}
