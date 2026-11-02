import { describe, expect, it } from 'vitest';
import { AiClient } from '../src/ai/ai-client.js';
import { AppConfig } from '../src/config/config.js';

/**
 * Cross-service contract test against the REAL FastAPI AI service (mock
 * provider + mock embeddings, no model credits). Opt-in:
 *   AI_SERVICE_E2E_URL=http://127.0.0.1:8001 npm test -- contract-ai-service
 */
const url = process.env.AI_SERVICE_E2E_URL;

describe.skipIf(!url)('AI service contract (real FastAPI service)', () => {
  const client = new AiClient(new AppConfig({ ...process.env, AI_SERVICE_URL: url }));
  const evidence = [
    {
      id: 'ev-1',
      path: 'src/token.ts',
      start_line: 1,
      end_line: 5,
      commit_sha: 'a'.repeat(40),
      content_hash: `sha256:${'0'.repeat(64)}`,
      language: 'typescript',
      symbol: 'TokenService',
      content: 'export class TokenService { refresh() {} }',
    },
  ];

  it('embeddings parse and match the index dimension', async () => {
    const res = await client.embed(['refresh token', 'invoice'], 'document');
    expect(res.dimension).toBe(768);
    expect(res.embeddings).toHaveLength(2);
  });

  it('structured generation parses for every task in mock mode', async () => {
    for (const task of ['repository_qa', 'investigation', 'planning', 'review', 'verification_summary'] as const) {
      const res = await client.generate({
        task,
        mode: 'mock',
        intent: { question: 'How is the token refreshed?', title: 'Fix refresh' },
        evidence,
        context: { investigation: { candidate_files: ['src/token.ts'] }, changed_files: ['src/token.ts'] },
        budget: { max_input_tokens: 6000, max_output_tokens: 512, timeout_seconds: 30 },
      });
      expect(res.task).toBe(task);
      expect(res.evidence_included).toEqual(['ev-1']);
    }
  });

  it('local mode fails explicitly when Ollama is unavailable (no fallback)', async () => {
    await expect(
      client.generate({ task: 'repository_qa', mode: 'local', intent: { question: 'q' }, evidence, budget: { max_input_tokens: 6000, max_output_tokens: 256, timeout_seconds: 10 } }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/PROVIDER_UNAVAILABLE|MODEL_NOT_AVAILABLE/) });
  });

  it('cloud mode is refused when no hosted provider is configured', async () => {
    await expect(
      client.generate({ task: 'repository_qa', mode: 'cloud', intent: { question: 'q' }, evidence, budget: { max_input_tokens: 6000, max_output_tokens: 256, timeout_seconds: 10 } }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });
});
