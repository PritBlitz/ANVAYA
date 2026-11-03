import { describe, expect, it } from 'vitest';
import { AppConfig } from '../config/config.js';
import { declaresPytest, npmSpec, pipSpec, validateNpmLockfile, validateRequirements } from './dependencies.js';
import { profileById, selectProfiles, unavailableChecks } from './profiles.js';
import { DockerSandboxDriver } from './sandbox.js';

const integrity = 'sha512-' + 'A'.repeat(86) + '==';
const lock = (packages: Record<string, unknown>, lockfileVersion = 3) => JSON.stringify({ name: 'x', lockfileVersion, packages: { '': { name: 'x' }, ...packages } });

describe('npm lockfile validation', () => {
  it('accepts registry packages with integrity hashes', () => {
    expect(validateNpmLockfile(lock({ 'node_modules/is-number': { version: '7.0.0', resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz', integrity } }))).toBeNull();
  });
  it('rejects anything that would make the fetcher contact another host or skip verification', () => {
    expect(validateNpmLockfile(lock({ 'node_modules/a': { resolved: 'https://evil.example/a.tgz', integrity } }))).toMatch(/outside/);
    expect(validateNpmLockfile(lock({ 'node_modules/a': { resolved: 'http://169.254.169.254/latest', integrity } }))).toMatch(/outside/);
    expect(validateNpmLockfile(lock({ 'node_modules/a': { resolved: 'git+ssh://git@github.com/x/y.git', integrity } }))).toMatch(/outside/);
    expect(validateNpmLockfile(lock({ 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.tgz' } }))).toMatch(/integrity/);
    expect(validateNpmLockfile(lock({ 'node_modules/a': { link: true, resolved: '../a' } }))).toMatch(/linked/);
    expect(validateNpmLockfile(lock({ 'node_modules/a': { version: '1.0.0' } }))).toMatch(/no resolved/);
    expect(validateNpmLockfile(lock({}, 1))).toMatch(/lockfileVersion/);
    expect(validateNpmLockfile('{not json')).toMatch(/JSON/);
  });
});

describe('pip requirements validation', () => {
  it('accepts plain pinned requirements, extras, markers and hashes', () => {
    const ok = ['pytest==8.3.3', 'requests[socks]>=2.31,<3', "tomli>=2; python_version < '3.11'", 'six', `idna==3.7 --hash=sha256:${'a'.repeat(64)}`, '# comment', '', 'attrs~=23.2  # trailing comment'].join('\n');
    expect(validateRequirements(ok)).toBeNull();
  });
  it.each([
    ['-r other.txt', /options/],
    ['--index-url https://evil.example/simple', /options/],
    ['-e .', /options/],
    ['pkg @ https://evil.example/pkg.whl', /URL/],
    ['git+https://github.com/x/y.git', /URL/],
    ['./local/package', /unsupported/],
    ['pkg==1.0; os.system("x")', /unsupported/],
  ])('rejects %s', (line, why) => {
    expect(validateRequirements(`pytest\n${line}\n`)).toMatch(why);
  });
  it('detects a pytest requirement', () => {
    expect(declaresPytest('six\npytest>=8\n')).toBe(true);
    expect(declaresPytest('pytest-cov\n')).toBe(false);
  });
});

describe('dependency profiles', () => {
  const paths = new Set(['package.json', 'package-lock.json', 'index.js', 'requirements.txt', 'app.py', 'test_app.py']);

  it('are only offered when dependency fetching is enabled', () => {
    expect(selectProfiles(undefined, paths).map((p) => p.id)).not.toContain('npm-test');
    const on = selectProfiles(undefined, paths, { dependencyFetch: true }).map((p) => p.id);
    expect(on).toEqual(expect.arrayContaining(['npm-test', 'python-pytest', 'node-syntax', 'python-compile']));
    expect(selectProfiles(['npm-test'], paths).map((p) => p.id)).toEqual([]);
  });

  it('report unavailable checks honestly in both modes', () => {
    expect(unavailableChecks(paths).map((u) => u.profile_id)).toEqual(expect.arrayContaining(['npm-test', 'python-dependencies']));
    expect(unavailableChecks(paths, { dependencyFetch: true }).map((u) => u.profile_id)).not.toContain('npm-test');
    const noLock = unavailableChecks(new Set(['package.json']), { dependencyFetch: true });
    expect(noLock.find((u) => u.profile_id === 'npm-test')?.reason).toMatch(/package-lock/);
  });

  it('build the pip command from the staged files only', () => {
    const argv = pipSpec('img').fetchArgv(['requirements.txt']);
    expect(argv).toEqual(expect.arrayContaining(['--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '-r', '/deps/requirements.txt']));
    expect(argv).not.toContain('/deps/requirements-dev.txt');
    expect(npmSpec('img').fetchArgv([])).toEqual(expect.arrayContaining(['ci', '--ignore-scripts']));
  });
});

describe('docker arguments', () => {
  const driver = new DockerSandboxDriver(new AppConfig({ ...process.env, SANDBOX_FETCH_NETWORK: 'anvaya-egress', SANDBOX_FETCH_PROXY: 'http://proxy.internal:3128' }));

  it('fetch: egress network, read-only workspace, hardened, registry pinned by environment', () => {
    const spec = profileById('npm-test')!.dependencies!;
    const args = driver.buildFetchArgs('n', spec, ['package.json', 'package-lock.json'], '/w/repo', '/w/deps/npm');
    const joined = args.join(' ');
    expect(args[args.indexOf('--network') + 1]).toBe('anvaya-egress');
    expect(joined).toContain('type=bind,src=/w/repo,dst=/workspace,readonly');
    expect(joined).toContain('type=bind,src=/w/deps/npm,dst=/deps');
    expect(joined).toContain('npm_config_ignore_scripts=true');
    expect(joined).toContain('npm_config_registry=https://registry.npmjs.org/');
    expect(joined).toContain('HTTPS_PROXY=http://proxy.internal:3128');
    for (const flag of ['--read-only', 'no-new-privileges', '65534:65534']) expect(joined).toContain(flag);
    expect(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2)).toEqual(['--cap-drop', 'ALL']);
  });

  it('run: no network, dependencies mounted read-only', () => {
    const profile = profileById('python-pytest')!;
    const args = driver.buildArgs('n', profile, '/w/repo', { spec: profile.dependencies!, dir: '/w/deps/pip' });
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args.join(' ')).toContain('type=bind,src=/w/deps/pip,dst=/deps,readonly');
    expect(args).toContain('PYTHONPATH=/deps/site');
  });
});
