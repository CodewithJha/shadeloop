import type { Dependency } from './api.ts';
import { label } from './App.tsx';

/** What each integration does inside ShadeLoop and what happens without it. Copy only: status always comes from the server. */
const ABOUT: Record<string, { title: string; powers: string; without: string }> = {
  'ai:openai': { title: 'Gemma (open-weight model)', powers: 'Reads your request and field notes, drafts missions. The rule engine checks every draft.', without: 'Template missions and keyword parsing, labelled as such.' },
  'ai:ollama': { title: 'Gemma via Ollama (local)', powers: 'Same as Gemma, running on your own machine.', without: 'Template missions and keyword parsing, labelled as such.' },
  ai: { title: 'Gemma (open-weight model)', powers: 'Reads your request and field notes, drafts missions. The rule engine checks every draft.', without: 'Template missions and keyword parsing, labelled as such.' },
  mongodb: { title: 'MongoDB Atlas', powers: 'Missions, observations, reports and shared place evidence.', without: 'Required. The app cannot plan or sync without it.' },
  'tiger-data': { title: 'Tiger Data', powers: '“Reports here by time of day” on a mission’s place (TimescaleDB hypertable + 15-min aggregate).', without: 'The time-of-day panel stays hidden.' },
  backboard: { title: 'Backboard', powers: 'Remembers your own earlier requests when “Remember my requests” is on.', without: 'Plans use only today’s request.' },
  openstreetmap: { title: 'OpenStreetMap Overpass', powers: 'Finds mapped parks, gardens and benches near your rounded location.', without: 'Missions don’t name a place, and say so.' },
  serpapi: { title: 'SerpApi', powers: 'Extra place results from Google Maps, next to OpenStreetMap.', without: 'OpenStreetMap results only.' },
  'open-meteo': { title: 'Open-Meteo', powers: 'Current weather and heat, cold or rain safety notes.', without: 'Missions tell you to check conditions yourself.' },
  fixture: { title: 'Sample places', powers: 'Labelled fake places for offline demos.', without: 'Off in production.' },
  elevenlabs: { title: 'ElevenLabs', powers: 'Reads Field Mode steps aloud in a natural voice.', without: 'Your browser’s built-in voice reads them instead.' },
  'web-speech': { title: 'Browser speech', powers: 'Dictation for notes and the offline read-aloud voice.', without: 'Type notes instead.' },
  sentry: { title: 'Sentry Agent Tracing', powers: 'Traces each plan as an agent run: tool calls, model calls, tokens, fallbacks.', without: 'No traces; the app works the same.' },
};

const GROUPS: [string, (n: string) => boolean][] = [
  ['Open model', (n) => n === 'ai' || n.startsWith('ai:')],
  ['Places & weather', (n) => ['openstreetmap', 'serpapi', 'open-meteo', 'fixture'].includes(n)],
  ['Memory & data', (n) => ['mongodb', 'tiger-data', 'backboard'].includes(n)],
  ['Voice', (n) => ['elevenlabs', 'web-speech'].includes(n)],
  ['Observability', (n) => n === 'sentry'],
];

/** Plain-language status. VERIFIED needs a real successful call; a key alone is only “configured”. */
const STATUS: Record<string, { text: string; tone: string }> = {
  VERIFIED: { text: 'Live · verified', tone: 'live' },
  CONFIGURED: { text: 'Configured · not called yet', tone: 'ready' },
  IMPLEMENTED: { text: 'Ready · no key needed', tone: 'ready' },
  DEGRADED: { text: 'Failing · fallback in use', tone: 'fail' },
  NOT_CONFIGURED: { text: 'Off · fallback in use', tone: 'off' },
  DISABLED: { text: 'Off', tone: 'off' },
};

function Card({ d }: { d: Dependency }) {
  const a = ABOUT[d.name];
  const s = STATUS[d.status] ?? { text: label(d.status.toLowerCase()), tone: 'off' };
  return (
    <li className={`integ ${s.tone}`}>
      <div className="integ-head">
        <h4>{a?.title ?? d.name}</h4>
        <span className={`integ-status ${s.tone}`}>
          <span className="integ-dot" aria-hidden="true" />
          {s.text}
        </span>
      </div>
      <p className="integ-powers">{a?.powers ?? d.role}</p>
      <dl className="integ-facts">
        <dt>Without it</dt>
        <dd>{a?.without ?? 'Not documented.'}</dd>
        <dt>Server says</dt>
        <dd>{d.detail}</dd>
        {d.lastCall && (
          <>
            <dt>Last call</dt>
            <dd className="num">
              {d.lastCall.ok ? 'ok' : 'failed'} at {new Date(d.lastCall.at).toLocaleTimeString()}: {d.lastCall.detail}
            </dd>
          </>
        )}
      </dl>
    </li>
  );
}

export function Integrations({ deps }: { deps: { dependencies: Dependency[]; notImplemented: string[] } }) {
  const list = deps.dependencies;
  const count = (tone: string) => list.filter((d) => (STATUS[d.status]?.tone ?? 'off') === tone).length;
  const grouped = GROUPS.map(([name, test]) => [name, list.filter((d) => test(d.name))] as const).filter(([, ds]) => ds.length);
  const rest = list.filter((d) => !GROUPS.some(([, test]) => test(d.name)));
  return (
    <div className="integrations">
      <p className="integ-tally num" aria-label="Integration status summary">
        <span className="live">{count('live')} live</span>
        <span className="ready">{count('ready')} ready</span>
        <span className="fail">{count('fail')} failing</span>
        <span className="off">{count('off')} off</span>
      </p>
      {[...grouped, ...(rest.length ? ([['Other', rest]] as const) : [])].map(([name, ds]) => (
        <section key={name} className="integ-group" aria-label={name}>
          <h3 className="integ-group-title">{name}</h3>
          <ul className="integ-list">
            {ds.map((d) => (
              <Card key={d.name} d={d} />
            ))}
          </ul>
        </section>
      ))}
      {deps.notImplemented.length > 0 && <p className="meta">Not used on purpose: {deps.notImplemented.join(', ')}. Nothing is added just for decoration.</p>}
    </div>
  );
}
