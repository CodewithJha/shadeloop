import type { Dependency } from './api.ts';
import { label } from './App.tsx';

/** What each integration does inside ShadeLoop and what happens without it. Copy only: status always comes from the server. */
const ABOUT: Record<string, { title: string; powers: string; without: string }> = {
  'ai:openai': { title: 'Gemma (open-weight model)', powers: 'Reads your request and field notes, drafts missions. The rule engine checks every draft.', without: 'Template missions and keyword parsing, labelled as such.' },
  'ai:ollama': { title: 'Gemma via Ollama (local)', powers: 'Same as Gemma, running on your own machine.', without: 'Template missions and keyword parsing, labelled as such.' },
  ai: { title: 'Gemma (open-weight model)', powers: 'Reads your request and field notes, drafts missions. The rule engine checks every draft.', without: 'Template missions and keyword parsing, labelled as such.' },
  mongodb: { title: 'MongoDB Atlas', powers: 'Missions, observations, reports and shared place evidence.', without: 'Required. The app cannot plan or sync without it.' },
  'tiger-data': { title: 'Tiger Data', powers: '“Reports here by time of day” (TimescaleDB hypertable + 15-min aggregate) and “Places with similar field reports” (pgvector cosine search over field-report fingerprints).', without: 'Both panels stay hidden.' },
  backboard: { title: 'Backboard', powers: 'Remembers your own earlier requests when “Remember my requests” is on.', without: 'Plans use only today’s request.' },
  openstreetmap: { title: 'OpenStreetMap Overpass', powers: 'Finds mapped parks, gardens and benches near your rounded location.', without: 'Missions don’t name a place, and say so.' },
  serpapi: { title: 'SerpApi', powers: 'Extra place results from Google Maps, next to OpenStreetMap.', without: 'OpenStreetMap results only.' },
  'met-norway': { title: 'MET Norway', powers: 'Backup weather when Open-Meteo fails or rate-limits us.', without: 'Weather is unavailable when Open-Meteo fails.' },
  'open-meteo': { title: 'Open-Meteo', powers: 'Current weather and heat, cold or rain safety notes.', without: 'Missions tell you to check conditions yourself.' },
  fixture: { title: 'Sample places', powers: 'Labelled fake places for offline demos.', without: 'Off in production.' },
  elevenlabs: { title: 'ElevenLabs', powers: 'Reads Field Mode steps aloud, and reads your completion report back.', without: 'Your browser’s built-in voice reads them instead.' },
  'web-speech': { title: 'Browser speech', powers: 'Dictation for notes and the offline read-aloud voice.', without: 'Type notes instead.' },
  sentry: { title: 'Sentry Agent Tracing', powers: 'Traces each plan as an agent run: tool calls, model calls, tokens, fallbacks.', without: 'No traces; the app works the same.' },
};

const GROUPS: [string, (n: string) => boolean][] = [
  ['Open model', (n) => n === 'ai' || n.startsWith('ai:')],
  ['Places & weather', (n) => ['openstreetmap', 'serpapi', 'open-meteo', 'met-norway', 'fixture'].includes(n)],
  ['Memory & data', (n) => ['mongodb', 'tiger-data', 'backboard'].includes(n)],
  ['Voice', (n) => ['elevenlabs', 'web-speech'].includes(n)],
  ['Observability', (n) => n === 'sentry'],
];

/** Plain-language status. VERIFIED needs a real successful call; a key alone is only “configured”. */
const STATUS: Record<string, { text: string; tone: string }> = {
  VERIFIED: { text: 'Live · verified', tone: 'live' },
  CONFIGURED: { text: 'Key set · waiting for first use', tone: 'ready' },
  IMPLEMENTED: { text: 'Ready · no key needed', tone: 'ready' },
  DEGRADED: { text: 'Failing · fallback in use', tone: 'fail' },
  NOT_CONFIGURED: { text: 'Off · fallback in use', tone: 'off' },
  DISABLED: { text: 'Off', tone: 'off' },
};

/**
 * Honest refinements of the server status: a failing source whose job another live source covered is amber, not red;
 * Sentry can't confirm delivery from the server, so it says that instead of "waiting".
 */
export function statusFor(d: Dependency, all: Dependency[]): { text: string; tone: string } {
  const live = (n: string) => all.find((x) => x.name === n)?.status === 'VERIFIED';
  if (d.status === 'DEGRADED' && d.name === 'openstreetmap' && live('serpapi')) return { text: 'Failing · covered by SerpApi', tone: 'covered' };
  if (d.status === 'DEGRADED' && d.name === 'open-meteo' && live('met-norway')) return { text: 'Failing · covered by MET Norway', tone: 'covered' };
  if (d.status === 'DEGRADED' && d.name === 'open-meteo' && /rate limited|429/i.test(d.lastCall?.detail ?? '')) return { text: 'Rate-limited · missions say “check weather yourself”', tone: 'covered' };
  if (d.status === 'CONFIGURED' && d.name === 'fixture') return { text: 'On · sample places, not real', tone: 'ready' };
  if (d.status === 'CONFIGURED' && d.name === 'sentry') return { text: 'On · traces sent, delivery not confirmable here', tone: 'ready' };
  return STATUS[d.status] ?? { text: label(d.status.toLowerCase()), tone: 'off' };
}

function Card({ d, all }: { d: Dependency; all: Dependency[] }) {
  const a = ABOUT[d.name];
  const s = statusFor(d, all);
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

/** Build and deploy tooling. Static by design: these aren't runtime services, so there is no live status to show. */
const BUILT_WITH: { title: string; what: string; links: [string, string][] }[] = [
  { title: 'Render', what: 'Hosts the app and API as one Docker web service, defined in render.yaml and the Dockerfile.', links: [['shadeloop.onrender.com', 'https://shadeloop.onrender.com']] },
  {
    title: 'GitHub Copilot',
    what: 'The Copilot CLI fixed the flaky concurrency test in issue #1 (commit 89b8ead). GitHub Actions runs lint, typecheck, tests, build, a security scan and the Docker build on every push.',
    links: [
      ['Issue #1', 'https://github.com/CodewithJha/shadeloop/issues/1'],
      ['Commit 89b8ead', 'https://github.com/CodewithJha/shadeloop/commit/89b8eada487181a88134341db161312060d1bce4'],
    ],
  },
  { title: 'Entire', what: 'The public agent session behind that fix, so you can see why the code exists.', links: [['Agent session', 'https://entire.io/gh/CodewithJha/shadeloop/commit/89b8eada487181a88134341db161312060d1bce4']] },
];

function BuiltWith() {
  return (
    <section className="integ-group" aria-label="Built and shipped with">
      <h3 className="integ-group-title">Built &amp; shipped with</h3>
      <ul className="integ-list">
        {BUILT_WITH.map((b) => (
          <li key={b.title} className="integ tooling">
            <div className="integ-head">
              <h4>{b.title}</h4>
              <span className="integ-status tooling">Build &amp; deploy tooling</span>
            </div>
            <p className="integ-powers">{b.what}</p>
            <p className="integ-links">
              {b.links.map(([text, href]) => (
                <a key={href} href={href} target="_blank" rel="noreferrer">
                  {text} <span aria-hidden="true">↗</span>
                </a>
              ))}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Integrations({ deps }: { deps: { dependencies: Dependency[]; notImplemented: string[] } }) {
  const list = deps.dependencies;
  const count = (tone: string) => list.filter((d) => statusFor(d, list).tone === tone).length;
  const grouped = GROUPS.map(([name, test]) => [name, list.filter((d) => test(d.name))] as const).filter(([, ds]) => ds.length);
  const rest = list.filter((d) => !GROUPS.some(([, test]) => test(d.name)));
  return (
    <div className="integrations">
      <p className="integ-tally num" aria-label="Integration status summary">
        <span className="live">{count('live')} live</span>
        <span className="ready">{count('ready')} ready</span>
        <span className="covered">{count('covered')} covered</span>
        <span className="fail">{count('fail')} failing</span>
        <span className="off">{count('off')} off</span>
      </p>
      {[...grouped, ...(rest.length ? ([['Other', rest]] as const) : [])].map(([name, ds]) => (
        <section key={name} className="integ-group" aria-label={name}>
          <h3 className="integ-group-title">{name}</h3>
          <ul className="integ-list">
            {ds.map((d) => (
              <Card key={d.name} d={d} all={list} />
            ))}
          </ul>
        </section>
      ))}
      <BuiltWith />
      {deps.notImplemented.length > 0 && <p className="meta">Not used on purpose: {deps.notImplemented.join(', ')}. Nothing is added just for decoration.</p>}
    </div>
  );
}
