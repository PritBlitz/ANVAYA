import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from './generate.js';

/** Writes apps/api/openapi.json (committed; regenerate with `npm run openapi`). */
const out = fileURLToPath(new URL('../../openapi.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
process.stdout.write(`wrote ${out}\n`);
