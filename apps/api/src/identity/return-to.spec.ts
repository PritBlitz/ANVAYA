import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './auth.controller.js';

const WEB = 'http://localhost:3000';

describe('safeReturnTo (open-redirect protection)', () => {
  it('keeps same-origin relative paths, including query and hash', () => {
    expect(safeReturnTo('/app/runs/123?tab=plan#x', WEB)).toBe('/app/runs/123?tab=plan#x');
    expect(safeReturnTo('/app', WEB)).toBe('/app');
  });

  it.each([
    undefined,
    '',
    'app/runs',
    'https://evil.example/',
    '//evil.example/path',
    '/\\evil.example',
    '\\\\evil.example',
    '/app\nSet-Cookie: x=1',
    'javascript:alert(1)',
    '/%0d%0aLocation:%20https://evil.example',
  ])('falls back to /app for %j', (raw) => {
    const out = safeReturnTo(raw, WEB);
    expect(out.startsWith('/')).toBe(true);
    expect(out.startsWith('//')).toBe(false);
    expect(new URL(out, WEB).origin).toBe(WEB);
    if (raw !== '/%0d%0aLocation:%20https://evil.example') expect(out).toBe('/app');
  });
});
