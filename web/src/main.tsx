import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/base.css';
import { registerServiceWorker } from './pwa/register';
import { applyAppThemeColor } from './lib/themeColor';

// App theme + status-bar colour before first paint (the reader overrides
// both while open and restores them on exit).
try {
  const pref = localStorage.getItem('rp-app-theme');
  if (pref === 'light' || pref === 'dark')
    document.documentElement.setAttribute('data-app-theme', pref);
} catch {
  /* private mode */
}
applyAppThemeColor();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.querySelector('.reader-page')) applyAppThemeColor();
});

// No pinch zoom on a touch screen. iOS ignores the viewport's
// `user-scalable=no`, and `touch-action` (base.css) has not always held a
// pinch there; refusing its own gesture events does. The pointer check
// leaves a trackpad on a Mac to zoom as it always has.
if (matchMedia('(pointer: coarse)').matches) {
  for (const type of ['gesturestart', 'gesturechange'] as const) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

registerServiceWorker();
