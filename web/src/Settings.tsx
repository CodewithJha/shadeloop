import { useEffect, useState, type FormEvent } from 'react';
import { MISSION_TYPES, Preferences, type Coords } from '@shadeloop/shared';
import { api, type Dependency } from './api.ts';
import { clearAll, delMeta, getMeta, setMeta } from './store.ts';
import { label, useSync } from './App.tsx';
import { FieldLabel, StateNote } from './Marks.tsx';
import { Integrations } from './Integrations.tsx';

export function Settings() {
  const { online } = useSync();
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [dataError, setDataError] = useState('');
  const [coarse, setCoarse] = useState<Coords | undefined>();
  const [locMsg, setLocMsg] = useState('');
  const [deps, setDeps] = useState<{ dependencies: Dependency[]; notImplemented: string[] } | null>(null);

  useEffect(() => {
    void getMeta<Coords>('coarse').then(setCoarse);
    if (!online) {
      void getMeta<Preferences>('prefs').then((p) => setPrefs(p ?? Preferences.parse({})));
      return;
    }
    api
      .prefs()
      .then(async (p) => {
        setPrefs(p);
        await setMeta('prefs', p);
      })
      .catch((e: Error) => setError(e.message));
    api
      .deps()
      .then(setDeps)
      .catch((e: Error) => setError(e.message));
  }, [online]);

  if (!prefs)
    return error ? (
      <p className="notice error" role="alert">
        Could not load settings: {error}
      </p>
    ) : (
      <StateNote kind="loading">Loading settings…</StateNote>
    );
  const set = (patch: Partial<Preferences>) => setPrefs({ ...prefs, ...patch });

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved('');
    setError('');
    try {
      const p = await api.savePrefs(prefs!);
      await setMeta('prefs', p);
      setSaved('Preferences saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function shareLocation() {
    setLocMsg('Asking your browser for location…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        // Rounded on the device to ~1 km before it is stored or sent anywhere.
        const c = { lat: Math.round(pos.coords.latitude * 100) / 100, lon: Math.round(pos.coords.longitude * 100) / 100 };
        await setMeta('coarse', c);
        setCoarse(c);
        setPrefs((p) => p && { ...p, privacy: { ...p.privacy, useCoarseLocation: true } });
        setLocMsg('Approximate location saved on this device. Save preferences to record your consent.');
      },
      (err) => setLocMsg(`Location not available: ${err.message}`),
      { enableHighAccuracy: false, maximumAge: 600_000, timeout: 15_000 },
    );
  }

  async function forgetLocation() {
    await delMeta('coarse');
    setCoarse(undefined);
    setPrefs((p) => p && { ...p, privacy: { ...p.privacy, useCoarseLocation: false } });
    setLocMsg('Location removed from this device.');
  }

  async function exportData() {
    setDataError('');
    try {
      const data = await api.exportData();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'shadeloop-export.json' });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDataError(`Could not download your data: ${(err as Error).message}`);
    }
  }

  async function deleteAll() {
    if (!confirm('Delete all your missions, observations, reports and preferences from the server and this device? This cannot be undone.')) return;
    setDataError('');
    try {
      await api.deleteMe();
      await clearAll();
      location.hash = '/';
      location.reload();
    } catch (err) {
      setDataError(`Could not delete your data: ${(err as Error).message}`);
    }
  }

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">
          <span>Kit list</span>
        </p>
        <h1 className="display small">Settings</h1>
      </header>
      {!online && <StateNote kind="offline">Offline: showing preferences saved on this device. Saving needs a connection.</StateNote>}
      <FieldLabel n={1}>Preferences</FieldLabel>
      <form className="sheet settings-form" onSubmit={save}>
        <fieldset>
          <legend>Mission preferences</legend>
          <div className="row">
            {MISSION_TYPES.map((t) => (
              <label key={t} className="check">
                <input
                  type="checkbox"
                  checked={prefs.missionTypes.includes(t)}
                  onChange={(e) => set({ missionTypes: e.target.checked ? [...prefs.missionTypes, t] : prefs.missionTypes.filter((x) => x !== t) })}
                />
                {label(t)}
              </label>
            ))}
          </div>
          <label htmlFor="dm">Default minutes</label>
          <input id="dm" type="number" min={5} max={120} value={prefs.defaultMinutes} onChange={(e) => set({ defaultMinutes: Number(e.target.value) })} />
          <label htmlFor="tod">Preferred time of day</label>
          <select id="tod" value={prefs.timeOfDay} onChange={(e) => set({ timeOfDay: e.target.value as Preferences['timeOfDay'] })}>
            {['any', 'morning', 'midday', 'afternoon', 'evening'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <p className="hint">Time of day is passed to the AI as a hint only.</p>
        </fieldset>
        <fieldset>
          <legend>Walking and accessibility</legend>
          <label htmlFor="mw">Maximum walking per mission (minutes)</label>
          <input id="mw" type="number" min={0} max={120} value={prefs.maxWalkMinutes} onChange={(e) => set({ maxWalkMinutes: Number(e.target.value) })} />
          <label htmlFor="pace">Walking pace</label>
          <select id="pace" value={prefs.walkingPace} onChange={(e) => set({ walkingPace: e.target.value as Preferences['walkingPace'] })}>
            {['slow', 'moderate', 'brisk'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          {(
            [
              ['stepFreeRequired', 'I need step-free access (required condition)'],
              ['needsSeating', 'I need somewhere to sit (required condition)'],
              ['avoidCrowds', 'Prefer less crowded places'],
            ] as const
          ).map(([k, text]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={prefs.accessibility[k]} onChange={(e) => set({ accessibility: { ...prefs.accessibility, [k]: e.target.checked } })} />
              {text}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Voice</legend>
          <label className="check">
            <input type="checkbox" checked={prefs.voice.readStepsAloud} onChange={(e) => set({ voice: { ...prefs.voice, readStepsAloud: e.target.checked } })} />
            Offer “read step aloud” (ElevenLabs voice when online, browser voice offline)
          </label>
          <label className="check">
            <input type="checkbox" checked={prefs.voice.voiceNotes} onChange={(e) => set({ voice: { ...prefs.voice, voiceNotes: e.target.checked } })} />
            Offer dictation for notes (browser speech recognition, may send audio to the browser vendor)
          </label>
          <label htmlFor="lang">Language</label>
          <select id="lang" value={prefs.language} disabled>
            <option value="en">English (only language available)</option>
          </select>
        </fieldset>
        <fieldset>
          <legend>Memory</legend>
          <label className="check">
            <input type="checkbox" checked={prefs.privacy.rememberRequests} onChange={(e) => set({ privacy: { ...prefs.privacy, rememberRequests: e.target.checked } })} />
            Remember my requests so future plans respect what I said (stored with Backboard; deleted with “Delete my data”)
          </label>
        </fieldset>
        <button className="primary" type="submit" disabled={!online}>
          Save preferences
        </button>
        {saved && (
          <p className="meta" role="status">
            {saved}
          </p>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
      </form>

      <FieldLabel n={2}>Location (optional)</FieldLabel>
      <p>
        ShadeLoop never tracks you. If you opt in, your browser is asked once for your position, which is rounded to about 1 km on this device. It is sent only when you plan a mission, to find mapped parks
        and check the weather.
      </p>
      <p className="coords num">{coarse ? `Saved: ${coarse.lat}, ${coarse.lon} (rounded)` : 'No location saved.'}</p>
      <div className="row">
        <button type="button" onClick={shareLocation} disabled={!('geolocation' in navigator)}>
          {coarse ? 'Update approximate location' : 'Use my approximate location'}
        </button>
        {coarse && (
          <button type="button" onClick={() => void forgetLocation()}>
            Forget location
          </button>
        )}
      </div>
      {locMsg && (
        <p className="meta" role="status">
          {locMsg}
        </p>
      )}

      <FieldLabel n={3}>Integrations</FieldLabel>
      <p className="hint">What powers ShadeLoop, and what happens when a piece is missing. Status comes from the server: “verified” means a real call succeeded, not just that a key is set.</p>
      {deps ? (
        <Integrations deps={deps} />
      ) : (
        <StateNote kind={online ? 'loading' : 'offline'}>{online ? 'Checking integrations…' : 'Unavailable offline.'}</StateNote>
      )}

      <FieldLabel n={4}>Your data</FieldLabel>
      <p>
        Your data is tied to an anonymous session on this device. There are no accounts. Observations about a place contribute to shared, anonymous evidence counts; notes you type are never stored.
      </p>
      <div className="row">
        <button type="button" onClick={() => void exportData()} disabled={!online}>
          Download my data (JSON)
        </button>
        <button type="button" className="danger" onClick={() => void deleteAll()} disabled={!online}>
          Delete all my data
        </button>
      </div>
      {dataError && (
        <p className="notice error" role="alert">
          {dataError}
        </p>
      )}
    </>
  );
}
