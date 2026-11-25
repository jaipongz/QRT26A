const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) {
    // contextBridge strips every property except `message` from Error objects, so reject with a plain
    // object instead — the UI needs errno/code (e.g. 1060 "already exists" when re-running migrations).
    throw { name: 'DbError', message: r.error, code: r.code, errno: r.errno };
  }
  return r.data;
};

contextBridge.exposeInMainWorld('api', {
  listConnections: () => call('conn:list'),
  saveConnection: (c) => call('conn:save', c),
  deleteConnection: (id) => call('conn:delete', id),
  reorderConnections: (ids) => call('conn:reorder', ids),
  testConnection: (c) => call('conn:test', c),
  connect: (c) => call('conn:connect', c),
  disconnect: () => call('conn:disconnect'),

  databases: () => call('db:databases'),
  tableList: (db) => call('db:tableList', db),
  schemaDetails: (db) => call('db:schemaDetails', db),
  tableStats: (db) => call('db:tableStats', db),
  createStatement: (db, t) => call('db:createStatement', db, t),
  content: (tabId, opts) => call('db:content', tabId, opts),
  count: (opts) => call('db:count', opts),
  query: (tabId, sql, db) => call('db:query', tabId, sql, db),
  cancel: (tabId) => call('db:cancel', tabId),
  txState: (tabId) => call('db:txState', tabId),
  closeTab: (tabId) => call('db:closeTab', tabId),
  updateRow: (tabId, o) => call('db:update', tabId, o),
  insertRow: (tabId, o) => call('db:insert', tabId, o),
  deleteRows: (tabId, o) => call('db:delete', tabId, o),
  ddl: (tabId, sql, db) => call('db:ddl', tabId, sql, db),

  history: (cid) => call('history:list', cid),
  addHistory: (e) => call('history:add', e),
  clearHistory: (cid) => call('history:clear', cid),
  getSettings: () => call('settings:get'),
  setAppearance: (v) => call('appearance:set', v),
  takeLegacyPrefs: () => call('settings:takeLegacyPrefs'),
  setSettings: (p) => call('settings:set', p),
  loadTabs: (cid) => call('tabs:load', cid),
  saveTabs: (cid, state) => call('tabs:save', cid, state),
  saveTabsSync: (cid, state) => ipcRenderer.sendSync('tabs:saveSync', cid, state),
  chooseFile: (o) => call('dialog:openFile', o),

  chooseKeyFile: () => call('dialog:openKey'),
  saveText: (o) => call('file:saveText', o),
  openSql: () => call('file:openSql'),
  copy: (text) => call('clipboard:write', text),
  confirm: (o) => call('confirm', o),

  onMenu: (fn) => {
    const listener = (_e, channel) => fn(channel);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
