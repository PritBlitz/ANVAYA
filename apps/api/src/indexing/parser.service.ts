import { createRequire } from 'node:module';
import { Injectable } from '@nestjs/common';
import { Language, type Node, Parser } from 'web-tree-sitter';
import type { ParserLanguage } from './classifier.js';

const require = createRequire(import.meta.url);

const GRAMMARS: Record<ParserLanguage, string> = {
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
};

/** Bump when extraction logic changes so incremental reuse does not mix versions. */
export const PARSER_VERSION = 'web-tree-sitter-0.27.1;ts-0.23.2;js-0.25.0;py-0.25.0;extractor-1';

const MAX_SYMBOLS = 2000;
const MAX_RELATIONS = 5000;
const MAX_DEPTH = 200;
const PARSE_TIMEOUT_MS = 5000;

export interface ExtractedSymbol {
  key: string;
  name: string;
  qualifiedName: string;
  kind: 'module' | 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum';
  startLine: number;
  endLine: number;
  signature: string | null;
}

export interface ExtractedRelation {
  sourceKey: string;
  type: 'imports' | 'calls' | 'extends' | 'instantiates';
  targetName: string;
  line: number;
}

export interface ParseResult {
  ok: boolean;
  symbols: ExtractedSymbol[];
  relations: ExtractedRelation[];
  /** True when the syntax tree contained error nodes (extraction is best-effort). */
  hasErrors: boolean;
}

/**
 * Syntax-aware extraction with Tree-sitter (FR-REP-003/004). Runs in-process
 * on untrusted source text but only parses it — nothing is evaluated. Parsing
 * is bounded by file size (classifier), a timeout, recursion depth and output
 * caps.
 */
@Injectable()
export class ParserService {
  private init?: Promise<void>;
  private readonly languages = new Map<ParserLanguage, Language>();

  private async ensure(lang: ParserLanguage): Promise<Language> {
    this.init ??= Parser.init();
    await this.init;
    let l = this.languages.get(lang);
    if (!l) {
      l = await Language.load(require.resolve(GRAMMARS[lang]));
      this.languages.set(lang, l);
    }
    return l;
  }

  async parse(lang: ParserLanguage, path: string, text: string, lineCount: number): Promise<ParseResult> {
    const language = await this.ensure(lang);
    const parser = new Parser();
    parser.setLanguage(language);
    const deadline = Date.now() + PARSE_TIMEOUT_MS;
    const tree = parser.parse(text, null, { progressCallback: () => Date.now() > deadline });
    if (!tree) {
      parser.delete();
      return { ok: false, symbols: [], relations: [], hasErrors: true };
    }
    try {
      const moduleKey = `${path}#<module>`;
      const out: ParseResult = {
        ok: true,
        hasErrors: tree.rootNode.hasError,
        symbols: [{ key: moduleKey, name: path.split('/').pop()!, qualifiedName: path, kind: 'module', startLine: 1, endLine: Math.max(1, lineCount), signature: null }],
        relations: [],
      };
      const seenRel = new Set<string>();
      const addRel = (r: ExtractedRelation) => {
        const k = `${r.sourceKey}|${r.type}|${r.targetName}`;
        if (seenRel.has(k) || out.relations.length >= MAX_RELATIONS || r.targetName.length === 0 || r.targetName.length > 200) return;
        seenRel.add(k);
        out.relations.push(r);
      };
      const addSym = (node: Node, name: string, kind: ExtractedSymbol['kind'], container: string | null): string | null => {
        if (out.symbols.length >= MAX_SYMBOLS || !name) return null;
        const qualifiedName = container ? `${container}.${name}` : name;
        const startLine = node.startPosition.row + 1;
        const key = `${path}#${qualifiedName}:${startLine}`;
        const firstLine = text.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 400)).split('\n')[0]!.trim();
        out.symbols.push({ key, name, qualifiedName, kind, startLine, endLine: node.endPosition.row + 1, signature: firstLine.slice(0, 200) || null });
        return key;
      };
      if (lang === 'python') this.walkPython(tree.rootNode, moduleKey, null, 0, addSym, addRel);
      else this.walkJs(tree.rootNode, moduleKey, null, 0, addSym, addRel);
      return out;
    } finally {
      tree.delete();
      parser.delete();
    }
  }

  private walkJs(
    node: Node,
    scopeKey: string,
    container: string | null,
    depth: number,
    addSym: (n: Node, name: string, kind: ExtractedSymbol['kind'], container: string | null) => string | null,
    addRel: (r: ExtractedRelation) => void,
  ): void {
    if (depth > MAX_DEPTH) return;
    let nextScope = scopeKey;
    let nextContainer = container;
    const nameOf = (n: Node | null) => n?.text ?? '';
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const key = addSym(node, nameOf(node.childForFieldName('name')), 'function', container);
        if (key) nextScope = key;
        break;
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class': {
        const name = nameOf(node.childForFieldName('name'));
        if (name) {
          const key = addSym(node, name, 'class', container);
          if (key) nextScope = key;
          nextContainer = container ? `${container}.${name}` : name;
          const heritage = node.namedChildren.find((c) => c?.type === 'class_heritage');
          const ext = heritage?.namedChildren.find((c) => c?.type === 'extends_clause');
          const target = ext?.childForFieldName('value') ?? ext?.namedChildren[0] ?? null;
          if (key && target) addRel({ sourceKey: key, type: 'extends', targetName: target.text.split('<')[0]!.trim(), line: node.startPosition.row + 1 });
        }
        break;
      }
      case 'interface_declaration':
        addSym(node, nameOf(node.childForFieldName('name')), 'interface', container);
        break;
      case 'type_alias_declaration':
        addSym(node, nameOf(node.childForFieldName('name')), 'type', container);
        break;
      case 'enum_declaration':
        addSym(node, nameOf(node.childForFieldName('name')), 'enum', container);
        break;
      case 'method_definition': {
        const key = addSym(node, nameOf(node.childForFieldName('name')), 'method', container);
        if (key) nextScope = key;
        break;
      }
      case 'variable_declarator': {
        const value = node.childForFieldName('value');
        if (value && ['arrow_function', 'function_expression', 'function'].includes(value.type)) {
          const key = addSym(node, nameOf(node.childForFieldName('name')), 'function', container);
          if (key) nextScope = key;
        }
        break;
      }
      case 'import_statement': {
        const source = node.childForFieldName('source');
        if (source) addRel({ sourceKey: scopeKey, type: 'imports', targetName: source.text.replace(/^['"`]|['"`]$/g, ''), line: node.startPosition.row + 1 });
        break;
      }
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        const name = fn?.type === 'identifier' ? fn.text : fn?.type === 'member_expression' ? (fn.childForFieldName('property')?.text ?? '') : '';
        if (name === 'require') {
          const arg = node.childForFieldName('arguments')?.namedChildren[0];
          if (arg?.type === 'string') addRel({ sourceKey: scopeKey, type: 'imports', targetName: arg.text.replace(/^['"`]|['"`]$/g, ''), line: node.startPosition.row + 1 });
        } else if (name) {
          addRel({ sourceKey: scopeKey, type: 'calls', targetName: name, line: node.startPosition.row + 1 });
        }
        break;
      }
      case 'new_expression': {
        const ctor = node.childForFieldName('constructor');
        if (ctor?.type === 'identifier') addRel({ sourceKey: scopeKey, type: 'instantiates', targetName: ctor.text, line: node.startPosition.row + 1 });
        break;
      }
    }
    for (const child of node.namedChildren) if (child) this.walkJs(child, nextScope, nextContainer, depth + 1, addSym, addRel);
  }

  private walkPython(
    node: Node,
    scopeKey: string,
    container: string | null,
    depth: number,
    addSym: (n: Node, name: string, kind: ExtractedSymbol['kind'], container: string | null) => string | null,
    addRel: (r: ExtractedRelation) => void,
  ): void {
    if (depth > MAX_DEPTH) return;
    let nextScope = scopeKey;
    let nextContainer = container;
    switch (node.type) {
      case 'function_definition': {
        const isMethod = node.parent?.parent?.type === 'class_definition' || node.parent?.parent?.parent?.type === 'class_definition';
        const key = addSym(node, node.childForFieldName('name')?.text ?? '', isMethod && container ? 'method' : 'function', container);
        if (key) nextScope = key;
        break;
      }
      case 'class_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        const key = addSym(node, name, 'class', container);
        if (key) {
          nextScope = key;
          nextContainer = container ? `${container}.${name}` : name;
          const supers = node.childForFieldName('superclasses');
          for (const s of supers?.namedChildren ?? []) {
            if (s && (s.type === 'identifier' || s.type === 'attribute')) addRel({ sourceKey: key, type: 'extends', targetName: s.text.split('.').pop()!, line: node.startPosition.row + 1 });
          }
        }
        break;
      }
      case 'import_statement':
      case 'import_from_statement': {
        const mod = node.childForFieldName('module_name');
        if (mod) addRel({ sourceKey: scopeKey, type: 'imports', targetName: mod.text, line: node.startPosition.row + 1 });
        else for (const n of node.namedChildren) if (n?.type === 'dotted_name') addRel({ sourceKey: scopeKey, type: 'imports', targetName: n.text, line: node.startPosition.row + 1 });
        break;
      }
      case 'call': {
        const fn = node.childForFieldName('function');
        const name = fn?.type === 'identifier' ? fn.text : fn?.type === 'attribute' ? (fn.childForFieldName('attribute')?.text ?? '') : '';
        if (name) addRel({ sourceKey: scopeKey, type: 'calls', targetName: name, line: node.startPosition.row + 1 });
        break;
      }
    }
    for (const child of node.namedChildren) if (child) this.walkPython(child, nextScope, nextContainer, depth + 1, addSym, addRel);
  }
}
