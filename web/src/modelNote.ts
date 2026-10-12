import type { PlanResponse } from './api.ts';

/** One honest sentence on what the model drafted and what the rule engine kept, built only from the plan response. */
export function modelSummary(g: PlanResponse['planning']['generation'], accepted: number): string {
  const rejected = g.rejectedCandidates?.length ?? 0;
  const calls = g.attempts && g.attempts > 1 ? ` (${g.attempts} model calls.)` : '';
  const drafts = `${rejected} draft${rejected === 1 ? '' : 's'}`;
  if (g.generator !== 'ai')
    return `${g.model} drafted candidates, but the rule engine ${rejected ? `rejected ${drafts}` : 'accepted none'}, so these missions come from templates.${calls}`;
  const kept = accepted === 1 ? 'this mission; the rule engine accepted it' : `these ${accepted} missions; the rule engine accepted them`;
  return `${g.model} drafted ${kept}${rejected ? ` and rejected ${drafts}` : ''}.${calls}`;
}
