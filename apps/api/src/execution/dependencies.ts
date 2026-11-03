/**
 * Dependency installation for verification (B-4).
 *
 * Two phases, never mixed:
 *  1. fetch  — network ON, repository code NEVER executed: `npm ci --ignore-scripts`
 *     against a validated lockfile, or `pip install --only-binary=:all:` (wheels only,
 *     no setup.py) from validated requirements files. The workspace is mounted
 *     read-only; downloads land in a per-run dependency directory.
 *  2. test   — the normal sandbox (network OFF) with that directory mounted read-only.
 *
 * Before any fetch, the manifests are validated on the host so a repository cannot
 * point the fetcher at arbitrary hosts (lockfile `resolved` URLs, requirement URLs,
 * index/option lines) — the main SSRF/exfiltration risk of a networked step.
 * Operators should additionally route the fetch network through an egress proxy
 * (SANDBOX_FETCH_NETWORK / SANDBOX_FETCH_PROXY).
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type Ecosystem = 'npm' | 'pip';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const PYPI_INDEX = 'https://pypi.org/simple';
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MAX_NPM_PACKAGES = 5000;
const MAX_PIP_REQUIREMENTS = 300;

export const PIP_REQUIREMENT_FILES = ['requirements.txt', 'requirements-dev.txt', 'requirements-test.txt'] as const;

export interface DependencySpec {
  ecosystem: Ecosystem;
  image: string;
  /** Fetch command (network on) for the staged manifest files. Never runs repository code. */
  fetchArgv: (staged: readonly string[]) => readonly string[];
  /** Working directory of the fetch container. */
  fetchWorkdir: string;
  /** Where the dependency directory is mounted in the fetch container (rw). */
  fetchMount: string;
  /** Subdirectory of the dependency directory mounted, read-only, when the profile runs... */
  runSubdir: string;
  /** ...and where it is mounted. */
  runMount: string;
  /** Extra environment for the profile run. */
  runEnv: readonly string[];
  /** Host-side validation; returns the files to stage into the dependency directory, or a refusal reason. */
  prepare: (workspaceDir: string) => Promise<{ ok: true; stage: string[] } | { ok: false; reason: string }>;
}

async function readBounded(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > MAX_MANIFEST_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Every installed package must come from the public registry with an integrity hash. */
export function validateNpmLockfile(text: string): string | null {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return 'package-lock.json is not valid JSON';
  }
  const l = lock as { lockfileVersion?: number; packages?: Record<string, { resolved?: string; integrity?: string; link?: boolean; dev?: boolean }> };
  if (typeof l.lockfileVersion !== 'number' || l.lockfileVersion < 2 || !l.packages || typeof l.packages !== 'object') {
    return 'package-lock.json must be lockfileVersion 2 or 3';
  }
  const entries = Object.entries(l.packages);
  if (entries.length > MAX_NPM_PACKAGES) return `too many packages in the lockfile (> ${MAX_NPM_PACKAGES})`;
  for (const [key, pkg] of entries) {
    if (key === '') continue;
    if (pkg.link) return `linked package ${key} is not supported (workspaces/file: dependencies)`;
    if (typeof pkg.resolved !== 'string') return `package ${key} has no resolved registry URL`;
    if (!pkg.resolved.startsWith(NPM_REGISTRY)) return `package ${key} resolves outside ${NPM_REGISTRY}`;
    if (typeof pkg.integrity !== 'string' || !/^sha(256|384|512)-/.test(pkg.integrity)) return `package ${key} has no integrity hash`;
  }
  return null;
}

const REQUIREMENT_LINE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?\s*((===?|[<>!~]=|[<>])\s*[A-Za-z0-9.*+!_-]+\s*(,\s*(===?|[<>!~]=|[<>])\s*[A-Za-z0-9.*+!_-]+\s*)*)?(\s*;\s*[A-Za-z0-9_ .'"<>=!()-]+)?(\s+--hash=sha256:[0-9a-f]{64})*$/;

/** Plain `name[extras] specifier ; marker` lines only: no URLs, paths, includes or pip options. */
export function validateRequirements(text: string): string | null {
  let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    if (++count > MAX_PIP_REQUIREMENTS) return `too many requirements (> ${MAX_PIP_REQUIREMENTS})`;
    if (line.startsWith('-')) return `pip options are not allowed in requirement files (${line.split(/\s/)[0]})`;
    if (line.includes('://') || line.includes('@')) return `direct URL or VCS requirements are not allowed (${line.slice(0, 80)})`;
    if (!REQUIREMENT_LINE.test(line)) return `unsupported requirement line: ${line.slice(0, 80)}`;
    const marker = line.split(';')[1]?.replace(/\s+--hash=\S+/g, '');
    if (marker !== undefined && !validMarker(marker)) return `unsupported environment marker: ${marker.trim().slice(0, 80)}`;
  }
  return null;
}

const MARKER_NAMES = new Set([
  'python_version', 'python_full_version', 'os_name', 'sys_platform', 'platform_system', 'platform_machine',
  'platform_release', 'platform_python_implementation', 'implementation_name', 'implementation_version', 'extra', 'and', 'or', 'in', 'not',
]);

/** PEP 508 markers: known variable names, quoted literals, comparison operators and parentheses only. */
function validMarker(marker: string): boolean {
  const rest = marker.replace(/'[^']*'|"[^"]*"/g, ' ').replace(/[()]|===?|[<>!~]=|[<>]/g, ' ');
  return rest.split(/\s+/).filter(Boolean).every((w) => MARKER_NAMES.has(w));
}

/** Whether pytest is declared (the pytest profile only applies then). */
export function declaresPytest(text: string): boolean {
  return text.split(/\r?\n/).some((l) => /^\s*pytest(\[|\s|[<>=!~;]|$)/i.test(l));
}

export function npmSpec(image: string): DependencySpec {
  return {
    ecosystem: 'npm',
    image,
    // Registry and script settings come from the environment, which outranks a repository .npmrc.
    fetchArgv: () => ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=warn'],
    fetchWorkdir: '/deps',
    fetchMount: '/deps',
    runSubdir: 'node_modules',
    runMount: '/workspace/node_modules',
    runEnv: [],
    prepare: async (workspaceDir) => {
      const lock = await readBounded(join(workspaceDir, 'package-lock.json'));
      if (lock === null) return { ok: false, reason: 'package-lock.json is required to install npm dependencies' };
      const problem = validateNpmLockfile(lock);
      if (problem) return { ok: false, reason: problem };
      return { ok: true, stage: ['package.json', 'package-lock.json'] };
    },
  };
}

export function pipSpec(image: string): DependencySpec {
  return {
    ecosystem: 'pip',
    image,
    fetchArgv: (staged) => [
      'python',
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-input',
      '--no-cache-dir',
      '--only-binary=:all:',
      '--isolated',
      '--index-url',
      PYPI_INDEX,
      '--target',
      '/deps/site',
      // The staged copies, validated on the host.
      ...staged.flatMap((f) => ['-r', `/deps/${f}`]),
    ],
    fetchWorkdir: '/deps',
    fetchMount: '/deps',
    runSubdir: '',
    runMount: '/deps',
    runEnv: ['PYTHONPATH=/deps/site'],
    prepare: async (workspaceDir) => {
      const stage: string[] = [];
      let pytest = false;
      for (const f of PIP_REQUIREMENT_FILES) {
        const text = await readBounded(join(workspaceDir, f));
        if (text === null) continue;
        const problem = validateRequirements(text);
        if (problem) return { ok: false, reason: `${f}: ${problem}` };
        pytest ||= declaresPytest(text);
        stage.push(f);
      }
      if (stage.length === 0) return { ok: false, reason: 'no requirements file found' };
      if (!pytest) return { ok: false, reason: 'pytest is not declared in the requirements files' };
      return { ok: true, stage };
    },
  };
}
