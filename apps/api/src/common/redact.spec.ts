import { describe, expect, it } from 'vitest';
import { boundText, redactText, redactValue } from './redact.js';

describe('redaction', () => {
  it('redacts common credential formats', () => {
    const input = [
      'token ghp_' + 'a'.repeat(36),
      'aws AKIAABCDEFGHIJKLMNOP',
      'key sk-ant-' + 'b'.repeat(30),
      'password=hunter2hunter2',
      'postgres://user:supersecret@db:5432/x',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactText(input);
    expect(out).not.toContain('ghp_aaaa');
    expect(out).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(out).not.toContain('sk-ant-bbbb');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('supersecret');
    expect(out).not.toContain('MIIabc');
  });

  it('redacts sensitive keys recursively', () => {
    const out = redactValue({ nested: { api_key: 'abc', note: 'ok', list: [{ client_secret: 'x' }] } });
    expect(out).toEqual({ nested: { api_key: '[REDACTED]', note: 'ok', list: [{ client_secret: '[REDACTED]' }] } });
  });

  it('bounds text by bytes and marks truncation', () => {
    expect(boundText('abc', 10)).toEqual({ text: 'abc', truncated: false });
    const r = boundText('x'.repeat(100), 10);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('x'.repeat(10))).toBe(true);
  });
});
