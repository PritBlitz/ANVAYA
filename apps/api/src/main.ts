import { createApp } from './bootstrap.js';
import { createRootLogger } from './common/logger.js';
import { AppConfig } from './config/config.js';

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
