import { describe, expect, it, vi } from 'vitest';

vi.mock('./App.tsx', () => ({ label: (s: string) => s.replace(/_/g, ' ') }));
const { statusFor } = await import('./Integrations.tsx');

const dep = (name: string, status: string, detail = '') => ({ name, role: '', status, detail, lastCall: detail ? { ok: false, at: '2026-10-12T00:00:00Z', detail } : null });

describe('integration status', () => {
  it('shows a failing source as covered only when another source really covered it', () => {
    const osm = dep('openstreetmap', 'DEGRADED', 'fetch failed');
    expect(statusFor(osm, [osm, dep('serpapi', 'VERIFIED')]).tone).toBe('covered');
    expect(statusFor(osm, [osm, dep('serpapi', 'CONFIGURED')]).tone).toBe('fail');
  });
  it('marks a rate-limited weather source amber, other weather failures red', () => {
    expect(statusFor(dep('open-meteo', 'DEGRADED', 'Open-Meteo HTTP 429'), []).tone).toBe('covered');
    expect(statusFor(dep('open-meteo', 'DEGRADED', 'timeout'), []).tone).toBe('fail');
  });
  it('never upgrades a status to live', () => {
    expect(statusFor(dep('sentry', 'CONFIGURED'), []).tone).toBe('ready');
    expect(statusFor(dep('mongodb', 'VERIFIED'), []).tone).toBe('live');
  });
});
