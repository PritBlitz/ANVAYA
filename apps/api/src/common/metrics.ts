/**
 * Minimal Prometheus-format metrics registry (scrapable directly or via the
 * OpenTelemetry Collector's prometheus receiver). Label values are bounded
 * (route templates, enum-like codes) — never ids or user content.
 */

type Labels = Record<string, string>;

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    .join(',');
}

class Counter {
  readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

class Histogram {
  readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  observe(labels: Labels, seconds: number): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) s.counts[i]!++;
    });
    s.sum += seconds;
    s.count++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? ',' : '';
      BUCKETS.forEach((b, i) => lines.push(`${this.name}_bucket{${k}${sep}le="${b}"} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket{${k}${sep}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export const metrics = {
  httpRequests: new Counter('anvaya_http_requests_total', 'HTTP requests by route template, method and status class'),
  httpDuration: new Histogram('anvaya_http_request_duration_seconds', 'HTTP request duration'),
  modelCalls: new Counter('anvaya_model_calls_total', 'Model calls by task, mode, provider and outcome'),
  modelDuration: new Histogram('anvaya_model_call_duration_seconds', 'Model call latency'),
  modelTokens: new Counter('anvaya_model_tokens_total', 'Model tokens by provider and direction'),
  sandboxRuns: new Counter('anvaya_sandbox_runs_total', 'Sandbox verification runs by profile and status'),
  sandboxDuration: new Histogram('anvaya_sandbox_run_duration_seconds', 'Sandbox run duration'),
  indexingJobs: new Counter('anvaya_indexing_jobs_total', 'Indexing jobs by outcome'),
  runTransitions: new Counter('anvaya_run_transitions_total', 'Workflow run transitions by target status'),
};

export function renderMetrics(): string {
  const mem = process.memoryUsage();
  const proc = [
    '# HELP anvaya_process_resident_memory_bytes Resident memory',
    '# TYPE anvaya_process_resident_memory_bytes gauge',
    `anvaya_process_resident_memory_bytes ${mem.rss}`,
    '# HELP anvaya_process_uptime_seconds Process uptime',
    '# TYPE anvaya_process_uptime_seconds gauge',
    `anvaya_process_uptime_seconds ${process.uptime()}`,
  ].join('\n');
  return `${Object.values(metrics)
    .map((m) => m.render())
    .join('\n')}\n${proc}\n`;
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}
