import { describe, expect, it } from 'vitest';
import { callGraph, changedRangesFromDiff, type CodeGraph, isTestFile, predictImpact, type SymbolInfo, testSubjectStem } from './graph.js';

const sym = (id: string, name: string, path: string, start: number, end: number, kind = 'function'): SymbolInfo => ({ id, name, qualified_name: name, kind, path, start_line: start, end_line: end });

/**
 * src/token.ts       ← imported by src/session.ts ← imported by src/api.ts
 * tests/token.test.ts imports src/token.ts
 * tests/api.test.ts   imports src/api.ts           (3 hops from token.ts)
 * test_billing.py     calls charge() in billing.py
 */
function fixture(): CodeGraph {
  const symbols = [
    sym('00000000-0000-0000-0000-000000000001', 'refresh', 'src/token.ts', 3, 10),
    sym('00000000-0000-0000-0000-000000000002', 'issue', 'src/token.ts', 12, 15),
    sym('00000000-0000-0000-0000-000000000003', 'login', 'src/session.ts', 1, 9),
    sym('00000000-0000-0000-0000-000000000004', 'handler', 'src/api.ts', 1, 9),
    sym('00000000-0000-0000-0000-000000000005', 'charge', 'billing.py', 1, 4),
    sym('00000000-0000-0000-0000-000000000006', 'test_charge', 'test_billing.py', 3, 6),
    sym('00000000-0000-0000-0000-000000000007', 'token.test.ts', 'tests/token.test.ts', 1, 20, 'module'),
  ];
  return {
    files: new Set(['src/token.ts', 'src/session.ts', 'src/api.ts', 'tests/token.test.ts', 'tests/api.test.ts', 'billing.py', 'test_billing.py', 'README.md']),
    imports: [
      { from: 'src/session.ts', to: 'src/token.ts', line: 1 },
      { from: 'src/api.ts', to: 'src/session.ts', line: 2 },
      { from: 'tests/token.test.ts', to: 'src/token.ts', line: 1 },
      { from: 'tests/api.test.ts', to: 'src/api.ts', line: 1 },
    ],
    symbols: new Map(symbols.map((s) => [s.id, s])),
    calls: [
      { source_symbol_id: '00000000-0000-0000-0000-000000000003', target_symbol_id: '00000000-0000-0000-0000-000000000001', type: 'calls', line: 4 },
      { source_symbol_id: '00000000-0000-0000-0000-000000000004', target_symbol_id: '00000000-0000-0000-0000-000000000003', type: 'calls', line: 5 },
      { source_symbol_id: '00000000-0000-0000-0000-000000000006', target_symbol_id: '00000000-0000-0000-0000-000000000005', type: 'calls', line: 4 },
    ],
  };
}

describe('test file detection', () => {
  it.each([
    ['tests/token.test.ts', true],
    ['src/a.spec.tsx', true],
    ['test_billing.py', true],
    ['pkg/billing_test.py', true],
    ['__tests__/x.js', true],
    ['src/conftest.py', false],
    ['src/token.ts', false],
    ['tests/fixtures/data.json', false],
  ])('%s → %s', (p, expected) => expect(isTestFile(p)).toBe(expected));

  it('derives the subject a test is named after', () => {
    expect(testSubjectStem('tests/token.test.ts')).toBe('token');
    expect(testSubjectStem('test_billing.py')).toBe('billing');
    expect(testSubjectStem('billing_test.py')).toBe('billing');
    expect(testSubjectStem('src/token.ts')).toBeNull();
  });
});

describe('predictImpact', () => {
  it('follows reverse imports with evidence chains and ranks direct importers first', () => {
    const r = predictImpact(fixture(), [{ path: 'src/token.ts' }]);
    expect(r.heuristic).toBe(true);
    expect(r.impacted_files.map((f) => [f.path, f.distance])).toEqual([
      ['src/session.ts', 1],
      ['tests/token.test.ts', 1],
      ['src/api.ts', 2],
      ['tests/api.test.ts', 3],
    ]);
    const chain = r.impacted_files.find((f) => f.path === 'tests/api.test.ts')!.evidence;
    expect(chain.map((e) => (e.kind === 'imports' ? `${e.from}->${e.to}` : e.kind))).toEqual(['tests/api.test.ts->src/api.ts', 'src/api.ts->src/session.ts', 'src/session.ts->src/token.ts']);
    expect(r.selected_tests.map((t) => t.path)).toEqual(['tests/token.test.ts', 'tests/api.test.ts']);
    expect(r.selected_tests[0]!.score).toBeGreaterThan(r.selected_tests[1]!.score);
    expect(r.selected_tests[0]!.reasons.map((x) => x.kind)).toEqual(expect.arrayContaining(['imports', 'naming']));
  });

  it('narrows changed symbols to the changed line ranges and follows callers', () => {
    const only = predictImpact(fixture(), [{ path: 'src/token.ts', ranges: [[12, 13]] }]);
    expect(only.changed_symbols.map((s) => s.name)).toEqual(['issue']);
    expect(only.impacted_symbols).toEqual([]);
    const r = predictImpact(fixture(), [{ path: 'src/token.ts', ranges: [[5, 5]] }]);
    expect(r.changed_symbols.map((s) => s.name)).toEqual(['refresh']);
    expect(r.impacted_symbols.map((s) => [s.symbol.name, s.depth])).toEqual([
      ['login', 1],
      ['handler', 2],
    ]);
  });

  it('selects Python tests through calls, and a changed test scores highest', () => {
    const r = predictImpact(fixture(), [{ path: 'billing.py' }, { path: 'tests/token.test.ts' }]);
    const byPath = new Map(r.selected_tests.map((t) => [t.path, t]));
    expect(byPath.get('tests/token.test.ts')!.score).toBe(1);
    expect(byPath.get('test_billing.py')!.reasons.map((x) => x.kind)).toEqual(['calls', 'naming']);
    expect(r.selected_tests[0]!.path).toBe('tests/token.test.ts');
  });

  it('reports unindexed changed files, caps the selection and always carries limitations', () => {
    const r = predictImpact(fixture(), [{ path: 'src/token.ts' }, { path: 'src/new.ts' }], { maxTests: 1 });
    expect(r.changed_files).toEqual([
      { path: 'src/new.ts', indexed: false, symbols: 0 },
      { path: 'src/token.ts', indexed: true, symbols: 2 },
    ]);
    expect(r.selected_tests).toHaveLength(1);
    expect(r.truncated).toBe(true);
    expect(r.limitations.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    expect(predictImpact(fixture(), [{ path: 'src/token.ts' }])).toEqual(predictImpact(fixture(), [{ path: 'src/token.ts' }]));
  });
});

describe('callGraph', () => {
  it('walks callers and callees to the requested depth', () => {
    const g = fixture();
    const callers = callGraph(g, '00000000-0000-0000-0000-000000000001', 'callers', 1, 100);
    expect(callers.nodes.map((n) => [n.symbol.name, n.depth, n.direction])).toEqual([['login', 1, 'caller']]);
    const deep = callGraph(g, '00000000-0000-0000-0000-000000000001', 'callers', 2, 100);
    expect(deep.nodes.map((n) => n.symbol.name)).toEqual(['login', 'handler']);
    expect(deep.edges.map((e) => [e.path, e.line])).toEqual([
      ['src/session.ts', 4],
      ['src/api.ts', 5],
    ]);
    const callees = callGraph(g, '00000000-0000-0000-0000-000000000004', 'callees', 3, 100);
    expect(callees.nodes.map((n) => [n.symbol.name, n.direction])).toEqual([
      ['login', 'callee'],
      ['refresh', 'callee'],
    ]);
  });

  it('stops at the node cap and marks the result truncated', () => {
    const g = callGraph(fixture(), '00000000-0000-0000-0000-000000000001', 'callers', 3, 1);
    expect(g.nodes).toHaveLength(1);
    expect(g.truncated).toBe(true);
  });
});

describe('changedRangesFromDiff', () => {
  it('reads old-side hunk ranges and ignores created files', () => {
    const diff = ['--- a/src/token.ts', '+++ b/src/token.ts', '@@ -3,4 +3,5 @@', ' x', '@@ -20 +21,2 @@', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,3 @@'].join('\n');
    const r = changedRangesFromDiff(diff);
    expect(r.get('src/token.ts')).toEqual([
      [3, 6],
      [20, 20],
    ]);
    expect(r.has('src/new.ts')).toBe(false);
  });
});
