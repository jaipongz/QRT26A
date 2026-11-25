import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ConnectionScreen from './ConnectionScreen';
import Workspace from './Workspace';
import SettingsModal from './SettingsModal';
import { api } from './util';

// Older builds kept tab SQL in localStorage (plaintext on disk). Move it to the encrypted store, then delete it.
async function migrateLegacyStorage() {
  // Layout prefs rescued from the old file:// origin by the main process.
  try {
    const prefs = await api.takeLegacyPrefs();
    if (prefs) for (const [k, v] of Object.entries(prefs)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  } catch {
    return;
  }
  for (const k of keys) {
    if (k.startsWith('qrt:tabs:')) {
      const cid = k.slice('qrt:tabs:'.length);
      try {
        const existing = await api.loadTabs(cid);
        if (!existing) await api.saveTabs(cid, JSON.parse(localStorage.getItem(k)));
        localStorage.removeItem(k);
      } catch {
        /* keep it for a later attempt */
      }
    } else if (k.startsWith('qrt:queryTabs:')) {
      localStorage.removeItem(k); // superseded by workspace tabs
    }
  }
}

function App() {
  const [session, setSession] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => {
    const open = () => setShowSettings(true);
    window.addEventListener('qrt-open-settings', open);
    const off = api.onMenu((cmd) => cmd === 'preferences' && open());
    return () => {
      window.removeEventListener('qrt-open-settings', open);
      off();
    };
  }, []);
  const settings = showSettings ? <SettingsModal onClose={() => setShowSettings(false)} /> : null;
  useEffect(() => {
    // Runs in the background: the main process may be waiting on a Keychain prompt to finish migrating.
    migrateLegacyStorage();
  }, []);
  if (!session)
    return (
      <>
      {settings}
      <ConnectionScreen
        onConnected={async (conn, info) => {
          const savedTabs = await api.loadTabs(conn.id || conn.host).catch(() => null);
          setSession({ conn, info, savedTabs, key: Date.now() });
        }}
      />
      </>
    );
  return (
    <>
      {settings}
      <Workspace key={session.key} conn={session.conn} info={session.info} savedTabs={session.savedTabs} onDisconnect={() => setSession(null)} />
    </>
  );
}

// Stop the browser's default context menu outside our own menus; keep it in text fields.
window.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea, .cm-content')) e.preventDefault();
});

createRoot(document.getElementById('root')).render(<App />);
