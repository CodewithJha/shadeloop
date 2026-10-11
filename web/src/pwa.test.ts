import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { canOfferUpdate } from './update.ts';

describe('update offer', () => {
  it('waits while Field Mode, the completion screen or unsaved input is on screen', () => {
    expect(canOfferUpdate('/', false)).toBe(true);
    expect(canOfferUpdate('/m/abc', false)).toBe(true);
    expect(canOfferUpdate('/settings', false)).toBe(true);
    expect(canOfferUpdate('/settings', true)).toBe(false);
    expect(canOfferUpdate('/field/abc', false)).toBe(false);
    expect(canOfferUpdate('/done/abc', false)).toBe(false);
  });
});

describe('production build', () => {
  const out = mkdtempSync(join(tmpdir(), 'shadeloop-pwa-'));
  const file = (p: string) => readFileSync(join(out, p), 'utf8');
  beforeAll(async () => {
    await build({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('ships every manifest icon, including 192/512 PNG and a maskable one', () => {
    const manifest = JSON.parse(file('manifest.webmanifest')) as { icons: { src: string; sizes: string; purpose: string }[]; display: string; scope: string };
    expect(manifest).toMatchObject({ display: 'standalone', scope: '/' });
    for (const i of manifest.icons) expect(existsSync(join(out, i.src)), i.src).toBe(true);
    expect(manifest.icons.map((i) => `${i.sizes}/${i.purpose}`)).toEqual(expect.arrayContaining(['192x192/any', '512x512/any', '512x512/maskable']));
    expect(file('index.html')).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(existsSync(join(out, 'apple-touch-icon.png'))).toBe(true);
  });

  it('waits for the user before activating, keeps /api off the cache and cleans old caches', () => {
    const sw = file('sw.js');
    // The only skipWaiting is the one the "Reload" button asks for.
    expect(sw.match(/skipWaiting\(\)/g)).toHaveLength(1);
    expect(sw.indexOf('SKIP_WAITING')).toBeLessThan(sw.indexOf('skipWaiting()'));
    expect(sw).not.toContain('clientsClaim');
    expect(sw).toContain('cleanupOutdatedCaches');
    expect(sw).toMatch(/denylist:\s*\[\/\^\\\/api\\\/\/\]/);
    expect(sw).not.toMatch(/registerRoute\((?!new \w+\.NavigationRoute)/);
    expect(sw).not.toMatch(/url"?:\s*"\/?api\//);
    const urls = [...sw.matchAll(/url"?:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(urls).toContain('icon-512.png');
    expect(new Set(urls).size).toBe(urls.length);
  });
});
