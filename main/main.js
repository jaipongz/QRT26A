const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, nativeTheme, protocol, session } = require('electron');
const { readLegacyOrigin } = require('./legacyStorage');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { Session } = require('./db');
const hostkeys = require('./hostkeys');

const sessions = new Map(); // webContents.id -> Session

// The UI is served from a private scheme instead of file:// (Electron security checklist), so the
// GrantFileProtocolExtraPrivileges fuse can stay off and every UI file read goes through asar integrity checks.
const APP_ORIGIN = 'qrt://app';
const APP_ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.json': 'application/json' };
protocol.registerSchemesAsPrivileged([{ scheme: 'qrt', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);

function serveApp() {
  protocol.handle('qrt', async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname);
    const full = path.normalize(path.join(APP_ROOT, rel));
    // Only the renderer bundle and its static files; never main-process code or anything outside the app.
    if (u.host !== 'app' || !/^\/(renderer|dist)\//.test(rel) || !full.startsWith(APP_ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(full);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// Builds before this one kept tab SQL in the file:// origin's localStorage (plaintext on disk).
// Step 1 (before app ready, before Chromium opens it): move "Local Storage" aside and parse its LevelDB log.
// Step 2 (after ready): store tabs encrypted, hand layout prefs to the UI, then delete the moved copy.
// A crash in between is safe: the next launch resumes from the moved directory.
function prepareLegacyMigration() {
  try {
    if (store.getSettings().fileOriginMigrated) return null;
    const ud = app.getPath('userData');
    const live = path.join(ud, 'Local Storage');
    const moved = path.join(ud, 'Local Storage.migrating');
    const liveInfo = readLegacyOrigin(path.join(live, 'leveldb'), 'file://');
    if (liveInfo.hasTables) return { ...liveInfo, moved: null }; // compacted tables can't be parsed: migrate what the log has, clear in place
    if (liveInfo.exists && !fs.existsSync(moved)) fs.renameSync(live, moved);
    return { ...readLegacyOrigin(path.join(moved, 'leveldb'), 'file://'), moved: fs.existsSync(moved) ? moved : null };
  } catch (e) {
    console.error('legacy storage migration (prepare) failed:', e.message);
    return null;
  }
}

async function finishLegacyMigration(legacy) {
  if (!legacy) return;
  try {
    const prefs = {};
    const byConn = new Map();
    const slot = (cid) => byConn.get(cid) || byConn.set(cid, {}).get(cid);
    for (const [k, v] of legacy.entries) {
      if (k.startsWith('qrt:tabs:')) slot(k.slice(9)).tabs = v;
      else if (k.startsWith('qrt:queryTabs:')) slot(k.slice(14)).queryTabs = v;
      else if (k.startsWith('qrt:')) prefs[k] = v; // layout prefs, last connection/db/table
    }
    for (const [cid, src] of byConn) {
      if (await store.loadTabs(cid)) continue;
      let state = null;
      try { state = src.tabs ? JSON.parse(src.tabs) : null; } catch { /* ignore */ }
      // First-generation builds had query tabs inside the Query view; keep their SQL as workspace tabs.
      try {
        const q = src.queryTabs ? JSON.parse(src.queryTabs) : null;
        const extra = (q && q.tabs ? q.tabs : []).filter((t) => t.sql && t.sql.trim() && !(state && state.tabs.some((x) => x.sql === t.sql)));
        if (extra.length) {
          state = state || { tabs: [], active: null };
          for (const t of extra) state.tabs.push({ id: 'm' + t.id, view: 'query', sql: t.sql, title: t.title || '', db: '', table: null });
          state.active = state.active || state.tabs[0].id;
        }
      } catch { /* ignore */ }
      if (state && state.tabs && state.tabs.length) await store.saveTabs(cid, state);
    }
    if (!legacy.moved && legacy.exists) await session.defaultSession.clearStorageData({ origin: 'file://', storages: ['localstorage'] }).catch(() => {});
    store.setSettings({ fileOriginMigrated: true, legacyPrefs: Object.keys(prefs).length ? prefs : null });
    if (legacy.moved) fs.rmSync(legacy.moved, { recursive: true, force: true });
  } catch (e) {
    console.error('legacy storage migration failed:', e.message); // the moved copy stays; retried next launch
  }
}

// Ask the user about an unknown or changed SSH host key (like OpenSSH, but with a dialog).
// Resolves true to continue, or a string explaining why the connection was refused.
const hostKeyPrompts = new Map(); // hostId:fingerprint -> pending promise (dedupe concurrent tunnels)
function makeHostKeyVerifier(getWindow) {
  return ({ host, port, key }) => {
    const type = hostkeys.keyType(key);
    const fp = hostkeys.fingerprint(key);
    const b64 = key.toString('base64');
    const hostId = hostkeys.hostName(host, port);

    const trusted = store.getTrustedHostKey(hostId);
    let verdict;
    if (trusted && trusted.type === type) verdict = trusted.key === b64 ? { status: 'match' } : { status: 'mismatch', known: [{ type, fingerprint: trusted.fingerprint, file: 'QRT trusted keys' }] };
    else verdict = hostkeys.lookupSystem(host, port, key);

    if (verdict.status === 'match') return Promise.resolve(true);
    if (verdict.status === 'revoked') return Promise.resolve(`Host key ${fp} for ${hostId} is marked @revoked in known_hosts`);

    const pendingKey = hostId + '|' + fp;
    if (hostKeyPrompts.has(pendingKey)) return hostKeyPrompts.get(pendingKey);
    const p = (async () => {
      const win = getWindow();
      const opts =
        verdict.status === 'mismatch'
          ? {
              type: 'error',
              message: `WARNING: the SSH host key for ${hostId} has CHANGED`,
              detail:
                `Someone could be intercepting this connection (man-in-the-middle), or the server was reinstalled.\n\n` +
                `Server now presents:\n  ${type} ${fp}\n\nPreviously trusted:\n` +
                verdict.known.map((k) => `  ${k.type} ${k.fingerprint}  (${k.file})`).join('\n') +
                `\n\nOnly continue if you have confirmed the new fingerprint with the server administrator.`,
              buttons: ['Cancel', 'Trust New Key and Connect'],
              defaultId: 0,
              cancelId: 0,
            }
          : {
              type: 'warning',
              message: `Unknown SSH host ${hostId}`,
              detail:
                `The authenticity of this host can't be established.\n\n  ${type} ${fp}\n\n` +
                (verdict.known && verdict.known.length ? `known_hosts has other key types for this host:\n${verdict.known.map((k) => `  ${k.type} ${k.fingerprint}`).join('\n')}\n\n` : '') +
                `Compare it with the server's fingerprint (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub) before trusting it.`,
              buttons: ['Trust and Connect', 'Cancel'],
              defaultId: 0,
              cancelId: 1,
            };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      const accepted = verdict.status === 'mismatch' ? r.response === 1 : r.response === 0;
      if (!accepted) return `Host key for ${hostId} was not trusted (${fp})`;
      store.trustHostKey(hostId, { type, key: b64, fingerprint: fp });
      return true;
    })();
    hostKeyPrompts.set(pendingKey, p);
    p.finally(() => hostKeyPrompts.delete(pendingKey));
    return p;
  };
}

function sessionFor(event) {
  let s = sessions.get(event.sender.id);
  if (!s) {
    const sender = event.sender;
    s = new Session({ verifyHostKey: makeHostKeyVerifier(() => BrowserWindow.fromWebContents(sender)) });
    sessions.set(event.sender.id, s);
  }
  return s;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    title: 'Q-Bit',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const wcId = win.webContents.id;
  win.loadURL(`${APP_ORIGIN}/renderer/index.html`);
  // Never navigate the app window anywhere else.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN + '/')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    const s = sessions.get(wcId);
    if (s) s.close();
    sessions.delete(wcId);
  });
  return win;
}

// Wrap handlers so errors reach the renderer as { error } instead of noisy rejections.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(event, ...args) };
    } catch (e) {
      return { ok: false, error: e.sqlMessage || e.message || String(e), code: e.code, errno: e.errno };
    }
  });
}

handle('conn:list', () => store.listConnections());
handle('conn:save', (_e, c) => store.saveConnection(c));
handle('conn:delete', (_e, idv) => store.deleteConnection(idv));
handle('conn:reorder', (_e, ids) => store.reorderConnections(ids));
handle('conn:test', async (e, cfg) => {
  const sender = e.sender;
  const s = new Session({ verifyHostKey: makeHostKeyVerifier(() => BrowserWindow.fromWebContents(sender)) });
  try {
    return await s.connect(await store.resolveSecrets(cfg));
  } finally {
    await s.close();
  }
});
handle('conn:connect', async (e, cfg) => {
  const info = await sessionFor(e).connect(await store.resolveSecrets(cfg));
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setTitle(`${cfg.name || cfg.host} — QRT`);
  return info;
});
handle('conn:disconnect', async (e) => {
  await sessionFor(e).close();
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setTitle('QRT');
});

handle('db:databases', (e) => sessionFor(e).databases());
handle('db:tableList', (e, db) => sessionFor(e).tableList(db));
handle('db:schemaDetails', (e, db) => sessionFor(e).schemaDetails(db));
handle('db:tableStats', (e, db) => sessionFor(e).tableStats(db));
handle('db:createStatement', (e, db, t) => sessionFor(e).createStatement(db, t));
handle('db:content', (e, tabId, opts) => sessionFor(e).content(tabId, opts));
handle('db:count', (e, opts) => sessionFor(e).count(opts));
handle('db:query', (e, tabId, sql, db) => sessionFor(e).runQuery(tabId, sql, db));
handle('db:cancel', (e, tabId) => sessionFor(e).cancel(tabId));
handle('db:txState', (e, tabId) => sessionFor(e).txState(tabId));
handle('db:closeTab', (e, tabId) => sessionFor(e).closeKey(tabId));
handle('db:update', (e, tabId, o) => sessionFor(e).updateRow(tabId, o));
handle('db:insert', (e, tabId, o) => sessionFor(e).insertRow(tabId, o));
handle('db:delete', (e, tabId, o) => sessionFor(e).deleteRows(tabId, o));
handle('db:ddl', (e, tabId, sql, db) => sessionFor(e).execDdl(tabId, sql, db));

handle('history:list', (_e, cid) => store.listHistory(cid));
handle('history:add', (_e, entry) => store.addHistory(entry));
handle('history:clear', (_e, cid) => store.clearHistory(cid));
handle('settings:get', () => store.getSettings());
// App appearance: system | light | dark (drives prefers-color-scheme in every window).
handle('appearance:set', (_e, v) => {
  const mode = ['light', 'dark'].includes(v) ? v : 'system';
  nativeTheme.themeSource = mode;
  store.setSettings({ appearance: mode });
  return mode;
});
// Non-sensitive prefs carried over from the old file:// origin; handed to the renderer once.
handle('settings:takeLegacyPrefs', async () => {
  await migrationDone;
  const p = store.getSettings().legacyPrefs || null;
  if (p) store.setSettings({ legacyPrefs: null });
  return p;
});
handle('settings:set', (_e, patch) => store.setSettings(patch));
handle('tabs:load', async (_e, cid) => {
  await migrationDone; // migrated tabs must be in place before the UI reads them
  return store.loadTabs(cid);
});
handle('tabs:save', (_e, cid, state) => store.saveTabs(cid, state));
// Synchronous variant used on window unload so the last edits are not lost.
ipcMain.on('tabs:saveSync', async (e, cid, state) => {
  try {
    await store.saveTabs(cid, state);
  } catch { /* ignore */ }
  e.returnValue = true;
});

handle('dialog:openFile', async (e, { title, defaultPath }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { title, defaultPath, properties: ['openFile', 'showHiddenFiles'] });
  return r.canceled ? null : r.filePaths[0];
});

handle('dialog:openKey', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose SSH private key',
    defaultPath: path.join(app.getPath('home'), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('file:saveText', async (e, { defaultName, content, filters }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: filters || [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return r.filePath;
});

handle('file:openSql', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  const p = r.filePaths[0];
  const stat = fs.statSync(p);
  if (stat.size > 20 * 1024 * 1024) throw new Error('File is larger than 20 MB');
  return { path: p, name: path.basename(p), content: fs.readFileSync(p, 'utf8') };
});

handle('clipboard:write', (_e, text) => clipboard.writeText(text));

handle('confirm', async (e, { message, detail, okLabel }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    message,
    detail,
    buttons: [okLabel || 'OK', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  return r.response === 0;
});

function send(channel) {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.webContents.send('menu', channel);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('preferences') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('newTab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('closeTab') },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => send('nextTab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => send('prevTab') },
        { type: 'separator' },
        { label: 'Open SQL File…', accelerator: 'CmdOrCtrl+O', click: () => send('openSql') },
        { label: 'Save Query As…', accelerator: 'CmdOrCtrl+S', click: () => send('saveSql') },
        { type: 'separator' },
        { label: 'Disconnect', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('disconnect') },
        { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Content', accelerator: 'CmdOrCtrl+1', click: () => send('view:content') },
        { label: 'Structure', accelerator: 'CmdOrCtrl+2', click: () => send('view:structure') },
        { label: 'Query', accelerator: 'CmdOrCtrl+3', click: () => send('view:query') },
        { label: 'Table Info', accelerator: 'CmdOrCtrl+4', click: () => send('view:info') },
        { type: 'separator' },
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => send('refresh') },
        { label: 'Find Table', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('focusFilter') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Query',
      submenu: [
        { label: 'Run Current Statement', accelerator: 'CmdOrCtrl+Enter', click: () => send('runCurrent'), registerAccelerator: false },
        { label: 'Run All', accelerator: 'CmdOrCtrl+Shift+Enter', click: () => send('runAll'), registerAccelerator: false },
        { label: 'Cancel Query', accelerator: 'CmdOrCtrl+.', click: () => send('cancel') },
        { type: 'separator' },
        { label: 'History', accelerator: 'CmdOrCtrl+Y', click: () => send('history') },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName('Q-Bit');
if (process.env.QRT_USER_DATA) app.setPath('userData', process.env.QRT_USER_DATA);
let migrationDone = Promise.resolve();
const legacyMigration = prepareLegacyMigration();
app.whenReady().then(async () => {
  serveApp();
  const appearance = store.getSettings().appearance;
  if (appearance === 'light' || appearance === 'dark') nativeTheme.themeSource = appearance;
  // Don't block the window on the migration: it needs the Keychain, which may show a macOS prompt.
  migrationDone = finishLegacyMigration(legacyMigration);
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const s of sessions.values()) s.close();
});
