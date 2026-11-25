// Persistent storage. Everything sensitive is encrypted with Electron safeStorage (macOS Keychain key):
//   connections.json   – connection settings; password fields encrypted individually
//   history.enc        – query history (whole file encrypted; secrets in statements are masked first)
//   tabs.enc           – open workspace tabs incl. their SQL (whole file encrypted)
//   known_hosts.json   – SSH host keys the user chose to trust (public keys, not secret)
//   settings.json      – non-sensitive preferences
// Secrets never leave the main process: the renderer only sees `has_<field>` flags.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'];
const HISTORY_MAX = 2000;
const DEFAULT_SETTINGS = { historyEnabled: true, historyRetentionDays: 30 };

const filePath = (name) => path.join(app.getPath('userData'), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeFileAtomic(name, content) {
  const target = filePath(name);
  const tmp = target + '.' + process.pid + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

const writeJson = (name, data) => writeFileAtomic(name, JSON.stringify(data, null, 2));

let encryptionAvailable = null;
async function canEncrypt() {
  if (encryptionAvailable === null) encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable();
  return encryptionAvailable;
}

async function encrypt(value) {
  if (!value) return '';
  if (!(await canEncrypt())) return ''; // never persist secrets in plaintext; they stay for this session only
  return 'enc:' + (await safeStorage.encryptStringAsync(value)).toString('base64');
}

class DecryptError extends Error {}

async function decrypt(value) {
  if (!value) return '';
  if (value.startsWith('raw:')) return value.slice(4); // legacy, re-encrypted on next save
  if (!value.startsWith('enc:')) return value;
  try {
    return (await safeStorage.decryptStringAsync(Buffer.from(value.slice(4), 'base64'))).result;
  } catch {
    throw new DecryptError();
  }
}

// Whole-file encrypted JSON.
async function readEncJson(name, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(filePath(name), 'utf8');
  } catch {
    return fallback;
  }
  try {
    if (!raw.startsWith('QRTENC1:')) return fallback;
    const json = (await safeStorage.decryptStringAsync(Buffer.from(raw.slice(8), 'base64'))).result;
    return JSON.parse(json);
  } catch {
    return fallback; // key changed / corrupted: start fresh rather than crash
  }
}

async function writeEncJson(name, data) {
  if (!(await canEncrypt())) return; // do not write sensitive data unencrypted
  const buf = await safeStorage.encryptStringAsync(JSON.stringify(data));
  writeFileAtomic(name, 'QRTENC1:' + buf.toString('base64'));
}

// Serialise writes per file so concurrent saves never interleave.
const chains = new Map();
function serial(name, fn) {
  const prev = chains.get(name) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(name, next.catch(() => {}));
  return next;
}

// ------------------------------------------------------------------ connections
async function rawConnections() {
  const list = readJson('connections.json', []);
  // Migrate legacy plaintext ("raw:") secrets to encrypted ones.
  if (list.some((c) => SECRET_FIELDS.some((f) => typeof c[f] === 'string' && c[f].startsWith('raw:')))) {
    if (await canEncrypt()) {
      for (const c of list) for (const f of SECRET_FIELDS) if (typeof c[f] === 'string' && c[f].startsWith('raw:')) c[f] = await encrypt(c[f].slice(4));
      writeJson('connections.json', list);
    }
  }
  return list;
}

function publicView(c) {
  const out = { ...c };
  for (const f of SECRET_FIELDS) {
    out['has_' + f] = !!c[f];
    delete out[f];
  }
  if (out.ssl && !out.sslMode) out.sslMode = 'required'; // legacy checkbox
  delete out.ssl;
  return out;
}

// For the renderer: no secret values, only whether one is saved (and whether it can still be decrypted).
async function listConnections() {
  const list = await rawConnections();
  const out = [];
  for (const c of list) {
    const pub = publicView(c);
    for (const f of SECRET_FIELDS) {
      try {
        await decrypt(c[f]);
      } catch {
        pub.secretsLost = true;
        pub['has_' + f] = false;
      }
    }
    out.push(pub);
  }
  return out;
}

// Merge what the renderer sent with stored secrets: a typed value wins, `clear` removes, otherwise keep stored.
async function resolveSecrets(cfg) {
  const srcId = cfg.id || cfg.copyFrom;
  const stored = srcId ? (await rawConnections()).find((c) => c.id === srcId) : null;
  const out = { ...cfg };
  delete out.copyFrom;
  for (const f of SECRET_FIELDS) {
    if (cfg[f]) continue;
    if (cfg.clear && cfg.clear[f]) out[f] = '';
    else if (stored && stored[f]) {
      try {
        out[f] = await decrypt(stored[f]);
      } catch {
        out[f] = '';
      }
    } else out[f] = '';
  }
  delete out.clear;
  for (const f of SECRET_FIELDS) delete out['has_' + f];
  delete out.secretsLost;
  if (out.ssl && !out.sslMode) out.sslMode = 'required';
  return out;
}

function saveConnection(conn) {
  return serial('connections.json', async () => {
    const all = await rawConnections();
    const srcId = conn.id || conn.copyFrom;
    const existing = srcId ? all.find((c) => c.id === srcId) : null;
    const stored = { ...conn, id: conn.id || crypto.randomUUID() };
    delete stored.copyFrom;
    for (const f of SECRET_FIELDS) {
      if (conn[f]) stored[f] = await encrypt(conn[f]);
      else if (conn.clear && conn.clear[f]) stored[f] = '';
      else stored[f] = existing ? existing[f] || '' : '';
      delete stored['has_' + f];
    }
    delete stored.clear;
    delete stored.secretsLost;
    delete stored.ssl;
    const idx = all.findIndex((c) => c.id === stored.id);
    if (idx >= 0) all[idx] = stored;
    else all.push(stored);
    writeJson('connections.json', all);
    return publicView(stored);
  });
}

function deleteConnection(id) {
  return serial('connections.json', async () => {
    writeJson('connections.json', readJson('connections.json', []).filter((c) => c.id !== id));
    const tabs = await readEncJson('tabs.enc', {});
    delete tabs[id];
    await writeEncJson('tabs.enc', tabs);
  });
}

function reorderConnections(ids) {
  return serial('connections.json', async () => {
    const all = readJson('connections.json', []);
    const byId = new Map(all.map((c) => [c.id, c]));
    const sorted = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const c of all) if (!ids.includes(c.id)) sorted.push(c);
    writeJson('connections.json', sorted);
  });
}

// ------------------------------------------------------------------ settings
function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) };
}

function setSettings(patch) {
  const s = { ...getSettings(), ...patch };
  writeJson('settings.json', s);
  if (patch.historyEnabled === false || 'historyRetentionDays' in patch) pruneHistory();
  return s;
}

// ------------------------------------------------------------------ history
const Q = String.raw`(?:'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*")`;
const REDACTIONS = [
  new RegExp(String.raw`(IDENTIFIED\s+(?:WITH\s+\S+\s+)?(?:BY|AS)\s+)` + Q, 'gi'),
  new RegExp(String.raw`(\bPASSWORD\s*\(\s*)` + Q, 'gi'),
  new RegExp(String.raw`(\bSET\s+PASSWORD\b[^=;]*=\s*)` + Q, 'gi'),
  new RegExp(String.raw`(\b(?:MASTER|SOURCE)_PASSWORD\s*=\s*)` + Q, 'gi'),
  new RegExp(String.raw`(\b(?:AES_ENCRYPT|AES_DECRYPT|ENCODE|DECODE|DES_ENCRYPT|DES_DECRYPT)\s*\([^,]*,\s*)` + Q, 'gi'),
];

// Mask passwords/keys written as literals in statements before they are stored.
function redactSql(sql) {
  let out = sql;
  for (const re of REDACTIONS) out = out.replace(re, "$1'***'");
  return out;
}

let historyCache = null;

async function loadHistory() {
  if (historyCache) return historyCache;
  historyCache = await readEncJson('history.enc', []);
  // Migrate the old plaintext history.json, then delete it.
  const legacy = filePath('history.json');
  if (fs.existsSync(legacy)) {
    const old = readJson('history.json', []);
    historyCache = [...historyCache, ...old.map((h) => ({ ...h, sql: redactSql(h.sql || '') }))].sort((a, b) => b.ts - a.ts);
    await writeEncJson('history.enc', historyCache);
    if (await canEncrypt()) fs.rmSync(legacy, { force: true });
  }
  return historyCache;
}

function applyRetention(list) {
  const { historyEnabled, historyRetentionDays } = getSettings();
  if (!historyEnabled) return [];
  const cutoff = historyRetentionDays > 0 ? Date.now() - historyRetentionDays * 86400000 : 0;
  return list.filter((h) => h.ts >= cutoff).slice(0, HISTORY_MAX);
}

function pruneHistory() {
  return serial('history.enc', async () => {
    historyCache = applyRetention(await loadHistory());
    await writeEncJson('history.enc', historyCache);
  });
}

async function listHistory(connectionId) {
  const all = applyRetention(await loadHistory());
  return connectionId ? all.filter((h) => h.connectionId === connectionId) : all;
}

function addHistory(entry) {
  if (!getSettings().historyEnabled) return Promise.resolve();
  return serial('history.enc', async () => {
    const all = await loadHistory();
    const e = { ...entry, sql: redactSql(String(entry.sql || '')) };
    if (all.length && all[0].sql === e.sql && all[0].connectionId === e.connectionId) all[0] = { ...all[0], ...e };
    else all.unshift(e);
    historyCache = applyRetention(all);
    await writeEncJson('history.enc', historyCache);
  });
}

function clearHistory(connectionId) {
  return serial('history.enc', async () => {
    const all = await loadHistory();
    historyCache = connectionId ? all.filter((h) => h.connectionId !== connectionId) : [];
    await writeEncJson('history.enc', historyCache);
  });
}

// ------------------------------------------------------------------ tabs
let tabsCache = null;
async function loadTabs(connectionId) {
  if (!tabsCache) tabsCache = await readEncJson('tabs.enc', {});
  return tabsCache[connectionId] || null;
}

function saveTabs(connectionId, state) {
  return serial('tabs.enc', async () => {
    if (!tabsCache) tabsCache = await readEncJson('tabs.enc', {});
    tabsCache[connectionId] = state;
    await writeEncJson('tabs.enc', tabsCache);
  });
}

// ------------------------------------------------------------------ trusted SSH host keys
function getTrustedHostKey(hostId) {
  return readJson('known_hosts.json', {})[hostId] || null;
}

function trustHostKey(hostId, entry) {
  const all = readJson('known_hosts.json', {});
  all[hostId] = { ...entry, addedAt: new Date().toISOString() };
  writeJson('known_hosts.json', all);
}

module.exports = {
  listConnections,
  resolveSecrets,
  saveConnection,
  deleteConnection,
  reorderConnections,
  getSettings,
  setSettings,
  listHistory,
  addHistory,
  clearHistory,
  redactSql,
  loadTabs,
  saveTabs,
  getTrustedHostKey,
  trustHostKey,
};
