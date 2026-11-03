import { describe, expect, it } from 'vitest';
import { lexicalTerms } from './retrieval.service.js';

describe('lexicalTerms', () => {
  it('drops function and question words that would prefix-match everything', () => {
    expect(lexicalTerms('How are GitHub webhook signatures verified?')).toEqual(['git', 'hub', 'webhook', 'signatures', 'verified']);
    expect(lexicalTerms('Where is the CSRF token checked?')).toEqual(['csrf', 'token', 'checked']);
  });

  it('keeps identifiers, splitting camelCase, snake_case and paths into parts', () => {
    expect(lexicalTerms('verifyWebhookSignature in src/github/webhooks.controller.ts')).toEqual(['verify', 'webhook', 'signature', 'src', 'github', 'webhooks', 'controller', 'ts']);
    expect(lexicalTerms('MAX_DURATION_SECONDS')).toEqual(['max', 'duration', 'seconds']);
  });

  it('keeps the original terms when a query is only function words', () => {
    expect(lexicalTerms('how is it')).toEqual(['how', 'is', 'it']);
  });

  it('deduplicates and bounds the term list', () => {
    expect(lexicalTerms('token token TOKEN')).toEqual(['token']);
    expect(lexicalTerms(Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '))).toHaveLength(32);
  });
});
