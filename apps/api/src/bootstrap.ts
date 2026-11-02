import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { type Request } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { AppModule } from './app.module.js';
import { requestIdMiddleware } from './common/http.js';
import { rootLogger } from './common/logger.js';
import { AppConfig } from './config/config.js';

export const API_PREFIX = 'api/v1';
export const JSON_BODY_LIMIT = '1mb';
/** GitHub caps webhook payloads at 25 MB. */
export const WEBHOOK_BODY_LIMIT = '25mb';

export type RawBodyRequest = Request & { rawBody?: Buffer };

/** Builds a fully configured (not yet listening) application. Shared by main and tests. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: false });
  configureApp(app);
  await app.init();
  return app;
}

export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfig);
  const log = rootLogger();

  app.set('trust proxy', config.env.TRUST_PROXY ? 1 : false);
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req) => (req as RawBodyRequest & { requestId?: string }).requestId ?? 'unknown',
      autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/v1/health') },
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({ method: req.method, url: req.url.split('?')[0], id: req.id }),
      },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  // Webhooks need the exact raw bytes for HMAC verification.
  app.use(
    `/${API_PREFIX}/webhooks`,
    express.raw({ type: '*/*', limit: WEBHOOK_BODY_LIMIT }),
    (req: RawBodyRequest, _res: unknown, next: () => void) => {
      if (Buffer.isBuffer(req.body)) req.rawBody = req.body;
      next();
    },
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true, type: ['application/json', 'application/*+json'] }));
  app.use(cookieParser());
  app.enableCors({
    origin: (origin, cb) => cb(null, !origin || config.env.WEB_ORIGINS.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id', 'Idempotency-Key', 'Last-Event-ID'],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'Idempotent-Replayed'],
    maxAge: 600,
  });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
}
