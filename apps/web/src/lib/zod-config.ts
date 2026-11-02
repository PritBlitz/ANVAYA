import { z } from "zod";

/**
 * Zod probes `new Function` to decide whether to JIT-compile parsers. Under our CSP
 * (no 'unsafe-eval') the probe is caught but still reported as a CSP violation, so
 * use the interpreter. Imported first by the client root.
 */
z.config({ jitless: true });
