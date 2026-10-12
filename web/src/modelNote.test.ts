import { describe, expect, it } from 'vitest';
import { modelSummary } from './modelNote.ts';

const base = { provider: 'openai', model: 'gemma-4-26b-a4b-it', fallbackUsed: false, fallbackReason: null };

describe('model field note', () => {
  it('credits the model when the engine accepted its drafts', () => {
    expect(modelSummary({ ...base, generator: 'ai', attempts: 2, rejectedCandidates: [] }, 1)).toBe(
      'gemma-4-26b-a4b-it drafted this mission; the rule engine accepted it. (2 model calls.)',
    );
  });
  it('says plainly when the engine refused every draft and templates were used', () => {
    expect(modelSummary({ ...base, generator: 'template', fallbackUsed: true, attempts: 1, rejectedCandidates: ['"X": walking 23 min exceeds your limit of 20 min'] }, 1)).toBe(
      'gemma-4-26b-a4b-it drafted candidates, but the rule engine rejected 1 draft, so these missions come from templates.',
    );
  });
});
