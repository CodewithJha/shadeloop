import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // A new version waits until the user taps "Reload" (see main.tsx), so it never interrupts Field Mode or a form.
      registerType: 'prompt',
      // The icons are already in the precache via globPatterns.
      includeManifestIcons: false,
      manifest: {
        name: 'ShadeLoop',
        short_name: 'ShadeLoop',
        description: 'Go outside. Discover more. Make every walk count.',
        theme_color: '#2f5d3a',
        background_color: '#f6f4ee',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // App shell only. Mission data lives in IndexedDB, and API calls always go to the network.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { proxy: { '/api': 'http://localhost:8080' } },
  test: { environment: 'node' },
});
