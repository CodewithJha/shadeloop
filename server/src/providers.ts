/** External data: place discovery (OpenStreetMap Overpass, SerpApi, dev fixture) and weather (Open-Meteo). */
import type { Coords, LocationView, WeatherView } from '@shadeloop/shared';
import { env } from './config.ts';
import { col } from './db.ts';
import { distanceM, roundCoords } from './domain.ts';
import { recordCall } from './integrations.ts';
import { log } from './log.ts';

const UA = 'ShadeLoop/0.1 (open-source outdoor companion)';
const TTL_MS = 10 * 60_000;
// ponytail: per-process cache keyed by coarse cell; move to a Mongo TTL collection if running several instances.
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export const clearProviderCache = () => cache.clear();

type LocationDoc = Omit<LocationView, 'id' | 'distanceM'> & { _id: string; lastCheckedAt: string };

const errorText = (e: unknown) => ((e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message);

async function overpass(origin: Coords, radiusM: number): Promise<LocationView[]> {
  const around = `(around:${radiusM},${origin.lat},${origin.lon})`;
  const q = `[out:json][timeout:15];nwr["leisure"~"^(park|garden|nature_reserve)$"]${around};out center 30;node["amenity"="bench"]${around};out 15;`;
  const res = await fetch(env.OVERPASS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ data: q }),
    signal: AbortSignal.timeout(env.HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const body = (await res.json()) as {
    elements?: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[];
  };
  const retrievedAt = new Date().toISOString();
  return (body.elements ?? []).flatMap((el) => {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) return [];
    const category = el.tags?.leisure ?? (el.tags?.amenity === 'bench' ? 'bench' : 'unknown');
    return [
      {
        id: `osm:${el.type}/${el.id}`,
        name: el.tags?.name ?? `Unnamed ${category.replace('_', ' ')}`,
        category,
        coords: { lat, lon },
        source: 'openstreetmap' as const,
        isFixture: false,
        externalId: `${el.type}/${el.id}`,
        attribution: '© OpenStreetMap contributors (ODbL)',
        retrievedAt,
      },
    ];
  });
}

async function serpapi(origin: Coords, query: string): Promise<LocationView[]> {
  const url = new URL('https://serpapi.com/search.json');
  url.search = new URLSearchParams({ engine: 'google_maps', type: 'search', q: query, ll: `@${origin.lat},${origin.lon},15z`, api_key: env.SERPAPI_KEY! }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(env.HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);
  const body = (await res.json()) as {
    local_results?: { title?: string; place_id?: string; type?: string; gps_coordinates?: { latitude: number; longitude: number } }[];
  };
  const retrievedAt = new Date().toISOString();
  return (body.local_results ?? []).flatMap((r) =>
    r.place_id && r.title && r.gps_coordinates
      ? [
          {
            id: `serpapi:${r.place_id}`,
            name: r.title,
            category: r.type ?? 'place',
            coords: { lat: r.gps_coordinates.latitude, lon: r.gps_coordinates.longitude },
            source: 'serpapi' as const,
            isFixture: false,
            externalId: r.place_id,
            attribution: 'Google Maps results via SerpApi',
            retrievedAt,
          },
        ]
      : [],
  );
}

function fixture(): LocationView[] {
  const retrievedAt = new Date().toISOString();
  return ['Sample Riverside Park', 'Sample Community Garden', 'Sample Pocket Park'].map((name, i) => ({
    id: `fixture:${i + 1}`,
    name: `${name} (fixture)`,
    category: i === 1 ? 'garden' : 'park',
    coords: null,
    source: 'fixture' as const,
    isFixture: true,
    externalId: String(i + 1),
    attribution: 'ShadeLoop sample fixture. Not a real place.',
    retrievedAt,
  }));
}

export interface DiscoveryResult {
  locations: LocationView[];
  sources: { name: string; ok: boolean; count: number; error?: string }[];
  mode: 'live' | 'fixture';
  limitations: string[];
}

const LIMITATIONS = [
  'Search results show that a place is mapped, not that it has shade, is safe, is accessible, or is open.',
  'Distances are straight-line estimates from a coarse (~1 km) location.',
];

export async function discover(rawOrigin: Coords, radiusM = 1000, query = 'park'): Promise<DiscoveryResult> {
  const origin = roundCoords(rawOrigin);
  const found: LocationView[] = [];
  const sources: DiscoveryResult['sources'] = [];
  if (env.DISCOVERY_MODE === 'fixture') {
    found.push(...fixture());
    sources.push({ name: 'fixture', ok: true, count: found.length });
  } else {
    const tasks: [string, () => Promise<LocationView[]>][] = [['openstreetmap', () => overpass(origin, radiusM)]];
    if (env.SERPAPI_KEY) tasks.push(['serpapi', () => serpapi(origin, query)]);
    const results = await Promise.allSettled(tasks.map(([name, fn]) => cached(`${name}:${origin.lat},${origin.lon}:${radiusM}:${query}`, fn)));
    results.forEach((r, i) => {
      const name = tasks[i][0];
      if (r.status === 'fulfilled') {
        recordCall(name, true, `returned ${r.value.length} places`);
        sources.push({ name, ok: true, count: r.value.length });
        found.push(...r.value);
      } else {
        const error = errorText(r.reason);
        recordCall(name, false, error);
        log.warn({ provider: name, error }, 'discovery provider failed');
        sources.push({ name, ok: false, count: 0, error });
      }
    });
  }
  const withDistance = found
    .map((l) => (l.coords ? { ...l, distanceM: distanceM(origin, l.coords) } : l))
    .sort((a, b) => Number(a.category === 'bench') - Number(b.category === 'bench') || (a.distanceM ?? 0) - (b.distanceM ?? 0))
    .slice(0, 20);
  if (withDistance.length) {
    await col<LocationDoc>('locations').bulkWrite(
      withDistance.map(({ id, distanceM: _d, ...rest }) => ({
        updateOne: { filter: { _id: id }, update: { $set: { ...rest, lastCheckedAt: rest.retrievedAt } }, upsert: true },
      })),
    );
  }
  return { locations: withDistance, sources, mode: env.DISCOVERY_MODE, limitations: LIMITATIONS };
}

export async function loadLocations(ids: string[], origin?: Coords): Promise<LocationView[]> {
  const docs = await col<LocationDoc>('locations').find({ _id: { $in: ids } }).toArray();
  const o = origin && roundCoords(origin);
  return docs.map(({ _id, lastCheckedAt: _l, ...d }) => ({ ...d, id: _id, ...(o && d.coords ? { distanceM: distanceM(o, d.coords) } : {}) }));
}

export async function getWeather(rawOrigin: Coords): Promise<WeatherView> {
  const origin = roundCoords(rawOrigin);
  const retrievedAt = new Date().toISOString();
  try {
    return await cached(`weather:${origin.lat},${origin.lon}`, async () => {
      const url = new URL(env.OPEN_METEO_URL);
      url.search = new URLSearchParams({
        latitude: String(origin.lat),
        longitude: String(origin.lon),
        current: 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,weather_code',
      }).toString();
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(env.HTTP_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      const { current: c } = (await res.json()) as {
        current?: { time: string; temperature_2m: number; apparent_temperature: number; precipitation: number; wind_speed_10m: number; weather_code: number };
      };
      if (!c || typeof c.temperature_2m !== 'number') throw new Error('Open-Meteo response missing current data');
      recordCall('open-meteo', true, 'current weather returned');
      return {
        available: true,
        source: 'open-meteo' as const,
        retrievedAt,
        observedAt: `${c.time}Z`,
        temperatureC: c.temperature_2m,
        apparentTemperatureC: c.apparent_temperature,
        precipitationMm: c.precipitation,
        windKmh: c.wind_speed_10m,
        weatherCode: c.weather_code,
      };
    });
  } catch (e) {
    const reason = errorText(e);
    recordCall('open-meteo', false, reason);
    return { available: false, source: 'open-meteo', retrievedAt, reason };
  }
}
