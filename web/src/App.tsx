import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { CONDITIONS, MISSION_TYPES, type Condition, type Coords, type Mission, type SourceType } from '@shadeloop/shared';
import { api, type HistoryItem, type HourlyReport, type PlanResponse } from './api.ts';
import { cacheMission, dismissOp, enqueue, flush, getCached, getMeta, listCached, listOps, refreshMission, resetStuck, retryFailed, retryOp, subscribe, updateLocal, type CachedMission, type QueuedOp } from './store.ts';
import { Completion, FieldMode } from './Field.tsx';
import { Settings } from './Settings.tsx';
import { canOfferUpdate } from './update.ts';
import { Contours, FieldLabel, Glyph, Sprig, Stamp, StateNote, Trail } from './Marks.tsx';

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
  // Only connectivity and problems are announced; the waiting count changes on every tap and would be noise.
  return (
    <span className={`sync${conflicts || (!online && waiting) ? ' warn' : ''}${online ? '' : ' off'}`}>
      <span className="sync-dot" aria-hidden="true" />
      <span role="status">
        {online ? 'Online' : 'Offline'}
        {conflicts ? ` · ${conflicts} need attention` : ''}
      </span>
      <span className="sync-extra">{!conflicts && (waiting ? ` · ${waiting} waiting` : ' · synced')}</span>
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
      <h2 id="sync-problems" className="flush">
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
              <div className="row gap-top">
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
            <div className="row gap-top">
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
        <span className="tag type">{label(m.type)}</span>
        <span className="tag num">
          ~{m.estimatedMinutes} of {m.availableMinutes} min
        </span>
        <ProvenanceTag m={m} />
      </p>
      <p>{m.description}</p>
      <LocationLine m={m} />
      <p className="kicker">Why it fits</p>
      <ul className="ticks">
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
      <section className="hero" aria-labelledby="discover-title">
        <Contours className="hero-contours" />
        <div className="hero-copy">
          <p className="eyebrow">
            <span>Field journal</span>
            <span className="coords num">{coarse ? `${coarse.lat.toFixed(2)}° · ${coarse.lon.toFixed(2)}°` : 'location: not shared'}</span>
          </p>
          <h1 id="discover-title" className="display">
            Go out for <mark>{minutes || '…'}</mark> minutes.
            <span className="display-sub">Come back with notes.</span>
          </h1>
          <p className="lede">Describe the outing you want. Every mission is checked against your time, walking limits and past field reports before you see it.</p>
        </div>
        <Trail className="hero-trail" />
        <Sprig className="hero-sprig" />
      </section>

      <form className="sheet plan" onSubmit={submit} aria-label="Plan a mission">
        <span className="sheet-tab" aria-hidden="true">
          Expedition brief
        </span>
        <label htmlFor="prompt">What would you like to do?</label>
        <textarea id="prompt" value={prompt} maxLength={500} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. a quiet 20 minute break somewhere shady" />
        <div className="plan-grid">
          <div>
            <label htmlFor="minutes">Minutes available</label>
            <input id="minutes" className="num" type="number" min={5} max={240} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </div>
          <div>
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
        <fieldset className="chips">
          <legend>Must have (only places without contrary reports)</legend>
          <div className="row">
            {CONDITIONS.map((c) => (
              <label key={c} className="chip">
                <input type="checkbox" checked={required.includes(c)} onChange={(e) => setRequired((r) => (e.target.checked ? [...r, c] : r.filter((x) => x !== c)))} />
                <span>{label(c)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="hint">
          {coarse ? 'Your approximate location (about 1 km) will be used to find mapped parks and check the weather.' : 'No location shared. Missions will not name a specific place. You can opt in under Settings.'}
        </p>
        <button className="primary big" type="submit" disabled={busy || !online} aria-describedby={!online ? 'offline-note' : undefined}>
          {busy ? 'Planning… (a local model can take a minute)' : 'Suggest missions'}
          {!busy && <span aria-hidden="true">→</span>}
        </button>
        {!online && (
          <div id="offline-note">
            <StateNote kind="offline">Planning needs a connection. Missions you already opened work offline below.</StateNote>
          </div>
        )}
      </form>
      {busy && <StateNote kind="loading">Checking routes, weather and field reports…</StateNote>}
      {error && (
        <p className="notice error" role="alert">
          Could not plan missions: {error}
        </p>
      )}

      {result && g && (
        <section aria-labelledby="results">
          <FieldLabel n={1} id="results">
            Suggestions
          </FieldLabel>
          <div className="source-strip">
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
          </div>
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
          {result.missions.length === 0 && <StateNote kind="empty">No missions fit those limits. Try more minutes or fewer must-haves.</StateNote>}
          <ol className="entries">
            {result.missions.map((m, i) => (
              <li key={m.id} className="entry">
                <span className="entry-no num" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="entry-title">{m.title}</h3>
                <MissionSummary m={m} />
                <button className="primary" type="button" onClick={() => go(`/m/${m.id}`)}>
                  Open mission <span aria-hidden="true">→</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="saved">
        <FieldLabel n={result ? 2 : 1} id="saved">
          On this device
        </FieldLabel>
        {cached.length === 0 ? (
          <StateNote kind="empty">Your logbook is empty. Missions you open are kept here and work offline.</StateNote>
        ) : (
          <ul className="logbook">
            {cached.slice(0, 10).map((c) => (
              <li key={c.id}>
                <a href={`#/m/${c.id}`}>{c.mission.title}</a>
                <Stamp tone={c.local.status}>{label(c.local.status)}</Stamp>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Reports at this place by local hour of day, from the Tiger Data time-series mirror. Hidden when there are none. */
function PlaceHours({ locationId }: { locationId: string }) {
  const [hours, setHours] = useState<HourlyReport[]>([]);
  useEffect(() => {
    api
      .hourly(locationId)
      .then((r) => setHours(r.hours))
      .catch(() => setHours([]));
  }, [locationId]);
  if (!hours.length) return null;
  const byHour = Map.groupBy(hours, (h) => h.hour);
  return (
    <details>
      <summary>Reports here by time of day (last 90 days, unverified)</summary>
      <ul>
        {[...byHour].map(([hour, rows]) => (
          <li key={hour} className="num">
            {String(hour).padStart(2, '0')}:00 · {rows.map((r) => `${label(r.attribute)}: ${label(r.value)} ×${r.reports}`).join(', ')}
          </li>
        ))}
      </ul>
    </details>
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

  if (!c)
    return error ? (
      <p className="notice error" role="alert">
        Could not load this mission: {error}
      </p>
    ) : online ? (
      <StateNote kind="loading">Opening the mission…</StateNote>
    ) : (
      <StateNote kind="offline">This mission is not saved on this device.</StateNote>
    );
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
      <header className="page-head">
        <p className="eyebrow">
          <span>Mission</span>
          <Stamp tone={local.status}>
            <span className="sr-only">Status: </span>
            {label(local.status)}
          </Stamp>
        </p>
        <h1 className="display small">{m.title}</h1>
        <p className="objective">
          <strong>Objective</strong> {m.objective}
        </p>
      </header>
      <div className="sheet">
        <MissionSummary m={m} />
      </div>
      <FieldLabel n={1}>Steps</FieldLabel>
      <ol className="steps">
        {m.steps.map((s, i) => (
          <li key={i}>
            <span className="step-text">{s.text}</span> <span className="meta num">{s.minutes} min</span>
          </li>
        ))}
      </ol>
      {m.expectations.length > 0 && (
        <>
          <FieldLabel n={2}>What reports say so far</FieldLabel>
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
      {online && m.selectedLocation && <PlaceHours locationId={m.selectedLocation.id} />}
      <FieldLabel n={m.expectations.length > 0 ? 3 : 2}>Safety</FieldLabel>
      <ul className="safety">
        {m.safetyNotes.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      {c.gone && <GoneNotice id={id} />}
      <div className="row actions">
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
      <header className="page-head">
        <p className="eyebrow">
          <span>Logbook</span>
        </p>
        <h1 className="display small">History &amp; insights</h1>
      </header>
      {error && (
        <p className="notice error" role="alert">
          Could not load history: {error}
        </p>
      )}
      {!online && <StateNote kind="offline">Offline: showing missions saved on this device only.</StateNote>}
      {online && !overview && !error && <StateNote kind="loading">Reading your logbook…</StateNote>}
      {overview && (
        <section aria-labelledby="insights">
          <FieldLabel n={1} id="insights">
            Your numbers
          </FieldLabel>
          <dl className="facts num">
            <dt>Completed missions</dt>
            <dd>{overview.missions.completed}</dd>
            <dt>Observations recorded</dt>
            <dd>{overview.observations}</dd>
            <dt>Minutes outside (from reports)</dt>
            <dd>
              {overview.totalMinutesOutside}
              {overview.minutesUserEstimated > 0 && <span className="meta"> (includes {overview.minutesUserEstimated} of your own estimates)</span>}
              {overview.minutesExcluded > 0 && <span className="meta"> ({overview.minutesExcluded} without a reliable duration not counted)</span>}
            </dd>
            <dt>Completion rate</dt>
            <dd>{overview.completionRate === null ? `needs ${overview.minSamples} started missions (have ${overview.sampleSize})` : `${Math.round(overview.completionRate * 100)}%`}</dd>
          </dl>
          {attrs.length > 0 && (
            <table>
              <caption className="meta">
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
      <FieldLabel n={overview ? 2 : 1}>Past missions</FieldLabel>
      {items && items.length === 0 && <StateNote kind="empty">No completed or cancelled missions yet. Your first one will be logged here.</StateNote>}
      <ul className="logbook">
        {(items ?? cached.filter((c) => c.local.status === 'completed' || c.local.status === 'cancelled').map((c) => ({ mission: c.mission, report: null, local: c.local }))).map((it) => (
          <li key={it.mission.id}>
            <a href={`#/m/${it.mission.id}`}>{it.mission.title}</a>
            <Stamp tone={it.mission.status}>{label(it.mission.status)}</Stamp>
            {it.report && <p className="meta logbook-note">{it.report.summary}</p>}
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

/** Typed or toggled form input not yet submitted. Leaving the screen discards it anyway, so a route change clears it. */
function useDirty() {
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const on = () => setDirty(true);
    const off = () => setDirty(false);
    addEventListener('input', on, true);
    addEventListener('submit', off, true);
    addEventListener('hashchange', off);
    return () => {
      removeEventListener('input', on, true);
      removeEventListener('submit', off, true);
      removeEventListener('hashchange', off);
    };
  }, []);
  return dirty;
}

export function App({ onUpdate }: { onUpdate?: () => void }) {
  const sync = useSyncLoop();
  const route = useRoute();
  const dirty = useDirty();
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
            <Glyph />
            <span>ShadeLoop</span>
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
      <main id="main" ref={mainRef} tabIndex={-1} className={page === 'field' ? 'is-field' : undefined}>
        {onUpdate && canOfferUpdate(route, dirty) && (
          <p className="notice row" role="status">
            <span className="grow">A new version of ShadeLoop is ready. Unsynced changes stay on this device.</span>
            <button type="button" onClick={onUpdate}>
              Reload
            </button>
          </p>
        )}
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
      <footer className="foot">
        <span>ShadeLoop · field journal</span>
        <span>Go outside. Write it down.</span>
      </footer>
    </SyncCtx.Provider>
  );
}
