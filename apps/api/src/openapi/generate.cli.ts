import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from './generate.js';

/**
 * Writes the OpenAPI document (committed; regenerate with `npm run openapi`) to:
 *   apps/api/openapi.json             read by the API's own contract and security tests
 *   packages/contracts/openapi.json   the shared contract the web app generates its types from
 * CI fails if either copy differs from what the code produces.
 */
const doc = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
const targets = [new URL('../../openapi.json', import.meta.url), new URL('../../../../packages/contracts/openapi.json', import.meta.url)];
for (const target of targets) {
  const out = fileURLToPath(target);
  // The contracts package exists in the monorepo checkout, not inside the API's container build.
  if (!existsSync(fileURLToPath(new URL('.', target)))) continue;
  writeFileSync(out, doc);
  process.stdout.write(`wrote ${out}\n`);
}
