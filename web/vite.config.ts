import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'ShadeLoop',
        short_name: 'ShadeLoop',
        description: 'Go outside. Discover more. Make every walk count.',
        theme_color: '#2f5d3a',
        background_color: '#f6f4ee',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // App shell only. Mission data lives in IndexedDB, and API calls always go to the network.
        globPatterns: ['**/*.{js,css,html,svg}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: { proxy: { '/api': 'http://localhost:8080' } },
  test: { environment: 'node' },
});
