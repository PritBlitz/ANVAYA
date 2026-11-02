import { createRootLogger } from '../common/logger.js';
import { AppConfig } from '../config/config.js';
import { createPool } from './database.service.js';
import { migrate } from './migrator.js';

const config = new AppConfig();
const log = createRootLogger(config.env.LOG_LEVEL, 'anvaya-migrate');
const pool = createPool(config.env.DATABASE_URL, 1);

try {
  const result = await migrate(pool);
  log.info({ applied: result.applied, already_applied: result.alreadyApplied.length }, 'migrations complete');
} catch (err) {
  log.error({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
