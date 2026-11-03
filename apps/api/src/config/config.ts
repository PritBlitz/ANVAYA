import { readFileSync } from 'node:fs';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

/**
 * Environment schema. Validated once at boot; the process refuses to start on
 * invalid configuration. Secrets are never logged (see `describe`).
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    PUBLIC_API_URL: z.url().default('http://localhost:3001'),
    WEB_APP_URL: z.url().default('http://localhost:3000'),
    WEB_ORIGINS: csv.default(['http://localhost:3000']),
    TRUST_PROXY: bool.default(false),

    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

    SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default('anvaya_session'),
    CSRF_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default('anvaya_csrf'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
    COOKIE_SECURE: bool.default(true),
    AUTH_DEV_LOGIN_ENABLED: bool.default(false),

    GITHUB_API_URL: z.url().default('https://api.github.com'),
    GITHUB_WEB_URL: z.url().default('https://github.com'),
    GITHUB_APP_ID: z.string().regex(/^\d+$/).optional(),
    GITHUB_APP_SLUG: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
    GITHUB_WEBHOOK_SECRET: z.string().min(16).optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),

    AI_SERVICE_URL: z.url().default('http://127.0.0.1:8001'),
    AI_SERVICE_TOKEN: z.string().min(16).optional(),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(120_000),
    EMBEDDING_DIMENSION: z.coerce.number().int().default(768),

    STORAGE_DIR: z.string().default('./storage'),
    REPOSITORY_SOURCE: z.enum(['github', 'local_fixture']).default('github'),
    LOCAL_FIXTURE_ROOT: z.string().optional(),

    // Execution plane. 'disabled' makes approved runs fail explicitly (EXECUTION_NOT_AVAILABLE).
    // 'docker' is a hardened-container driver for development; 'gvisor' runs checks under gVisor
    // (runsc), the approved production boundary (SECURITY §7).
    EXECUTION_DRIVER: z.enum(['disabled', 'docker', 'gvisor']).default('disabled'),
    WORKSPACES_DIR: z.string().default('./workspaces'),
    SANDBOX_DOCKER_BIN: z.string().default('docker'),
    SANDBOX_MEMORY_MB: z.coerce.number().int().min(128).max(16384).default(1024),
    SANDBOX_CPUS: z.coerce.number().min(0.25).max(8).default(1),
    SANDBOX_PIDS_LIMIT: z.coerce.number().int().min(16).max(4096).default(256),
    SANDBOX_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
    SANDBOX_OUTPUT_LIMIT_BYTES: z.coerce.number().int().min(1024).max(10_000_000).default(1_000_000),
    /** B-4: allow a networked, no-code-execution dependency fetch step before dependency profiles. */
    SANDBOX_DEPENDENCY_FETCH: z.enum(['disabled', 'enabled']).default('disabled'),
    /** Docker network for the fetch step; point it at an egress-restricted network in shared environments. */
    SANDBOX_FETCH_NETWORK: z.string().regex(/^[A-Za-z0-9_.-]+$/).default('bridge'),
    /** Optional HTTP(S) proxy for the fetch step (egress allowlist). */
    SANDBOX_FETCH_PROXY: z.url().optional(),
    SANDBOX_FETCH_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
    /** gVisor driver: the runsc binary, extra leading argv (e.g. a wsl wrapper in development), and its directories. */
    SANDBOX_RUNSC_BIN: z.string().default('runsc'),
    SANDBOX_RUNSC_PREFIX_ARGS: z
      .string()
      .default('[]')
      .transform((v, ctx) => {
        try {
          const parsed: unknown = JSON.parse(v);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
        } catch {
          /* reported below */
        }
        ctx.addIssue({ code: 'custom', message: 'must be a JSON array of strings' });
        return z.NEVER;
      }),
    /** One provisioned root filesystem per image (scripts/sandbox/prepare-rootfs.sh). */
    SANDBOX_ROOTFS_DIR: z.string().default('./sandbox/rootfs'),
    /** Per-run OCI bundles and runsc state. */
    SANDBOX_STATE_DIR: z.string().default('./sandbox/run'),
    SANDBOX_GVISOR_PLATFORM: z.enum(['systrap', 'ptrace', 'kvm']).default('systrap'),
    SANDBOX_RUNSC_ROOTLESS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** 'wsl' maps Windows paths (Z:\x) to /mnt/z/x for a development worker that runs runsc inside WSL. */
    SANDBOX_PATH_STYLE: z.enum(['native', 'wsl']).default('native'),
    /** The fetch step's network under gVisor. Refused unless 'host' (pair it with SANDBOX_FETCH_PROXY). */
    SANDBOX_GVISOR_FETCH_NETWORK: z.enum(['disabled', 'host']).default('disabled'),

    /** Enables GET /api/v1/internal/metrics (bearer token). Unset = disabled. */
    METRICS_TOKEN: z.string().min(16).optional(),
    /** Worker metrics on 127.0.0.1:<port>/metrics. Unset = disabled. */
    WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),

    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_DEFAULT_MAX: z.coerce.number().int().min(1).default(300),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_DEV_LOGIN_ENABLED) {
        ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_LOGIN_ENABLED'], message: 'dev login must be disabled in production' });
      }
      if (!env.COOKIE_SECURE) {
        ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'secure cookies are required in production' });
      }
      if (env.REPOSITORY_SOURCE !== 'github') {
        ctx.addIssue({ code: 'custom', path: ['REPOSITORY_SOURCE'], message: 'local_fixture is not allowed in production' });
      }
      if (env.EXECUTION_DRIVER === 'gvisor' && env.SANDBOX_PATH_STYLE !== 'native') {
        ctx.addIssue({ code: 'custom', path: ['SANDBOX_PATH_STYLE'], message: 'the WSL path mapping is for development workers only' });
      }
      if (env.EXECUTION_DRIVER === 'gvisor' && env.SANDBOX_GVISOR_FETCH_NETWORK === 'host' && !env.SANDBOX_FETCH_PROXY) {
        ctx.addIssue({ code: 'custom', path: ['SANDBOX_FETCH_PROXY'], message: 'a networked fetch step under gVisor requires an egress-allowlisting proxy in production' });
      }
      if (env.EXECUTION_DRIVER === 'docker' && process.env.ANVAYA_ALLOW_CONTAINER_SANDBOX_IN_PRODUCTION !== 'true') {
        ctx.addIssue({ code: 'custom', path: ['EXECUTION_DRIVER'], message: 'container sandbox is not an approved production boundary (SECURITY §7)' });
      }
      if (!env.AI_SERVICE_TOKEN) {
        ctx.addIssue({ code: 'custom', path: ['AI_SERVICE_TOKEN'], message: 'internal AI service token is required in production' });
      }
    }
    if (env.REPOSITORY_SOURCE === 'local_fixture' && !env.LOCAL_FIXTURE_ROOT) {
      ctx.addIssue({ code: 'custom', path: ['LOCAL_FIXTURE_ROOT'], message: 'required when REPOSITORY_SOURCE=local_fixture' });
    }
    if (env.EMBEDDING_DIMENSION !== 768) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMBEDDING_DIMENSION'],
        message: 'schema column is vector(768); changing dimension requires a migration and re-embedding',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface GithubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

export class AppConfig {
  readonly env: Env;

  constructor(source: NodeJS.ProcessEnv = process.env) {
    // Treat empty values (`KEY=` in .env files) as unset so optional settings and defaults apply.
    const normalized = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));
    const parsed = envSchema.safeParse(normalized);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid configuration: ${issues}`);
    }
    this.env = parsed.data;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  /** GitHub App credentials, or null when the integration is not configured. */
  githubApp(): GithubAppCredentials | null {
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_PATH } = this.env;
    if (!GITHUB_APP_ID) return null;
    let pem = GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!pem && GITHUB_APP_PRIVATE_KEY_PATH) pem = readFileSync(GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
    if (!pem) return null;
    return { appId: GITHUB_APP_ID, privateKeyPem: pem };
  }

  /** Non-secret summary for startup logs. */
  describe(): Record<string, unknown> {
    const e = this.env;
    return {
      nodeEnv: e.NODE_ENV,
      port: e.PORT,
      webOrigins: e.WEB_ORIGINS,
      devLogin: e.AUTH_DEV_LOGIN_ENABLED,
      githubAppConfigured: Boolean(e.GITHUB_APP_ID),
      githubOAuthConfigured: Boolean(e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET),
      webhookSecretConfigured: Boolean(e.GITHUB_WEBHOOK_SECRET),
      aiServiceUrl: e.AI_SERVICE_URL,
      repositorySource: e.REPOSITORY_SOURCE,
      executionDriver: e.EXECUTION_DRIVER,
      dependencyFetch: e.SANDBOX_DEPENDENCY_FETCH,
    };
  }
}
