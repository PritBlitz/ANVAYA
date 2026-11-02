import { describe, expect, it } from 'vitest';
import { withResolvedEvidence } from './runs.service.js';

const SHA = 'a'.repeat(40);
const evidence = [
  { id: 'c1', path: 'src/token.ts', start_line: 1, end_line: 9, commit_sha: SHA, content_hash: 'h1', symbol: 'TokenService' },
  { id: 'c2', path: 'src/auth.ts', start_line: 4, end_line: 7, commit_sha: SHA, content_hash: 'h2', symbol: null },
];

describe('plan investigation evidence (GAP-21)', () => {
  it('resolves evidence_ids to server-side file:line references and drops unknown ids', () => {
    const out = withResolvedEvidence(
      { summary: 's', findings: [{ claim: 'x', kind: 'observed', evidence_ids: ['c2', 'fabricated', 'c1'] }, { claim: 'y', kind: 'hypothesis', evidence_ids: [] }] },
      evidence,
    ) as { summary: string; findings: Array<{ evidence_ids: string[]; evidence: Array<{ id: string; path: string; start_line: number }> }> };
    expect(out.summary).toBe('s');
    expect(out.findings[0]!.evidence_ids).toEqual(['c2', 'fabricated', 'c1']);
    expect(out.findings[0]!.evidence.map((e) => [e.id, e.path, e.start_line])).toEqual([
      ['c2', 'src/auth.ts', 4],
      ['c1', 'src/token.ts', 1],
    ]);
    expect(out.findings[1]!.evidence).toEqual([]);
  });

  it('passes through missing or malformed investigations and evidence', () => {
    expect(withResolvedEvidence(undefined, evidence)).toBeNull();
    expect(withResolvedEvidence({ summary: 'no findings' }, evidence)).toEqual({ summary: 'no findings' });
    const out = withResolvedEvidence({ findings: [{ claim: 'x', evidence_ids: ['c1'] }] }, [{ id: 'c1', path: 3 }]) as { findings: Array<{ evidence: unknown[] }> };
    expect(out.findings[0]!.evidence).toEqual([]);
  });
});
