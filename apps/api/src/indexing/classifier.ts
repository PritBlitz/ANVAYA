/**
 * File classification for indexing (FR-REP-002). Pure functions: no I/O.
 * Repository content is untrusted; nothing here executes or interprets it.
 */

export type ParserLanguage = 'typescript' | 'tsx' | 'javascript' | 'python';

export interface LanguageInfo {
  /** Display/filter language, e.g. "typescript". */
  language: string;
  /** Tree-sitter grammar when syntax-aware parsing is supported. */
  parser: ParserLanguage | null;
  fileType: 'source' | 'docs' | 'config' | 'data' | 'other';
}

const EXT: Record<string, LanguageInfo> = {
  ts: { language: 'typescript', parser: 'typescript', fileType: 'source' },
  mts: { language: 'typescript', parser: 'typescript', fileType: 'source' },
  cts: { language: 'typescript', parser: 'typescript', fileType: 'source' },
  tsx: { language: 'typescript', parser: 'tsx', fileType: 'source' },
  js: { language: 'javascript', parser: 'javascript', fileType: 'source' },
  mjs: { language: 'javascript', parser: 'javascript', fileType: 'source' },
  cjs: { language: 'javascript', parser: 'javascript', fileType: 'source' },
  jsx: { language: 'javascript', parser: 'javascript', fileType: 'source' },
  py: { language: 'python', parser: 'python', fileType: 'source' },
  pyi: { language: 'python', parser: 'python', fileType: 'source' },
  // Indexed as text (lexical + semantic), not syntax-parsed.
  go: { language: 'go', parser: null, fileType: 'source' },
  java: { language: 'java', parser: null, fileType: 'source' },
  kt: { language: 'kotlin', parser: null, fileType: 'source' },
  rb: { language: 'ruby', parser: null, fileType: 'source' },
  rs: { language: 'rust', parser: null, fileType: 'source' },
  c: { language: 'c', parser: null, fileType: 'source' },
  h: { language: 'c', parser: null, fileType: 'source' },
  cc: { language: 'cpp', parser: null, fileType: 'source' },
  cpp: { language: 'cpp', parser: null, fileType: 'source' },
  hpp: { language: 'cpp', parser: null, fileType: 'source' },
  cs: { language: 'csharp', parser: null, fileType: 'source' },
  php: { language: 'php', parser: null, fileType: 'source' },
  swift: { language: 'swift', parser: null, fileType: 'source' },
  scala: { language: 'scala', parser: null, fileType: 'source' },
  sh: { language: 'shell', parser: null, fileType: 'source' },
  bash: { language: 'shell', parser: null, fileType: 'source' },
  sql: { language: 'sql', parser: null, fileType: 'source' },
  html: { language: 'html', parser: null, fileType: 'source' },
  css: { language: 'css', parser: null, fileType: 'source' },
  scss: { language: 'css', parser: null, fileType: 'source' },
  vue: { language: 'vue', parser: null, fileType: 'source' },
  svelte: { language: 'svelte', parser: null, fileType: 'source' },
  md: { language: 'markdown', parser: null, fileType: 'docs' },
  mdx: { language: 'markdown', parser: null, fileType: 'docs' },
  rst: { language: 'restructuredtext', parser: null, fileType: 'docs' },
  txt: { language: 'text', parser: null, fileType: 'docs' },
  json: { language: 'json', parser: null, fileType: 'config' },
  yaml: { language: 'yaml', parser: null, fileType: 'config' },
  yml: { language: 'yaml', parser: null, fileType: 'config' },
  toml: { language: 'toml', parser: null, fileType: 'config' },
  ini: { language: 'ini', parser: null, fileType: 'config' },
  xml: { language: 'xml', parser: null, fileType: 'data' },
  csv: { language: 'csv', parser: null, fileType: 'data' },
};

const SPECIAL_NAMES: Record<string, LanguageInfo> = {
  dockerfile: { language: 'dockerfile', parser: null, fileType: 'config' },
  makefile: { language: 'make', parser: null, fileType: 'config' },
};

export function detectLanguage(path: string): LanguageInfo {
  const base = path.split('/').pop()!.toLowerCase();
  if (SPECIAL_NAMES[base]) return SPECIAL_NAMES[base];
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  return EXT[ext] ?? { language: 'unknown', parser: null, fileType: 'other' };
}

export type ExclusionReason =
  | 'invalid_path'
  | 'dependency_directory'
  | 'build_output'
  | 'vcs_metadata'
  | 'generated'
  | 'lockfile'
  | 'binary_extension'
  | 'binary_content'
  | 'secret_file'
  | 'secret_detected'
  | 'too_large'
  | 'configured_exclusion'
  | 'file_limit';

const DEPENDENCY_DIRS = new Set(['node_modules', 'vendor', 'bower_components', '.venv', 'venv', 'site-packages', '__pycache__', '.tox', '.gradle', 'pods']);
const BUILD_DIRS = new Set(['dist', 'build', 'out', 'target', '.next', '.nuxt', 'coverage', '.cache', '.turbo', '.parcel-cache', '.output', 'bin', 'obj']);
const VCS_DIRS = new Set(['.git', '.hg', '.svn']);
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'pipfile.lock', 'cargo.lock', 'composer.lock', 'gemfile.lock', 'go.sum', 'uv.lock']);
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'psd', 'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war',
  'class', 'so', 'dll', 'dylib', 'exe', 'o', 'a', 'lib', 'wasm', 'pyc', 'pyo', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov',
  'avi', 'webm', 'wav', 'flac', 'ogg', 'sqlite', 'db', 'bin', 'dat', 'pkl', 'npy', 'npz', 'onnx', 'pt', 'safetensors', 'gguf',
]);
/** Filenames that conventionally hold credentials. Never indexed, never embedded. */
const SECRET_FILE_RE =
  /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|service-account[^/]*\.json|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg))$/i;
const GENERATED_NAME_RE = /(\.min\.(js|css)|\.map|\.pb\.go|_pb2(_grpc)?\.py|\.generated\.[a-z]+|\.g\.dart|\.designer\.cs)$/i;

/** High-confidence credential patterns used to exclude files (low false-positive by design). */
const SECRET_CONTENT_RES = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abprs]-[0-9]{6,}-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/,
];

export function normalizePath(raw: string): string | null {
  if (raw.length === 0 || raw.length > 1024 || raw.includes('\0') || raw.includes('\\')) return null;
  if (raw.startsWith('/')) return null;
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** Minimal glob for repository exclude patterns: `dir/`, `*.ext`, `a/**`, `a/*.ts`, exact paths. */
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith('/')) return path.startsWith(pattern) || path.includes(`/${pattern}`);
  if (!pattern.includes('*')) return path === pattern;
  const re = new RegExp(
    '^' +
      pattern
        .split('**')
        .map((part) =>
          part
            .split('*')
            .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]*'),
        )
        .join('.*') +
      '$',
  );
  return re.test(path) || (!pattern.includes('/') && re.test(path.split('/').pop()!));
}

export interface PathDecision {
  excluded: boolean;
  reason?: ExclusionReason;
}

export function classifyPath(path: string, excludePatterns: readonly string[]): PathDecision {
  const segments = path.toLowerCase().split('/');
  const dirs = segments.slice(0, -1);
  const base = segments.at(-1)!;
  if (dirs.some((d) => VCS_DIRS.has(d))) return { excluded: true, reason: 'vcs_metadata' };
  if (dirs.some((d) => DEPENDENCY_DIRS.has(d))) return { excluded: true, reason: 'dependency_directory' };
  if (dirs.some((d) => BUILD_DIRS.has(d))) return { excluded: true, reason: 'build_output' };
  if (SECRET_FILE_RE.test(path) && !/\.env\.(example|sample|template)$/i.test(path)) return { excluded: true, reason: 'secret_file' };
  if (LOCKFILES.has(base)) return { excluded: true, reason: 'lockfile' };
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (BINARY_EXT.has(ext)) return { excluded: true, reason: 'binary_extension' };
  if (GENERATED_NAME_RE.test(base)) return { excluded: true, reason: 'generated' };
  if (excludePatterns.some((p) => matchesPattern(path, p))) return { excluded: true, reason: 'configured_exclusion' };
  return { excluded: false };
}

export interface ContentDecision extends PathDecision {
  text?: string;
  lineCount?: number;
}

/** Inspects file bytes. Returns decoded text when the file is indexable. */
export function classifyContent(bytes: Buffer, maxBytes: number): ContentDecision {
  if (bytes.length > maxBytes) return { excluded: true, reason: 'too_large' };
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return { excluded: true, reason: 'binary_content' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { excluded: true, reason: 'binary_content' };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLines = text.slice(0, 600);
  if (/@generated|DO NOT EDIT|auto-?generated by|This file (is|was) (automatically )?generated/i.test(firstLines)) {
    return { excluded: true, reason: 'generated' };
  }
  const lines = text.split(/\r?\n/);
  if (bytes.length > 10_000 && lines.some((l) => l.length > 1000) && lines.length < bytes.length / 500) {
    return { excluded: true, reason: 'generated' }; // minified / bundled
  }
  if (SECRET_CONTENT_RES.some((re) => re.test(text))) return { excluded: true, reason: 'secret_detected' };
  return { excluded: false, text, lineCount: text.endsWith('\n') ? lines.length - 1 : lines.length };
}

const SECRET_KINDS: Array<[string, RegExp]> = [
  ['private_key', SECRET_CONTENT_RES[0]!],
  ['github_token', SECRET_CONTENT_RES[1]!],
  ['github_token', SECRET_CONTENT_RES[2]!],
  ['aws_access_key_id', SECRET_CONTENT_RES[3]!],
  ['api_key', SECRET_CONTENT_RES[4]!],
  ['slack_token', SECRET_CONTENT_RES[5]!],
  ['google_api_key', SECRET_CONTENT_RES[6]!],
  ['stripe_live_key', SECRET_CONTENT_RES[7]!],
];

/** Line-level secret detection for deterministic security checks. Never returns the secret value. */
export function findSecrets(text: string): Array<{ line: number; kind: string }> {
  const out: Array<{ line: number; kind: string }> = [];
  text.split(/\r?\n/).forEach((l, i) => {
    for (const [kind, re] of SECRET_KINDS) if (re.test(l)) out.push({ line: i + 1, kind });
  });
  return out;
}
