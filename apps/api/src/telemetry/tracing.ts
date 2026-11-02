/**
 * OpenTelemetry tracing (B-6). Off unless OTEL_TRACES_EXPORTER is `otlp` or
 * `console`. Must be started before the application modules are imported so
 * the ESM loader hook can instrument pg/ioredis/express (see main.ts).
 *
 * Standard OTel environment variables apply: OTEL_EXPORTER_OTLP_ENDPOINT
 * (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT), OTEL_EXPORTER_OTLP_HEADERS,
 * OTEL_TRACES_SAMPLER_ARG (head-sampling ratio, default 1), OTEL_SERVICE_NAME.
 *
 * Privacy: SQL statements are recorded without parameter values, HTTP spans
 * carry no headers or bodies, and only W3C trace context is propagated.
 */
import { register } from 'node:module';
import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, ConsoleSpanExporter, ParentBasedSampler, type SpanExporter, type SpanProcessor, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace';

export type TracesExporter = 'none' | 'otlp' | 'console';

const IGNORED_PATHS = [/^\/api\/v1\/health\//, /^\/api\/v1\/internal\/metrics/, /^\/metrics$/];

let sdk: NodeSDK | undefined;

export function tracesExporterFromEnv(env: NodeJS.ProcessEnv = process.env): TracesExporter {
  const v = (env.OTEL_TRACES_EXPORTER ?? 'none').trim().toLowerCase();
  if (v === 'otlp' || v === 'console') return v;
  return 'none';
}

export function samplingRatioFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OTEL_TRACES_SAMPLER_ARG ?? '1');
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
}

export function buildTracingSdk(opts: { serviceName: string; exporter?: SpanExporter; spanProcessors?: SpanProcessor[]; ratio?: number }): NodeSDK {
  return new NodeSDK({
    serviceName: opts.serviceName,
    spanProcessors: opts.spanProcessors ?? (opts.exporter ? [new BatchSpanProcessor({ exporter: opts.exporter })] : []),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(opts.ratio ?? 1) }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => IGNORED_PATHS.some((re) => re.test(req.url ?? '')),
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      // Command name only: keys can embed client IPs or ids (e.g. rate-limit buckets).
      new IORedisInstrumentation({ dbStatementSerializer: (cmd) => cmd }),
      new UndiciInstrumentation(),
    ],
  });
}

/** Starts tracing when configured. Returns true if an exporter is active. */
export function startTracing(serviceName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const kind = tracesExporterFromEnv(env);
  if (kind === 'none' || sdk) return Boolean(sdk);
  // ESM modules (and CJS packages imported from ESM) are only instrumentable through the loader hook.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  const exporter = kind === 'console' ? new ConsoleSpanExporter() : new OTLPTraceExporter();
  sdk = buildTracingSdk({ serviceName: env.OTEL_SERVICE_NAME ?? serviceName, exporter, ratio: samplingRatioFromEnv(env) });
  sdk.start();
  const stop = () => {
    void sdk?.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return true;
}

export async function stopTracing(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

/** Active trace/span ids for log correlation (empty when tracing is off or no span is active). */
export function traceIds(): { trace_id?: string; span_id?: string } {
  const span = trace.getSpan(context.active());
  const ctx = span?.spanContext();
  if (!ctx || !trace.isSpanContextValid(ctx)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/** Runs `fn` inside an active span, recording errors. No-op overhead when tracing is off. */
export async function withSpan<T>(name: string, attributes: Record<string, string | number | boolean>, fn: (span: Span) => Promise<T>): Promise<T> {
  return trace.getTracer('anvaya').startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
