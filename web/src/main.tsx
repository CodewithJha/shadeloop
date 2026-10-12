import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.tsx';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
const render = (onUpdate?: () => void) =>
  root.render(
    <StrictMode>
      <App onUpdate={onUpdate} />
    </StrictMode>,
  );
render();
const updateSW = registerSW({
  immediate: true,
  // The new version is installed but waits; it only takes over when the user taps "Reload".
  onNeedRefresh: () => render(() => void updateSW(true)),
  // Long-lived tabs and installed apps would otherwise only look for a new version on a fresh load.
  onRegisteredSW: (_url, r) => r && setInterval(() => navigator.onLine && void r.update().catch(() => {}), 60 * 60_000),
});
