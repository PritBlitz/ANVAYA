import { type DependencySpec, npmSpec, pipSpec } from './dependencies.js';

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
  /** Third-party dependencies installed by a separate fetch step first (B-4). Only offered when dependency fetching is enabled. */
  dependencies?: DependencySpec;
  /**
   * Heuristic test selection support: which repository paths this runner accepts as test-file
   * arguments, and the argv to run only those files. Paths are indexed repository paths (never
   * model output), passed as separate argv elements (no shell).
   */
  testSelection?: { pattern: RegExp; argv: (files: readonly string[]) => readonly string[] };
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
    testSelection: { pattern: /(^|\/)(test_[^/]+|[^/]+_test)\.py$/, argv: (files) => ['python', '-B', '-m', 'unittest', '-v', ...files] },
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
    testSelection: { pattern: /\.test\.(m|c)?js$/, argv: (files) => ['node', '--test', ...files] },
  },
  {
    id: 'npm-test',
    description: 'Install locked npm dependencies (no install scripts), then run the package.json test script offline',
    image: NODE_IMAGE,
    argv: ['npm', 'test', '--offline', '--no-update-notifier'],
    commandDisplay: 'npm ci --ignore-scripts (fetch) → npm test (offline)',
    detect: (p) => p.has('package.json') && p.has('package-lock.json'),
    dependencies: npmSpec(NODE_IMAGE),
  },
  {
    id: 'python-pytest',
    description: 'Install wheel-only requirements, then run pytest offline',
    image: PYTHON_IMAGE,
    argv: ['python', '-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider'],
    testSelection: { pattern: /(^|\/)(test_[^/]+|[^/]+_test)\.py$/, argv: (files) => ['python', '-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--', ...files] },
    commandDisplay: 'pip install --only-binary=:all: -r requirements*.txt (fetch) → python -m pytest (offline)',
    detect: (p) => [...p].some((f) => /^requirements(-dev|-test)?\.txt$/.test(f)),
    dependencies: pipSpec(PYTHON_IMAGE),
  },
];

export const PROFILE_IDS = PROFILES.map((p) => p.id);

export function profileById(id: string): VerificationProfile | undefined {
  return PROFILES.find((p) => p.id === id);
}

/** Profiles configured on the repository, or auto-detected from its files. Dependency profiles need fetching enabled. */
export function selectProfiles(configured: readonly string[] | undefined, paths: ReadonlySet<string>, opts: { dependencyFetch?: boolean } = {}): VerificationProfile[] {
  const allowed = (p: VerificationProfile) => !p.dependencies || opts.dependencyFetch === true;
  if (configured && configured.length > 0) return configured.map(profileById).filter((p): p is VerificationProfile => p !== undefined && allowed(p));
  return PROFILES.filter((p) => allowed(p) && p.detect(paths));
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
export function unavailableChecks(paths: ReadonlySet<string>, opts: { dependencyFetch?: boolean } = {}): UnavailableCheck[] {
  const has = (re: RegExp) => [...paths].some((p) => re.test(p));
  const out: UnavailableCheck[] = [];
  const hasPackageJson = has(/(^|\/)package\.json$/);
  const fetch = opts.dependencyFetch === true;
  if (has(/\.(ts|tsx|mts|cts)$/)) out.push({ profile_id: 'typescript-typecheck', reason: `TypeScript type checking ${NEEDS_DEPENDENCIES}` });
  if (hasPackageJson && !(fetch && paths.has('package.json') && paths.has('package-lock.json'))) {
    out.push({ profile_id: 'npm-test', reason: fetch ? 'npm dependencies can only be installed from a root package-lock.json' : `The package.json test script ${NEEDS_DEPENDENCIES}` });
  }
  const pyManifests = has(/(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|Pipfile|poetry\.lock)$/);
  if (pyManifests && !(fetch && has(/^requirements(-dev|-test)?\.txt$/))) {
    out.push({
      profile_id: 'python-dependencies',
      reason: fetch ? 'Python dependencies can only be installed from root requirements.txt / requirements-dev.txt / requirements-test.txt' : `Tests importing third-party Python packages (e.g. pytest) ${NEEDS_DEPENDENCIES}`,
    });
  }
  if (has(/(^|\/)go\.mod$/)) out.push({ profile_id: 'go-test', reason: 'No verification profile exists for Go yet' });
  if (has(/(^|\/)Cargo\.toml$/)) out.push({ profile_id: 'cargo-test', reason: 'No verification profile exists for Rust yet' });
  if (has(/(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/)) out.push({ profile_id: 'jvm-build', reason: 'No verification profile exists for JVM builds yet' });
  return out;
}
