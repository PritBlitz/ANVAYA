import { describe, expect, it } from 'vitest';
import { AppConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://x', AI_SERVICE_TOKEN: 'x'.repeat(20) };

describe('configuration validation', () => {
  it('applies safe defaults', () => {
    const c = new AppConfig({ ...base });
    expect(c.env.COOKIE_SECURE).toBe(true);
    expect(c.env.AUTH_DEV_LOGIN_ENABLED).toBe(false);
  });

  it('refuses dev login, insecure cookies and fixture sources in production', () => {
    expect(() => new AppConfig({ ...base, NODE_ENV: 'production', AUTH_DEV_LOGIN_ENABLED: 'true' })).toThrow(/AUTH_DEV_LOGIN_ENABLED/);
    expect(() => new AppConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => new AppConfig({ ...base, NODE_ENV: 'production', REPOSITORY_SOURCE: 'local_fixture', LOCAL_FIXTURE_ROOT: '/x' })).toThrow(/REPOSITORY_SOURCE/);
    expect(() => new AppConfig({ DATABASE_URL: 'postgres://x', NODE_ENV: 'production' })).toThrow(/AI_SERVICE_TOKEN/);
  });

  it('does not include secrets in the startup description', () => {
    const c = new AppConfig({ ...base, GITHUB_CLIENT_SECRET: 'very-secret-value', GITHUB_WEBHOOK_SECRET: 'w'.repeat(20) });
    expect(JSON.stringify(c.describe())).not.toContain('very-secret-value');
    expect(JSON.stringify(c.describe())).not.toContain('wwwww');
  });

  it('treats empty values as unset', () => {
    const c = new AppConfig({ ...base, GITHUB_APP_ID: '', PORT: '  ' });
    expect(c.env.GITHUB_APP_ID).toBeUndefined();
    expect(c.env.PORT).toBe(3001);
  });

  it('rejects an embedding dimension that does not match the schema', () => {
    expect(() => new AppConfig({ ...base, EMBEDDING_DIMENSION: '1024' })).toThrow(/vector\(768\)/);
  });
});
