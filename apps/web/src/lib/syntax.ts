/**
 * Minimal, dependency-free syntax highlighting (FD-8). It produces plain text
 * tokens with a kind; CodeView renders them as text nodes, so repository content is
 * never parsed into HTML. It is deliberately approximate: a lexer, not a parser.
 */

export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "type" | "fn";

export interface Token {
  text: string;
  kind: TokenKind;
}

type Family = "c" | "python" | "json" | "shell" | null;

const FAMILY: Record<string, Family> = {
  typescript: "c",
  tsx: "c",
  javascript: "c",
  jsx: "c",
  java: "c",
  kotlin: "c",
  go: "c",
  rust: "c",
  c: "c",
  cpp: "c",
  csharp: "c",
  swift: "c",
  php: "c",
  scala: "c",
  dart: "c",
  python: "python",
  ruby: "python",
  json: "json",
  shell: "shell",
  bash: "shell",
  yaml: "shell",
  toml: "shell",
  dockerfile: "shell",
};

const C_KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue debugger declare default delete do " +
    "else enum export extends false finally for from func function go if implements import in instanceof " +
    "interface is keyof let match mod module namespace new null nil package private protected pub public " +
    "readonly return satisfies static struct super switch this throw true try type typeof undefined use " +
    "var void while yield impl fn mut self where trait val fun override"
  ).split(" "),
);
const PY_KEYWORDS = new Set(
  (
    "and as assert async await break class continue def del elif else except False finally for from " +
    "global if import in is lambda None nonlocal not or pass raise return True try while with yield " +
    "self cls match case end begin module require do then unless"
  ).split(" "),
);
const SHELL_KEYWORDS = new Set(
  "if then else elif fi for in do done case esac while function export local return true false FROM RUN COPY CMD ENV WORKDIR ENTRYPOINT ARG EXPOSE".split(
    " ",
  ),
);

/** Continuation state carried from one line to the next. */
type State = { kind: "none" } | { kind: "block-comment" } | { kind: "string"; close: string };

const WORD = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?/y;

export function languageFamily(language: string | null | undefined): Family {
  if (!language) return null;
  return FAMILY[language.toLowerCase()] ?? null;
}

function push(out: Token[], text: string, kind: TokenKind) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ text, kind });
}

function tokenizeLine(line: string, family: Exclude<Family, null>, state: State): [Token[], State] {
  const out: Token[] = [];
  let i = 0;

  if (state.kind === "block-comment") {
    const end = line.indexOf("*/");
    if (end < 0) return [[{ text: line, kind: "comment" }], state];
    push(out, line.slice(0, end + 2), "comment");
    i = end + 2;
    state = { kind: "none" };
  } else if (state.kind === "string") {
    const end = findClose(line, 0, state.close);
    if (end < 0) return [[{ text: line, kind: "string" }], state];
    push(out, line.slice(0, end), "string");
    i = end;
    state = { kind: "none" };
  }

  const keywords =
    family === "python" ? PY_KEYWORDS : family === "shell" ? SHELL_KEYWORDS : C_KEYWORDS;

  while (i < line.length) {
    const ch = line[i]!;
    const rest = line.slice(i);

    // Comments
    if (family === "c" && rest.startsWith("//")) {
      push(out, rest, "comment");
      break;
    }
    if (family === "c" && rest.startsWith("/*")) {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        push(out, rest, "comment");
        return [out, { kind: "block-comment" }];
      }
      push(out, line.slice(i, end + 2), "comment");
      i = end + 2;
      continue;
    }
    if ((family === "python" || family === "shell") && ch === "#") {
      push(out, rest, "comment");
      break;
    }

    // Strings
    if (family === "python" && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const q = rest.slice(0, 3);
      const end = findClose(line, i + 3, q);
      if (end < 0) {
        push(out, rest, "string");
        return [out, { kind: "string", close: q }];
      }
      push(out, line.slice(i, end), "string");
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === "`" && family === "c")) {
      const end = findClose(line, i + 1, ch);
      if (end < 0) {
        push(out, rest, "string");
        // Only template literals legitimately span lines.
        return [out, ch === "`" ? { kind: "string", close: "`" } : { kind: "none" }];
      }
      // JSON object keys read better as types than as strings.
      const isKey = family === "json" && /^\s*:/.test(line.slice(end));
      push(out, line.slice(i, end), isKey ? "type" : "string");
      i = end;
      continue;
    }

    // Numbers (not inside identifiers)
    if (/\d/.test(ch) && !/[\w$]/.test(line[i - 1] ?? "")) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(line);
      if (m) {
        push(out, m[0], "number");
        i += m[0].length;
        continue;
      }
    }

    // Words
    if (/[A-Za-z_$]/.test(ch)) {
      WORD.lastIndex = i;
      const word = WORD.exec(line)![0];
      const after = line.slice(i + word.length);
      let kind: TokenKind = "plain";
      if (family === "json") kind = ["true", "false", "null"].includes(word) ? "keyword" : "plain";
      else if (keywords.has(word)) kind = "keyword";
      else if (/^\s*\(/.test(after)) kind = "fn";
      else if (/^[A-Z][a-z0-9]/.test(word) && family !== "shell") kind = "type";
      push(out, word, kind);
      i += word.length;
      continue;
    }

    push(out, ch, "plain");
    i++;
  }
  return [out, state];
}

/** Index just past the closing quote, honouring backslash escapes; -1 if unclosed. */
function findClose(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line.startsWith(quote, i)) return i + quote.length;
  }
  return -1;
}

/**
 * Tokens per line. Lines after a cap are returned as plain text so a huge file can't
 * stall rendering. Returns null when the language has no highlighter.
 */
export function tokenizeLines(
  lines: string[],
  language: string | null | undefined,
  maxLines = 5000,
): Token[][] | null {
  const family = languageFamily(language);
  if (!family) return null;
  let state: State = { kind: "none" };
  return lines.map((line, n) => {
    if (n >= maxLines || line.length > 2000) return [{ text: line, kind: "plain" }];
    const [tokens, next] = tokenizeLine(line, family, state);
    state = next;
    return tokens;
  });
}

export const TOKEN_CLASS: Record<TokenKind, string | undefined> = {
  plain: undefined,
  keyword: "text-syn-keyword",
  string: "text-syn-string",
  comment: "text-syn-comment italic",
  number: "text-syn-number",
  type: "text-syn-type",
  fn: "text-syn-fn",
};
