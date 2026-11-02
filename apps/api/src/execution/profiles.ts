/**
 * Server-defined verification profiles (SECURITY §7 command execution policy).
 * The model never supplies a command: a profile id maps to a fixed, pinned
 * image and a fixed argv. Profiles run with network disabled, so they must not
 * need to download dependencies.
 */

export interface VerificationProfile {
  id: string;
  description: string;
  /** Image pinned by digest. */
  image: string;
  argv: readonly string[];
  /** Shown to users; never executed. */
  commandDisplay: string;
  /** Repository files whose presence makes this profile applicable. */
  detect: (paths: ReadonlySet<string>) => boolean;
}

const PYTHON_IMAGE = 'python:3.12-alpine@sha256:e6dae589c1c05976188fd3bd019afd091445fc533ed2ea29001beddc7368a9c8';
const NODE_IMAGE = 'node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914';

const hasExt = (paths: ReadonlySet<string>, ext: string) => [...paths].some((p) => p.endsWith(ext));

export const PROFILES: readonly VerificationProfile[] = [
  {
    id: 'python-compile',
    description: 'Byte-compile every Python file (syntax check)',
    image: PYTHON_IMAGE,
    argv: ['python', '-B', '-m', 'compileall', '-q', '.'],
    commandDisplay: 'python -m compileall -q .',
    detect: (p) => hasExt(p, '.py'),
  },
  {
    id: 'python-unittest',
    description: 'Run the standard-library unittest suite',
    image: PYTHON_IMAGE,
    argv: ['python', '-B', '-m', 'unittest', 'discover', '-v'],
    commandDisplay: 'python -m unittest discover -v',
    detect: (p) => [...p].some((f) => /(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.py$/.test(f)),
  },
  {
    id: 'node-syntax',
    description: 'Parse every JavaScript file with node --check',
    image: NODE_IMAGE,
    argv: ['sh', '-c', 'find . -path ./node_modules -prune -o \\( -name "*.js" -o -name "*.mjs" -o -name "*.cjs" \\) -type f -print0 | xargs -0 -r -n1 node --check'],
    commandDisplay: 'node --check <each .js/.mjs/.cjs file>',
    detect: (p) => hasExt(p, '.js') || hasExt(p, '.mjs') || hasExt(p, '.cjs'),
  },
  {
    id: 'node-test',
    description: 'Run the Node.js built-in test runner (no dependency installation)',
    image: NODE_IMAGE,
    argv: ['node', '--test'],
    commandDisplay: 'node --test',
    detect: (p) => [...p].some((f) => /\.test\.(m|c)?js$/.test(f)),
  },
];

export const PROFILE_IDS = PROFILES.map((p) => p.id);

export function profileById(id: string): VerificationProfile | undefined {
  return PROFILES.find((p) => p.id === id);
}

/** Profiles configured on the repository, or auto-detected from its files. */
export function selectProfiles(configured: readonly string[] | undefined, paths: ReadonlySet<string>): VerificationProfile[] {
  if (configured && configured.length > 0) return configured.map(profileById).filter((p): p is VerificationProfile => p !== undefined);
  return PROFILES.filter((p) => p.detect(paths));
}

export interface UnavailableCheck {
  profile_id: string;
  reason: string;
}

const NEEDS_DEPENDENCIES = 'needs project dependencies installed; the sandbox has no network access and dependency installation is not supported yet';

/**
 * Checks a repository evidently uses but that no server-defined profile can run
 * (FR-VER-005: report "unavailable" separately, never as passed). Derived only
 * from file paths; repository content is never executed or interpreted here.
 */
export function unavailableChecks(paths: ReadonlySet<string>): UnavailableCheck[] {
  const has = (re: RegExp) => [...paths].some((p) => re.test(p));
  const out: UnavailableCheck[] = [];
  const hasPackageJson = has(/(^|\/)package\.json$/);
  if (has(/\.(ts|tsx|mts|cts)$/)) out.push({ profile_id: 'typescript-typecheck', reason: `TypeScript type checking ${NEEDS_DEPENDENCIES}` });
  if (hasPackageJson) out.push({ profile_id: 'npm-test', reason: `The package.json test script ${NEEDS_DEPENDENCIES}` });
  if (has(/(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|Pipfile|poetry\.lock)$/)) {
    out.push({ profile_id: 'python-dependencies', reason: `Tests importing third-party Python packages (e.g. pytest) ${NEEDS_DEPENDENCIES}` });
  }
  if (has(/(^|\/)go\.mod$/)) out.push({ profile_id: 'go-test', reason: 'No verification profile exists for Go yet' });
  if (has(/(^|\/)Cargo\.toml$/)) out.push({ profile_id: 'cargo-test', reason: 'No verification profile exists for Rust yet' });
  if (has(/(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/)) out.push({ profile_id: 'jvm-build', reason: 'No verification profile exists for JVM builds yet' });
  return out;
}
