/** Deterministic, AI-free implementations so the full workflow runs without any model. */
import type { Attribute, Condition, MissionType, ObservationValue } from '@shadeloop/shared';
import type { Candidate } from './domain.ts';

type TemplateStep = { text: string; minutes: number; kind: 'walk' | 'still' | 'observe'; flex?: true };

const TEMPLATES: Record<MissionType, { title: string; objective: string; description: string; steps: TemplateStep[]; prompts: Attribute[] }> = {
  quiet_break: {
    title: 'Quiet break outside',
    objective: 'Spend unhurried time somewhere calm and note what it is really like.',
    description: 'A short, still break outdoors. No goals beyond resting and noticing.',
    steps: [
      { text: 'Find a place to sit or stand comfortably. Put your phone on silent.', minutes: 1, kind: 'still' },
      { text: 'Rest quietly. Let your attention settle on what is around you.', minutes: 1, kind: 'still', flex: true },
      { text: 'Note the noise level, shade and how busy it is.', minutes: 2, kind: 'observe' },
      { text: 'Take one slow breath and head back when ready.', minutes: 1, kind: 'still' },
    ],
    prompts: ['noise_level', 'shade_quality', 'crowding', 'bench_availability'],
  },
  nature_observation: {
    title: 'Notice living things',
    objective: 'Look closely at one small patch of nature.',
    description: 'Pick a tree, hedge or patch of grass and see how much life you can spot.',
    steps: [
      { text: 'Pick one small area: a tree, a patch of grass or a hedge.', minutes: 1, kind: 'observe' },
      { text: 'Look closely. Count the different plants, insects or birds you notice. No need to name them.', minutes: 1, kind: 'observe', flex: true },
      { text: 'Record shade, noise and crowding.', minutes: 2, kind: 'observe' },
      { text: 'Pick one thing you noticed to remember.', minutes: 1, kind: 'still' },
    ],
    prompts: ['shade_quality', 'noise_level', 'crowding'],
  },
  sensory_exploration: {
    title: 'Five senses check-in',
    objective: 'Notice your surroundings through each sense in turn.',
    description: 'A grounding exercise outdoors: see, hear, touch, smell.',
    steps: [
      { text: 'Stand or sit still somewhere you feel safe.', minutes: 1, kind: 'still' },
      { text: 'Notice in turn: five things you see, four you hear, three you can touch, two you smell.', minutes: 1, kind: 'observe', flex: true },
      { text: 'Record the noise level and how the temperature feels.', minutes: 2, kind: 'observe' },
      { text: 'Notice how you feel now compared with when you started.', minutes: 1, kind: 'still' },
    ],
    prompts: ['noise_level', 'temperature_feel', 'crowding'],
  },
  neighborhood_exploration: {
    title: 'Small-detail street walk',
    objective: 'Walk a public street or path you rarely use and spot small details.',
    description: 'Slow exploration of your own area, on public ground only.',
    steps: [
      { text: 'Choose a public street or path you have not walked before.', minutes: 1, kind: 'still' },
      { text: 'Walk slowly and look for small details: plants in cracks, signs, textures.', minutes: 1, kind: 'walk', flex: true },
      { text: 'Record path condition, crowding and noise.', minutes: 2, kind: 'observe' },
      { text: 'Head back by a familiar route.', minutes: 1, kind: 'still' },
    ],
    prompts: ['path_condition', 'crowding', 'noise_level', 'step_free_access'],
  },
  mindful_walk: {
    title: 'Slow mindful walk',
    objective: 'Walk more slowly than usual and pay attention to each step.',
    description: 'An easy-paced walk focused on breathing and footsteps.',
    steps: [
      { text: 'Stand still and feel your feet on the ground.', minutes: 1, kind: 'still' },
      { text: 'Walk at a slower pace than usual. Pay attention to each step and your breathing.', minutes: 1, kind: 'walk', flex: true },
      { text: 'Record path condition and shade.', minutes: 2, kind: 'observe' },
      { text: 'Pause for a moment before heading back.', minutes: 1, kind: 'still' },
    ],
    prompts: ['path_condition', 'shade_quality', 'step_free_access'],
  },
  environmental_observation: {
    title: 'Sun and shade comparison',
    objective: 'Compare a shaded and a sunny spot and note the differences.',
    description: 'Observe how shade, surfaces and wind change how a place feels.',
    steps: [
      { text: 'Look around: note sun, shade, wind and surfaces.', minutes: 1, kind: 'observe' },
      { text: 'Compare a shaded and a sunny patch. Notice temperature, light and what grows there.', minutes: 1, kind: 'observe', flex: true },
      { text: 'Record shade quality, temperature feel and noise.', minutes: 2, kind: 'observe' },
      { text: 'Note one thing that would make this place more comfortable.', minutes: 1, kind: 'still' },
    ],
    prompts: ['shade_quality', 'temperature_feel', 'noise_level'],
  },
};

/** Build a template candidate whose steps fit `stepBudget` minutes, with walking capped at `walkBudget`. Null if it can't fit. */
export function buildTemplate(type: MissionType, stepBudget: number, walkBudget: number, location: { id: string; name: string } | null): Candidate | null {
  const t = TEMPLATES[type];
  const fixed = t.steps.filter((s) => !s.flex).reduce((n, s) => n + s.minutes, 0);
  const flexStep = t.steps.find((s) => s.flex)!;
  let flex = stepBudget - fixed;
  if (flexStep.kind === 'walk') flex = Math.min(flex, walkBudget);
  if (flex < 1) return null;
  const place = location ? location.name : 'a nearby public outdoor spot you already know';
  return {
    title: t.title,
    description: `${t.description} Place: ${place}.`,
    type,
    objective: t.objective,
    locationId: location?.id ?? null,
    steps: t.steps.map(({ text, minutes, kind, flex: isFlex }) => ({ text, kind, minutes: isFlex ? flex : minutes })),
    observationPrompts: t.prompts,
    whyItMatches: `Template mission for "${type.replace(/_/g, ' ')}" sized to your available time.`,
  };
}

const RELATED: Record<MissionType, MissionType[]> = {
  quiet_break: ['sensory_exploration', 'nature_observation'],
  nature_observation: ['environmental_observation', 'quiet_break'],
  sensory_exploration: ['quiet_break', 'mindful_walk'],
  neighborhood_exploration: ['mindful_walk', 'environmental_observation'],
  mindful_walk: ['neighborhood_exploration', 'sensory_exploration'],
  environmental_observation: ['nature_observation', 'neighborhood_exploration'],
};
export const relatedTypes = (t: MissionType) => RELATED[t];

const TYPE_KEYWORDS: [RegExp, MissionType][] = [
  [/\b(mindful|meditat\w*|slow walk)\b/i, 'mindful_walk'],
  [/\b(neighbou?rhood|explore|street|block|wander)\b/i, 'neighborhood_exploration'],
  [/\b(bird|tree|plant|flower|insect|nature|green)\w*/i, 'nature_observation'],
  [/\b(listen|sound|smell|touch|senses?|sensory|grounding)\b/i, 'sensory_exploration'],
  [/\b(air|environment\w*|weather|sun|heat|litter)\b/i, 'environmental_observation'],
  [/\b(quiet|break|rest|calm|breather|sit)\b/i, 'quiet_break'],
  [/\b(walk|stroll)\b/i, 'mindful_walk'],
];

const CONDITION_KEYWORDS: [RegExp, Condition][] = [
  [/\b(shade|shady|shaded)\b/i, 'shade'],
  [/\b(bench|seat|seating|sit down)\b/i, 'bench'],
  [/\b(quiet|calm|peaceful)\b/i, 'quiet'],
  [/\b(not crowded|uncrowded|empty|few people|crowd\w*)\b/i, 'not_crowded'],
  [/\b(wheelchair|step[- ]free|no stairs|accessible)\b/i, 'step_free'],
  [/\b(smooth|paved|stroller|pram)\b/i, 'smooth_path'],
];

/** Keyword parse of a free-text request. Conditions found are treated as preferred; only explicit UI choices or prefs make them required. */
export function keywordConstraints(prompt: string) {
  let availableMinutes: number | undefined;
  const min = prompt.match(/(\d{1,3})\s*(?:-\s*)?(?:min|mins|minutes)\b/i);
  const hr = prompt.match(/(\d(?:\.\d)?)\s*(?:h|hr|hrs|hour|hours)\b/i);
  if (min) availableMinutes = Number(min[1]);
  else if (hr) availableMinutes = Math.round(Number(hr[1]) * 60);
  else if (/\bhalf an hour\b/i.test(prompt)) availableMinutes = 30;
  else if (/\b(an|one) hour\b/i.test(prompt)) availableMinutes = 60;
  if (availableMinutes !== undefined && (availableMinutes < 5 || availableMinutes > 240)) availableMinutes = undefined;
  return {
    missionType: TYPE_KEYWORDS.find(([re]) => re.test(prompt))?.[1],
    availableMinutes,
    required: [] as Condition[],
    preferred: [...new Set(CONDITION_KEYWORDS.filter(([re]) => re.test(prompt)).map(([, c]) => c))],
  };
}

const NOTE_RULES: [RegExp, ObservationValue][] = [
  [/\b(no|couldn'?t find|without) (a )?(bench|benches|seat)/i, { attribute: 'bench_availability', value: 'not_found' }],
  [/\b(bench|benches|seat)\b/i, { attribute: 'bench_availability', value: 'found' }],
  [/\b(no|zero|without) shade\b/i, { attribute: 'shade_quality', value: 'none' }],
  [/\b(some|little|bit of|partial|patchy) shade\b/i, { attribute: 'shade_quality', value: 'partial' }],
  [/\b(shady|lots of shade|good shade|plenty of shade|shaded)\b/i, { attribute: 'shade_quality', value: 'good' }],
  [/\b(loud|noisy|traffic noise)\b/i, { attribute: 'noise_level', value: 'loud' }],
  [/\b(quiet|silent|peaceful)\b/i, { attribute: 'noise_level', value: 'quiet' }],
  [/\b(busy|crowded|packed|lots of people)\b/i, { attribute: 'crowding', value: 'busy' }],
  [/\b(empty|nobody|no one|deserted)\b/i, { attribute: 'crowding', value: 'empty' }],
  [/\b(hotter|very hot|too hot|boiling)\b/i, { attribute: 'temperature_feel', value: 'hotter_than_expected' }],
  [/\b(colder|cooler|chilly)\b/i, { attribute: 'temperature_feel', value: 'cooler_than_expected' }],
  [/\b(blocked|closed off|path closed)\b/i, { attribute: 'path_condition', value: 'blocked' }],
  [/\b(uneven|muddy|bumpy|potholes?)\b/i, { attribute: 'path_condition', value: 'uneven' }],
  [/\b(stairs|steps only|no ramp)\b/i, { attribute: 'step_free_access', value: 'no' }],
  [/\b(ramp|step[- ]free|level access)\b/i, { attribute: 'step_free_access', value: 'yes' }],
];

/** Keyword parse of a field note. First match per attribute wins (negations are listed first). */
export function keywordObservations(text: string): ObservationValue[] {
  const out = new Map<Attribute, ObservationValue>();
  for (const [re, obs] of NOTE_RULES) if (!out.has(obs.attribute) && re.test(text)) out.set(obs.attribute, obs);
  return [...out.values()];
}

export function templateSummary(r: {
  title: string;
  completionStatus: string;
  plannedMinutes: number;
  actualMinutes: number;
  observationCount: number;
  comparisons: { attribute: string; result: string }[];
}) {
  const diffs = r.comparisons.filter((c) => c.result.startsWith('observed_'));
  const parts = [
    `${r.completionStatus === 'partial' ? 'Partly completed' : 'Completed'} "${r.title}" in about ${r.actualMinutes} min (planned ${r.plannedMinutes}).`,
    r.observationCount ? `You recorded ${r.observationCount} observation${r.observationCount === 1 ? '' : 's'}.` : 'No observations were recorded.',
  ];
  if (diffs.length) {
    parts.push(`Differed from expectations: ${diffs.map((d) => `${d.attribute.replace(/_/g, ' ')} (${d.result.replace('observed_', '').replace(/_/g, ' ')})`).join(', ')}.`);
  }
  return parts.join(' ');
}
