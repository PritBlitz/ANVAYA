import { startTracing } from './telemetry/tracing.js';

// Tracing must start before the application modules load so they can be instrumented.
startTracing('anvaya-api');

const { createApp } = await import('./bootstrap.js');
const { createRootLogger } = await import('./common/logger.js');
const { AppConfig } = await import('./config/config.js');

const config = new AppConfig();
const log = createRootLogger(config.env.LOG_LEVEL, 'anvaya-api');

try {
  const app = await createApp();
  await app.listen(config.env.PORT, '0.0.0.0');
  log.info({ config: config.describe() }, 'anvaya api listening');
} catch (err) {
  log.fatal({ err }, 'failed to start api');
  process.exit(1);
}
