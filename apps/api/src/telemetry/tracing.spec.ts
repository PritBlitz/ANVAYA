import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTracingSdk, samplingRatioFromEnv, traceIds, tracesExporterFromEnv, withSpan } from './tracing.js';

describe('tracing configuration', () => {
  it('is off unless an exporter is chosen explicitly', () => {
    expect(tracesExporterFromEnv({})).toBe('none');
    expect(tracesExporterFromEnv({ OTEL_TRACES_EXPORTER: 'OTLP' })).toBe('otlp');
    expect(tracesExporterFromEnv({ OTEL_TRACES_EXPORTER: 'console' })).toBe('console');
    expect(tracesExporterFromEnv({ OTEL_TRACES_EXPORTER: 'zipkin' })).toBe('none');
  });

  it('bounds the sampling ratio', () => {
    expect(samplingRatioFromEnv({})).toBe(1);
    expect(samplingRatioFromEnv({ OTEL_TRACES_SAMPLER_ARG: '0.25' })).toBe(0.25);
    expect(samplingRatioFromEnv({ OTEL_TRACES_SAMPLER_ARG: '7' })).toBe(1);
  });

  it('has no trace ids outside a span', () => {
    expect(traceIds()).toEqual({});
  });
});

describe('spans', () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor({ exporter });
  const sdk = buildTracingSdk({ serviceName: 'anvaya-test', spanProcessors: [processor] });
  // Export waits for async resource attributes, so flush before asserting.
  const finished = async () => {
    await processor.forceFlush();
    return exporter.getFinishedSpans();
  };
  beforeAll(() => sdk.start());
  afterAll(async () => sdk.shutdown());

  it('records job spans with attributes and exposes ids for log correlation', async () => {
    exporter.reset();
    let ids: ReturnType<typeof traceIds> = {};
    await withSpan('job engineering-run', { 'anvaya.run_id': 'r1' }, async () => {
      ids = traceIds();
    });
    const [span] = await finished();
    expect(span?.name).toBe('job engineering-run');
    expect(span?.attributes['anvaya.run_id']).toBe('r1');
    expect(ids.trace_id).toBe(span?.spanContext().traceId);
    expect(ids.span_id).toBe(span?.spanContext().spanId);
  });

  it('marks failed work as an error and rethrows', async () => {
    exporter.reset();
    await expect(withSpan('job repository-index', {}, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const [span] = await finished();
    expect(span?.status.code).toBe(2);
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('nests child spans under the active job span', async () => {
    exporter.reset();
    await withSpan('parent', {}, async () => {
      trace.getTracer('t').startSpan('child').end();
    });
    const spans = await finished();
    const parent = spans.find((s) => s.name === 'parent')!;
    const child = spans.find((s) => s.name === 'child')!;
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });
});
