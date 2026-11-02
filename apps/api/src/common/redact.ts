/**
 * Best-effort secret redaction for text that leaves a trust boundary
 * (logs, prompts, persisted tool traces, sandbox output). It is defence in
 * depth, not a guarantee; secrets must also be excluded at the source.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY_ID]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi, '$1[REDACTED]'],
  [/(postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/[^:\s/]+:[^@\s]+@/gi, '$1://[REDACTED]@'],
];

const SENSITIVE_KEY = /secret|password|token|private_key|api_key|authorization|cookie/i;

export function redactText(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Recursively redact strings inside a JSON-compatible value. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactValue(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && typeof v === 'string' ? '[REDACTED]' : redactValue(v);
    }
    return out as T;
  }
  return value;
}

/** Truncate to a byte budget, marking truncation explicitly. */
export function boundText(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(input, 'utf8');
  if (buf.length <= maxBytes) return { text: input, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString('utf8') + '\n…[truncated]', truncated: true };
}
