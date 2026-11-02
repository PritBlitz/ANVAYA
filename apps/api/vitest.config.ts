import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://anvaya:anvaya_local_only@127.0.0.1:5433/anvaya_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/response-contract.ts'],
    environment: 'node',
    // Integration suites share one test database; run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
      COOKIE_SECURE: 'false',
      AUTH_DEV_LOGIN_ENABLED: 'true',
      WEB_ORIGINS: 'http://localhost:3000',
      GITHUB_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
      AI_SERVICE_URL: 'http://127.0.0.1:59999',
      AI_SERVICE_TOKEN: 'test-internal-token-0123456789',
      RATE_LIMIT_DEFAULT_MAX: '10000',
      STORAGE_DIR: './.test-storage',
    },
  },
});
