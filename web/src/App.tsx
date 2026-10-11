import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { CONDITIONS, MISSION_TYPES, type Condition, type Coords, type Mission, type SourceType } from '@shadeloop/shared';
import { api, type HistoryItem, type PlanResponse } from './api.ts';
import { cacheMission, dismissOp, enqueue, flush, getCached, getMeta, listCached, listOps, refreshMission, resetStuck, retryFailed, retryOp, subscribe, updateLocal, type CachedMission, type QueuedOp } from './store.ts';
import { Completion, FieldMode } from './Field.tsx';
import { Settings } from './Settings.tsx';

export const label = (s: string) => s.replace(/_/g, ' ');
export const go = (path: string) => {
  location.hash = path;
};

const SOURCE_LABEL: Record<SourceType, string> = {
  verified_external: 'verified source',
  external_map_data: 'map data',
  user_report: 'field report',
  inferred: 'rule',
  ai_suggestion: 'AI suggestion',
  aggregated: 'field evidence',
};

const CHECK_TONE: Record<string, string> = { supported: 'good', contradicted: 'bad', weak_against: 'warn', conflicting: 'warn', stale: 'warn' };

/* ---------------- Sync state shared by all screens ---------------- */

interface SyncState {
  ops: QueuedOp[];
  online: boolean;
  kick: () => void;
}
const SyncCtx = createContext<SyncState>({ ops: [], online: true, kick: () => {} });
export const useSync = () => useContext(SyncCtx);

function useSyncLoop(): SyncState {
  const [ops, setOps] = useState<QueuedOp[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const kick = useCallback(() => {
    // Offline is expected in the field: don't burn retries; the 'online' event triggers a flush.
    if (navigator.onLine) void flush(api.sync, Date.now(), api.mission).catch(() => {});
  }, []);
  useEffect(() => {
    const refresh = () => void listOps().then(setOps);
    const unsub = subscribe(refresh);
    void resetStuck()
      .then(retryFailed)
      .then(() => {
        refresh();
        kick();
      });
    const on = () => {
      setOnline(true);
      void retryFailed().then(kick);
    };
    const off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    const timer = setInterval(kick, 15_000);
    return () => {
      unsub();
      removeEventListener('online', on);
      removeEventListener('offline', off);
      clearInterval(timer);
    };
  }, [kick]);
  return { ops, online, kick };
}

/** Per mission, the unsynced ops from the first refused one on: they are held, not sent, until the user acts. */
function heldOps(ops: QueuedOp[]) {
  const held = new Map<string, QueuedOp[]>();
  for (const o of ops) {
    if (o.state === 'conflict' && !held.has(o.missionId)) held.set(o.missionId, []);
    if (o.state !== 'synced') held.get(o.missionId)?.push(o);
  }
  return held;
}

const opText = (o: QueuedOp) => `${label(o.type)}${o.type === 'observation' ? ` (${label(o.payload.attribute)} = ${label(o.payload.value)})` : ''}`;

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

function SyncBadge() {
  const { ops, online } = useSync();
  const conflicts = [...heldOps(ops).values()].flat().length;
  const waiting = ops.filter((o) => o.state !== 'synced').length - conflicts;
  const text = `${online ? 'Online' : 'Offline'} · ${conflicts ? `${conflicts} need attention` : waiting ? `${waiting} waiting to sync` : 'all synced'}`;
  return (
    <span className={`sync${conflicts || (!online && waiting) ? ' warn' : ''}`} role="status" aria-live="polite">
      {text}
    </span>
  );
}

/** Refused, held and repeatedly failing ops stay visible until the user retries, downloads or discards them. */
function SyncProblems() {
  const { ops, online, kick } = useSync();
  const [cached, setCached] = useState(new Map<string, CachedMission>());
  useEffect(() => void listCached().then((cs) => setCached(new Map(cs.map((c) => [c.id, c])))), [ops]);
  const held = heldOps(ops);
  const stuck = ops.filter((o) => online && o.state === 'failed' && o.attempts >= 4 && !held.has(o.missionId));
  if (!held.size && !stuck.length) return null;

  async function discard(mine: QueuedOp[]) {
    if (!confirm(`Discard ${mine.length} unsynced change${mine.length > 1 ? 's' : ''}? Download them first if you want a copy.`)) return;
    for (const o of mine) await dismissOp(o.opId);
  }

  return (
    <section className="notice warn" aria-labelledby="sync-problems">
      <h2 id="sync-problems" style={{ marginTop: 0 }}>
        Sync needs your attention
      </h2>
      <ul>
        {[...held].map(([id, mine]) => {
          const c = cached.get(id);
          const why = c?.gone
            ? 'this mission no longer exists on the server (unstarted missions expire after 7 days, or it was deleted).'
            : c?.local.status === 'completed' || c?.local.status === 'cancelled'
              ? `the server refused a change because the mission is ${c.local.status}.`
              : 'the server refused a change.';
          return (
            <li key={id}>
              <strong>{c?.mission.title ?? 'A mission'}</strong>: {why} These changes are kept on this device and not sent until you act:
              <ul>
                {mine.map((o) => (
                  <li key={o.opId}>
                    {opText(o)}: {o.state === 'conflict' ? `refused (${o.lastError})` : 'not sent yet'}
                  </li>
                ))}
              </ul>
              <div className="row" style={{ marginTop: '0.4rem' }}>
                {!c?.gone && (
                  <button type="button" onClick={() => void Promise.all(mine.map((o) => retryOp(o.opId))).then(kick)}>
                    Try again
                  </button>
                )}
                <button type="button" onClick={() => download(`shadeloop-unsynced-${id}.json`, { missionId: id, title: c?.mission.title ?? null, exportedAt: new Date().toISOString(), ops: mine })}>
                  Download as JSON
                </button>
                <button type="button" className="danger" onClick={() => void discard(mine)}>
                  Discard these changes
                </button>
              </div>
            </li>
          );
        })}
        {stuck.map((o) => (
          <li key={o.opId}>
            <strong>{opText(o)}</strong>: still failing after {o.attempts} tries: {o.lastError}
            <div className="row" style={{ marginTop: '0.4rem' }}>
              <button type="button" onClick={() => void retryOp(o.opId).then(kick)}>
                Retry now
              </button>
              <button type="button" onClick={() => void dismissOp(o.opId)}>
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Shown instead of mission actions once the server says the mission is gone, so nothing more gets queued for it. */
export function GoneNotice({ id }: { id: string }) {
  return (
    <p className="notice warn" role="status">
      This mission no longer exists on the server: unstarted missions expire after 7 days, and it may have been deleted or belong to an older session. Any changes not yet synced stay on this device,
      listed under “Sync needs your attention” where you can download them. <a href={`#/m/${id}`}>Mission details</a>
    </p>
  );
}

/* ---------------- Shared mission bits ---------------- */

export function ProvenanceTag({ m }: { m: Pick<Mission, 'provenance'> }) {
  const p = m.provenance;
  return p.generator === 'ai' ? (
    <span className="tag ai">AI suggestion · {p.model}</span>
  ) : (
    <span className="tag" title={p.fallbackReason ?? undefined}>
      Template{p.fallbackUsed ? ' · AI not used' : ''}
    </span>
  );
}

function LocationLine({ m }: { m: Mission }) {
  const l = m.selectedLocation;
  if (!l) return <p className="meta">Place: any nearby public outdoor spot you choose.</p>;
  return (
    <p className="meta">
      Place: <strong>{l.name}</strong> ({label(l.category)}){l.isFixture && <span className="tag fixture"> sample fixture, not real</span>}
      {m.travel && <span className="num"> · ~{m.travel.distanceM} m straight-line, ~{m.travel.minutesRoundTrip} min round trip</span>}
      <br />
      <span>
        Source: {l.attribution}, retrieved {new Date(l.retrievedAt).toLocaleString()}
      </span>
    </p>
  );
}

function MissionSummary({ m }: { m: Mission }) {
  return (
    <>
      <p className="row">
        <span className="tag">{label(m.type)}</span>
        <span className="tag num">
          ~{m.estimatedMinutes} of {m.availableMinutes} min
        </span>
        <ProvenanceTag m={m} />
      </p>
      <p>{m.description}</p>
      <LocationLine m={m} />
      <p style={{ margin: '0.6rem 0 0' }}>
        <strong>Why it fits</strong>
      </p>
      <ul>
        {m.whyItMatches.map((w, i) => (
          <li key={i}>
            {w.text} <span className="tag">{SOURCE_LABEL[w.sourceType]}</span>
          </li>
        ))}
      </ul>
      {m.conditionChecks.length > 0 && (
        <p className="row">
          {m.conditionChecks.map((c) => (
            <span key={c.condition} className={`tag ${CHECK_TONE[c.status] ?? ''}`}>
              {label(c.condition)}: {label(c.status)}
              {c.provenance !== 'unknown' && c.verification !== 'verified' ? ' · unverified' : ''}
            </span>
          ))}
        </p>
      )}
      <details>
        <summary>What we don't know ({m.uncertainty.length})</summary>
        <ul>
          {m.uncertainty.map((u, i) => (
            <li key={i}>{u}</li>
          ))}
        </ul>
      </details>
    </>
  );
}

/* ---------------- Discover ---------------- */

function Discover() {
  const { online } = useSync();
  const [prompt, setPrompt] = useState('');
  const [minutes, setMinutes] = useState('20');
  const [type, setType] = useState('');
  const [required, setRequired] = useState<Condition[]>([]);
  const [coarse, setCoarse] = useState<Coords | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PlanResponse | null>(null);
  const [cached, setCached] = useState<CachedMission[]>([]);

  useEffect(() => {
    void getMeta<Coords>('coarse').then(setCoarse);
    void listCached().then(setCached);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.plan({
        prompt: prompt.trim() || undefined,
        availableMinutes: minutes ? Number(minutes) : undefined,
        missionType: (type || undefined) as Mission['type'] | undefined,
        required: required.length ? required : undefined,
        coarseLocation: coarse,
      });
      await Promise.all(r.missions.map(cacheMission));
      setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const g = result?.planning.generation;
  const w = result?.planning.weather;
  return (
    <>
      <h1>Find a short mission</h1>
      <p className="hint">Describe what you want. Missions are checked against your time, walking limits and past field reports before you see them.</p>
      <form onSubmit={submit}>
        <label htmlFor="prompt">What would you like to do?</label>
        <textarea id="prompt" value={prompt} maxLength={500} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. a quiet 20 minute break somewhere shady" />
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 8rem' }}>
            <label htmlFor="minutes">Minutes available</label>
            <input id="minutes" type="number" min={5} max={240} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </div>
          <div style={{ flex: '2 1 12rem' }}>
            <label htmlFor="type">Mission type</label>
            <select id="type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Let ShadeLoop choose</option>
              {MISSION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset>
          <legend>Must have (only places without contrary reports)</legend>
          <div className="row">
            {CONDITIONS.map((c) => (
              <label key={c} className="check">
                <input type="checkbox" checked={required.includes(c)} onChange={(e) => setRequired((r) => (e.target.checked ? [...r, c] : r.filter((x) => x !== c)))} />
                {label(c)}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="hint">
          {coarse ? 'Your approximate location (about 1 km) will be used to find mapped parks and check the weather.' : 'No location shared. Missions will not name a specific place. You can opt in under Settings.'}
        </p>
        <button className="primary" type="submit" disabled={busy || !online} aria-describedby={!online ? 'offline-note' : undefined}>
          {busy ? 'Planning… (a local model can take a minute)' : 'Suggest missions'}
        </button>
        {!online && (
          <p id="offline-note" className="notice">
            Planning needs a connection. Missions you already opened work offline below.
          </p>
        )}
      </form>
      {error && (
        <p className="notice error" role="alert">
          Could not plan missions: {error}
        </p>
      )}

      {result && g && (
        <section aria-labelledby="results">
          <h2 id="results">Suggestions</h2>
          <p className="meta">
            {g.generator === 'ai' ? `Generated by ${g.model} (${g.provider}) and checked by the rule engine.` : `Built from templates. AI was not used: ${g.fallbackReason}.`}
            {result.planning.parse && ` Request understood via ${result.planning.parse.method === 'ai' ? 'AI' : 'keyword matching'}.`}
          </p>
          {w && (
            <p className="meta num">
              {w.available
                ? `Weather (Open-Meteo, ${new Date(w.observedAt!).toLocaleTimeString()}): ${w.temperatureC}°C, feels ${w.apparentTemperatureC}°C, ${w.precipitationMm} mm precipitation.`
                : `Weather unavailable (${w.reason}).`}
            </p>
          )}
          {result.planning.discovery?.sources
            .filter((s) => !s.ok)
            .map((s) => (
              <p key={s.name} className="notice warn" role="status">
                Place search via {s.name} failed ({s.error}), so these missions may not name a specific place.
              </p>
            ))}
          {result.planning.discovery?.limitations.map((l) => (
            <p key={l} className="meta">
              {l}
            </p>
          ))}
          <ul className="list">
            {result.missions.map((m) => (
              <li key={m.id}>
                <h3 style={{ marginTop: 0 }}>{m.title}</h3>
                <MissionSummary m={m} />
                <button className="primary" type="button" style={{ marginTop: '0.6rem' }} onClick={() => go(`/m/${m.id}`)}>
                  Open mission
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {cached.length > 0 && (
        <section aria-labelledby="saved">
          <h2 id="saved">On this device</h2>
          <ul className="list">
            {cached.slice(0, 10).map((c) => (
              <li key={c.id}>
                <a href={`#/m/${c.id}`}>{c.mission.title}</a> <span className="meta">· {label(c.local.status)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/* ---------------- Mission detail ---------------- */

function MissionDetail({ id }: { id: string }) {
  const { online, kick } = useSync();
  const [c, setC] = useState<CachedMission | undefined>();
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => void getCached(id).then(setC);
    load();
    const unsub = subscribe(load);
    if (navigator.onLine) refreshMission(id, api.mission).catch((e: Error) => setError(e.message));
    return unsub;
  }, [id]);

  if (!c) return <p>{error ? `Could not load this mission: ${error}` : online ? 'Loading…' : 'This mission is not saved on this device.'}</p>;
  const { mission: m, local } = c;

  async function start() {
    await enqueue({ type: 'start', missionId: id });
    await updateLocal(id, (l) => ({ ...l, status: 'active', startedAt: new Date().toISOString() }));
    kick();
    go(`/field/${id}`);
  }
  async function cancel() {
    if (!confirm('Cancel this mission?')) return;
    await enqueue({ type: 'cancel', missionId: id });
    await updateLocal(id, (l) => ({ ...l, status: 'cancelled' }));
    kick();
  }

  return (
    <>
      <h1>{m.title}</h1>
      <p className="meta">
        Status: <strong>{label(local.status)}</strong>
      </p>
      <p>
        <strong>Objective:</strong> {m.objective}
      </p>
      <MissionSummary m={m} />
      <h2>Steps</h2>
      <ol className="steps">
        {m.steps.map((s, i) => (
          <li key={i}>
            {s.text} <span className="meta num">({s.minutes} min)</span>
          </li>
        ))}
      </ol>
      {m.expectations.length > 0 && (
        <>
          <h2>What reports say so far</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Attribute</th>
                <th scope="col">Estimate</th>
                <th scope="col">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {m.expectations.map((e) => (
                <tr key={e.attribute}>
                  <td>{label(e.attribute)}</td>
                  <td>{e.estimate ? label(e.estimate) : 'unknown'}</td>
                  <td>{e.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">You will be asked to check these in the field. Your reports update the estimates for everyone.</p>
        </>
      )}
      <h2>Safety</h2>
      <ul>
        {m.safetyNotes.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      {c.gone && <GoneNotice id={id} />}
      <div className="row" style={{ marginTop: '1.2rem' }}>
        {!c.gone && local.status === 'planned' && (
          <>
            <button className="primary" type="button" onClick={() => void start()}>
              Start in Field Mode
            </button>
            <button type="button" onClick={() => void cancel()}>
              Cancel mission
            </button>
          </>
        )}
        {!c.gone && (local.status === 'active' || local.status === 'paused') && (
          <button className="primary" type="button" onClick={() => go(`/field/${id}`)}>
            Continue in Field Mode
          </button>
        )}
        {local.status === 'completed' && (
          <button type="button" onClick={() => go(`/done/${id}`)}>
            View completion report
          </button>
        )}
      </div>
    </>
  );
}

/* ---------------- History & insights ---------------- */

function History() {
  const { online } = useSync();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [overview, setOverview] = useState<Record<string, any> | null>(null);
  const [attrs, setAttrs] = useState<Record<string, any>[]>([]);
  const [cached, setCached] = useState<CachedMission[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void listCached().then(setCached);
    if (!online) return;
    Promise.all([api.history(), api.overview(), api.attributes()])
      .then(([h, o, a]) => {
        setItems(h.items);
        setOverview(o);
        setAttrs(a.items.filter((i) => i.observations > 0));
      })
      .catch((e: Error) => setError(e.message));
  }, [online]);

  return (
    <>
      <h1>History &amp; insights</h1>
      {error && <p className="notice error">Could not load history: {error}</p>}
      {!online && <p className="notice">Offline: showing missions saved on this device only.</p>}
      {overview && (
        <section aria-labelledby="insights">
          <h2 id="insights">Your numbers</h2>
          <dl className="facts num">
            <dt>Completed missions</dt>
            <dd>{overview.missions.completed}</dd>
            <dt>Observations recorded</dt>
            <dd>{overview.observations}</dd>
            <dt>Minutes outside (from reports)</dt>
            <dd>{overview.totalMinutesOutside}</dd>
            <dt>Completion rate</dt>
            <dd>{overview.completionRate === null ? `needs ${overview.minSamples} started missions (have ${overview.sampleSize})` : `${Math.round(overview.completionRate * 100)}%`}</dd>
          </dl>
          {attrs.length > 0 && (
            <table>
              <caption className="meta" style={{ textAlign: 'left' }}>
                Your observations, and how often they matched what reports predicted
              </caption>
              <thead>
                <tr>
                  <th scope="col">Attribute</th>
                  <th scope="col">Reported values</th>
                  <th scope="col">Matched expectation</th>
                </tr>
              </thead>
              <tbody>
                {attrs.map((a) => (
                  <tr key={a.attribute}>
                    <td>{label(a.attribute)}</td>
                    <td>
                      {Object.entries(a.valueCounts as Record<string, number>)
                        .map(([v, n]) => `${label(v)} ×${n}`)
                        .join(', ')}
                    </td>
                    <td>{a.expectationMatchRate === null ? 'not enough data' : `${Math.round(a.expectationMatchRate * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      <h2>Past missions</h2>
      {items && items.length === 0 && <p>No completed or cancelled missions yet.</p>}
      <ul className="list">
        {(items ?? cached.filter((c) => c.local.status === 'completed' || c.local.status === 'cancelled').map((c) => ({ mission: c.mission, report: null, local: c.local }))).map((it) => (
          <li key={it.mission.id}>
            <a href={`#/m/${it.mission.id}`}>{it.mission.title}</a> <span className="meta">· {label(it.mission.status)}</span>
            {it.report && <p className="meta">{it.report.summary}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}

/* ---------------- Shell ---------------- */

function useRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return hash.replace(/^#/, '') || '/';
}

export function App() {
  const sync = useSyncLoop();
  const route = useRoute();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => mainRef.current?.focus(), [route]);
  const [, page, id] = route.split('/');
  const nav = [
    ['/', 'Discover'],
    ['/history', 'History'],
    ['/settings', 'Settings'],
  ];
  return (
    <SyncCtx.Provider value={sync}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="top-inner">
          <a className="brand" href="#/">
            ShadeLoop
          </a>
          <nav aria-label="Main">
            <ul>
              {nav.map(([href, text]) => (
                <li key={href}>
                  <a href={`#${href}`} aria-current={route === href ? 'page' : undefined}>
                    {text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <SyncBadge />
        </div>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1}>
        <SyncProblems />
        {page === 'm' && id ? (
          <MissionDetail id={id} />
        ) : page === 'field' && id ? (
          <FieldMode id={id} />
        ) : page === 'done' && id ? (
          <Completion id={id} />
        ) : page === 'history' ? (
          <History />
        ) : page === 'settings' ? (
          <Settings />
        ) : (
          <Discover />
        )}
      </main>
    </SyncCtx.Provider>
  );
}
