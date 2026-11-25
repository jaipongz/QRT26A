// Editor appearance preferences (per-machine convenience settings), shared by all windows.
import { useEffect, useState } from 'react';
import { loadLocal, saveLocal } from './util';

export const DEFAULT_PREFS = {
  theme: 'auto', // editor colour theme id, or 'auto' = Light+/Dark+ following the app
  appearance: 'system', // app chrome: system | light | dark
  fontFamily: 'SF Mono',
  fontSize: 13,
  lineHeight: 1.55,
  ligatures: true,
  bracketColors: true,
  highlightStatement: true,
  cursorBlink: true,
};

const KEY = 'editorPrefs';
let current = { ...DEFAULT_PREFS, ...loadLocal(KEY, {}) };
const listeners = new Set();

export function getPrefs() {
  return current;
}

export function setPrefs(patch) {
  current = { ...current, ...patch };
  saveLocal(KEY, current);
  for (const fn of listeners) fn(current);
}

// Other windows change prefs through localStorage; pick those changes up.
window.addEventListener('storage', (e) => {
  if (e.key === 'qrt:' + KEY && e.newValue) {
    try {
      current = { ...DEFAULT_PREFS, ...JSON.parse(e.newValue) };
      for (const fn of listeners) fn(current);
    } catch {
      /* ignore */
    }
  }
});

export function usePrefs() {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    return () => listeners.delete(setP);
  }, []);
  return p;
}

// Is the app currently rendering dark (follows nativeTheme.themeSource set by the main process)?
export function useSystemDark() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const [dark, setDark] = useState(mq.matches);
  useEffect(() => {
    const h = (e) => setDark(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [mq]);
  return dark;
}
