import { useEffect, useState, type FormEvent } from 'react';
import { ATTRIBUTES, MAX_ACTUAL_MINUTES, type Attribute, type Preferences, type Report } from '@shadeloop/shared';
import { api } from './api.ts';
import { enqueue, getCached, getMeta, subscribe, updateLocal, type CachedMission } from './store.ts';
import { GoneNotice, go, label, useSync } from './App.tsx';

function useCached(id: string) {
  const [c, setC] = useState<CachedMission | null | undefined>();
  useEffect(() => {
    const load = () => void getCached(id).then((x) => setC(x ?? null));
    load();
    return subscribe(load);
  }, [id]);
  return c;
}

type Recognition = { lang: string; interimResults: boolean; start(): void; stop(): void; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onerror: (e: { error: string }) => void; onend: () => void };
const SpeechRecognitionCtor = (globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ??
  (globalThis as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

/* ---------------- Field Mode ---------------- */

export function FieldMode({ id }: { id: string }) {
  const c = useCached(id);
  const { ops, online, kick } = useSync();
  const [prefs, setPrefs] = useState<Preferences | undefined>();
  const [announce, setAnnounce] = useState('');
  const [note, setNote] = useState('');
  const [proposals, setProposals] = useState<{ attribute: string; value: string }[] | null>(null);
  const [parseInfo, setParseInfo] = useState('');
  const [listening, setListening] = useState(false);

  useEffect(() => void getMeta<Preferences>('prefs').then(setPrefs), []);

  if (c === undefined) return <p>Loading…</p>;
  if (c === null) return <p className="notice">This mission is not saved on this device. Open it once while online to use it in the field.</p>;
  const { mission: m, local } = c;
  const step = Math.min(local.currentStep, m.steps.length - 1);
  const pending = ops.filter((o) => o.missionId === id && o.state !== 'synced').length;

  if (c.gone) return <GoneNotice id={id} />;
  if (local.status === 'planned') {
    return (
      <p className="notice">
        This mission hasn't started. <a href={`#/m/${id}`}>Go to the mission</a>
      </p>
    );
  }
  if (local.status === 'completed' || local.status === 'cancelled') {
    return (
      <p className="notice">
        This mission is {local.status}. <a href={`#/${local.status === 'completed' ? 'done' : 'm'}/${id}`}>See details</a>
      </p>
    );
  }

  const setStep = (n: number) => void updateLocal(id, (l) => ({ ...l, currentStep: n }));

  async function record(attribute: Attribute, value: string) {
    const q = await enqueue({ type: 'observation', missionId: id, payload: { attribute, value } });
    await updateLocal(id, (l) => ({ ...l, observations: [...l.observations, { opId: q.opId, attribute, value, at: q.clientTs }] }));
    setAnnounce(`Saved: ${label(attribute)} is ${label(value)}.`);
    kick();
  }

  async function transition(type: 'pause' | 'resume' | 'cancel') {
    if (type === 'cancel' && !confirm('Cancel this mission? Observations already recorded are kept.')) return;
    await enqueue({ type, missionId: id, payload: { currentStep: step } });
    await updateLocal(id, (l) => ({ ...l, status: type === 'pause' ? 'paused' : type === 'resume' ? 'active' : 'cancelled' }));
    kick();
    if (type === 'cancel') go(`/m/${id}`);
  }

  function dictate() {
    if (!SpeechRecognitionCtor) return;
    const r = new SpeechRecognitionCtor();
    r.lang = 'en';
    r.interimResults = false;
    r.onresult = (e) => setNote((n) => `${n} ${Array.from(e.results, (x) => x[0].transcript).join(' ')}`.trim());
    r.onerror = (e) => setParseInfo(`Speech recognition error: ${e.error}`);
    r.onend = () => setListening(false);
    setListening(true);
    r.start();
  }

  async function suggest(e: FormEvent) {
    e.preventDefault();
    setParseInfo('');
    try {
      const r = await api.parseNote(id, note);
      setProposals(r.proposals);
      setParseInfo(r.method === 'ai' ? `Suggested by ${r.model}. Check before saving.` : `Matched by keywords (AI not used: ${r.fallbackReason}). Check before saving.`);
    } catch (err) {
      setParseInfo(`Could not read the note: ${(err as Error).message}`);
    }
  }

  const canSpeak = prefs?.voice.readStepsAloud && 'speechSynthesis' in globalThis;
  const recorded = new Map(local.observations.map((o) => [o.attribute, o.value]));

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>{m.title}</h1>
      <p className="meta num">
        Step {step + 1} of {m.steps.length} · {label(local.status)} · {pending ? `${pending} change${pending > 1 ? 's' : ''} waiting to sync` : 'synced'}
        {!online && ' · offline, saved on this device'}
      </p>
      {local.status === 'paused' && <p className="notice">Paused. Resume when you are ready.</p>}

      <p className="field-step" key={step} data-anim aria-live="polite">
        {m.steps[step].text}
      </p>
      <p className="meta num">About {m.steps[step].minutes} min</p>
      <div className="row field-controls">
        <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Previous
        </button>
        <button type="button" className="primary" disabled={step === m.steps.length - 1} onClick={() => setStep(step + 1)}>
          Next step
        </button>
        {canSpeak && (
          <button type="button" onClick={() => speechSynthesis.speak(new SpeechSynthesisUtterance(m.steps[step].text))}>
            Read aloud
          </button>
        )}
      </div>

      <h2>Quick observations</h2>
      <p className="meta" role="status" aria-live="polite">
        {announce || 'Tap what you notice. Each tap is saved on this device and synced when possible.'}
      </p>
      {m.observationPrompts.map((attr) => (
        <div className="obs-group" key={attr} role="group" aria-labelledby={`obs-${attr}`}>
          <h3 id={`obs-${attr}`}>{label(attr)}</h3>
          <div className="row">
            {ATTRIBUTES[attr].map((v) => (
              <button key={v} type="button" aria-pressed={recorded.get(attr) === v} onClick={() => void record(attr, v)}>
                {label(v)}
              </button>
            ))}
          </div>
        </div>
      ))}

      <details>
        <summary>Add a note (optional)</summary>
        <form onSubmit={suggest}>
          <label htmlFor="note">Describe what you notice</label>
          <textarea id="note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="e.g. no bench, patchy shade, quite noisy" />
          <p className="hint">Notes are only used to suggest observations. They are not stored.</p>
          <div className="row">
            {prefs?.voice.voiceNotes && SpeechRecognitionCtor && (
              <button type="button" onClick={dictate} disabled={listening}>
                {listening ? 'Listening…' : 'Dictate'}
              </button>
            )}
            <button type="submit" disabled={!online || !note.trim()}>
              Suggest observations
            </button>
          </div>
          {prefs?.voice.voiceNotes && SpeechRecognitionCtor && <p className="hint">Dictation uses your browser's speech recognition, which may send audio to the browser vendor.</p>}
          {!online && <p className="hint">Suggestions need a connection. The quick buttons work offline.</p>}
        </form>
        {parseInfo && (
          <p className="meta" role="status">
            {parseInfo}
          </p>
        )}
        {proposals && proposals.length === 0 && <p>No observations recognised.</p>}
        {proposals?.map((p) => (
          <p key={`${p.attribute}-${p.value}`} className="row">
            {label(p.attribute)}: <strong>{label(p.value)}</strong>
            <button type="button" onClick={() => void record(p.attribute as Attribute, p.value).then(() => setProposals((ps) => ps!.filter((x) => x !== p)))}>
              Save
            </button>
          </p>
        ))}
      </details>

      <h2>Mission</h2>
      <div className="row field-controls">
        {local.status === 'active' ? (
          <button type="button" onClick={() => void transition('pause')}>
            Pause
          </button>
        ) : (
          <button type="button" onClick={() => void transition('resume')}>
            Resume
          </button>
        )}
        <button type="button" className="primary" onClick={() => go(`/done/${id}`)}>
          End mission
        </button>
        <button type="button" className="danger" onClick={() => void transition('cancel')}>
          Cancel
        </button>
      </div>
      <ul className="hint">
        {m.safetyNotes.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </>
  );
}

/* ---------------- Completion ---------------- */

export function Completion({ id }: { id: string }) {
  const c = useCached(id);
  const { ops, online, kick } = useSync();
  const [status, setStatus] = useState<'completed' | 'partial'>('completed');
  const [minutes, setMinutes] = useState('');
  const [rating, setRating] = useState('');
  const [feedback, setFeedback] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState('');
  const reportId = c?.local.reportId;

  useEffect(() => {
    if (!reportId || !online) return;
    api
      .report(reportId)
      .then(setReport)
      .catch((e: Error) => setReportError(e.message));
  }, [reportId, online]);

  if (c === undefined) return <p>Loading…</p>;
  if (c === null) return <p className="notice">This mission is not saved on this device.</p>;
  const { mission: m, local } = c;
  const opState = new Map(ops.map((o) => [o.opId, o.state]));

  async function finish(e: FormEvent) {
    e.preventDefault();
    await enqueue({
      type: 'complete',
      missionId: id,
      payload: {
        completionStatus: status,
        currentStep: local.currentStep,
        ...(minutes ? { actualMinutes: Number(minutes) } : {}),
        ...(rating ? { rating: Number(rating) } : {}),
        ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
      },
    });
    await updateLocal(id, (l) => ({ ...l, status: 'completed', completedAt: new Date().toISOString() }));
    kick();
  }

  if (c.gone && (local.status === 'active' || local.status === 'paused')) return <GoneNotice id={id} />;
  if (local.status === 'active' || local.status === 'paused') {
    return (
      <>
        <h1>Finish “{m.title}”</h1>
        <form onSubmit={finish}>
          <fieldset>
            <legend>How did it go?</legend>
            <label className="check">
              <input type="radio" name="status" checked={status === 'completed'} onChange={() => setStatus('completed')} /> Completed
            </label>
            <label className="check">
              <input type="radio" name="status" checked={status === 'partial'} onChange={() => setStatus('partial')} /> Partly done
            </label>
          </fieldset>
          <label htmlFor="mins">Minutes spent (optional, otherwise measured from start/end)</label>
          <input id="mins" type="number" min={0} max={MAX_ACTUAL_MINUTES} step={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          <label htmlFor="rating">Rating (optional)</label>
          <select id="rating" value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">No rating</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} of 5
              </option>
            ))}
          </select>
          <label htmlFor="fb">Feedback (optional, private to you)</label>
          <textarea id="fb" value={feedback} maxLength={1000} onChange={(e) => setFeedback(e.target.value)} />
          <div className="row" style={{ marginTop: '1rem' }}>
            <button className="primary" type="submit">
              Finish mission
            </button>
            <button type="button" onClick={() => go(`/field/${id}`)}>
              Back to Field Mode
            </button>
          </div>
        </form>
      </>
    );
  }

  const deviceMinutes = local.startedAt && local.completedAt ? Math.round((Date.parse(local.completedAt) - Date.parse(local.startedAt)) / 60_000) : null;
  return (
    <>
      <h1>{m.title}: {local.status}</h1>
      <h2>Planned vs actual</h2>
      <table className="num">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Planned</th>
            <th scope="col">Actual</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Minutes</th>
            <td>{m.estimatedMinutes}</td>
            <td>
              {report
                ? report.actual.minutes === null
                  ? 'unknown (start/end times were implausible)'
                  : report.actual.minutesSource === 'user'
                    ? `${report.actual.minutes} (your estimate${typeof report.actual.measuredMinutes === 'number' ? `; measured ${report.actual.measuredMinutes}` : ''})`
                    : `${report.actual.minutes} (measured from start/end times)`
                : deviceMinutes !== null
                  ? `~${deviceMinutes} (this device, includes pauses)`
                  : 'unknown'}
            </td>
          </tr>
          <tr>
            <th scope="row">Steps</th>
            <td>{m.steps.length}</td>
            <td>{report ? report.actual.stepsReached : local.currentStep + 1} reached</td>
          </tr>
        </tbody>
      </table>

      <h2>Your observations</h2>
      {local.observations.length === 0 ? (
        <p>None recorded on this device.</p>
      ) : (
        <ul>
          {local.observations.map((o) => (
            <li key={o.opId}>
              {label(o.attribute)}: <strong>{label(o.value)}</strong> <span className="meta">· {opState.get(o.opId) ?? 'synced'}</span>
            </li>
          ))}
        </ul>
      )}

      <h2>Report</h2>
      {report ? (
        <>
          <p>{report.summary.text}</p>
          <p className="meta">
            {report.summary.generator === 'ai'
              ? `Older summary written by AI (${report.summary.model}); it may be inaccurate. The tables are the record.`
              : 'Built by a fixed template from your recorded facts. No AI was used.'}
          </p>
          {report.comparisons.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th scope="col">Attribute</th>
                  <th scope="col">Expected</th>
                  <th scope="col">You found</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {report.comparisons.map((x) => (
                  <tr key={x.attribute}>
                    <td>{label(x.attribute)}</td>
                    <td>{x.expected ? `${label(x.expected)}${x.expectedConfidence ? ` (${x.expectedConfidence})` : ''}` : 'no prior reports'}</td>
                    <td>{label(x.observed)}</td>
                    <td>{label(x.result.replace('observed_', ''))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {report.evidenceRefs.length > 0 && (
            <>
              <h3>Shared evidence for this place now</h3>
              <ul>
                {report.evidenceRefs.map((e) => (
                  <li key={e.attribute}>
                    {label(e.attribute)}: {e.estimate ? label(e.estimate) : 'no estimate'} · {e.confidence} confidence · {e.supporting} supporting, {e.contradicting} contradicting
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : reportError ? (
        <p className="notice error" role="alert">
          Could not load the report: {reportError}
        </p>
      ) : local.status === 'completed' ? (
        <p className="notice">{online ? 'Generating the report once your changes sync…' : 'You are offline. The report will be generated when your changes sync.'}</p>
      ) : (
        <p>Cancelled missions have no report.</p>
      )}
      <p>
        <a href="#/">Plan another mission</a>
      </p>
    </>
  );
}
