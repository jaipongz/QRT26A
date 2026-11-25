import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import TabPane from './TabPane';
import { useContextMenu } from './ContextMenu';
import { api, loadLocal, saveLocal } from './util';

let seq = Date.now();
const newId = () => 't' + ++seq;
const makeTab = (p = {}) => ({ id: newId(), db: '', table: null, view: 'query', sql: '', title: '', ...p });

const VIEW_ICON = { content: '▦', structure: '☰', query: '⌨', info: 'ⓘ' };

export function tabTitle(t) {
  if (t.view === 'query') {
    if (t.title) return t.title;
    const first = (t.sql || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('--'));
    return first ? first.slice(0, 30) : 'Query';
  }
  return t.table || t.db || 'New Tab';
}

export default function Workspace({ conn, info, savedTabs, onDisconnect }) {
  const cid = conn.id || conn.host;
  const [databases, setDatabases] = useState([]);
  const [schemas, setSchemas] = useState({}); // db -> { tables, details, stats, loading, error }
  const schemasRef = useRef(schemas);
  schemasRef.current = schemas;
  const inflight = useRef({});

  const [tabsState, setTabsState] = useState(() => {
    const saved = savedTabs;
    const initialDb = conn.database || loadLocal('lastDb:' + cid, '');
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
      const tabs = saved.tabs.map((t) => ({ ...makeTab(), ...t, autorun: false }));
      return { tabs, active: tabs.some((t) => t.id === saved.active) ? saved.active : tabs[0].id };
    }
    const t = makeTab({ db: initialDb });
    return { tabs: [t], active: t.id };
  });
  const { tabs } = tabsState;
  const active = tabs.find((t) => t.id === tabsState.active) || tabs[0];

  const [status, setStatusMap] = useState({});
  const [sideW, setSideW] = useState(() => loadLocal('sidebarWidth', 250));
  const [errorMsg, setErrorMsg] = useState(null);
  const [dragTab, setDragTab] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [openMenu, menuEl] = useContextMenu();
  const commandRefs = useRef({}); // tabId -> fn(cmd)
  const filterRef = useRef(null);

  // ------------------------------------------------------------------ schema cache
  const patchSchema = (db, p) => setSchemas((s) => ({ ...s, [db]: { ...s[db], ...p } }));

  const loadSchema = useCallback((db, force = false) => {
    if (!db) return Promise.resolve();
    const cur = schemasRef.current[db];
    if (!force && (inflight.current[db] || (cur && cur.details))) return inflight.current[db] || Promise.resolve();
    const p = (async () => {
      patchSchema(db, { loading: true, error: null });
      try {
        // 1 round trip: table names → sidebar shows immediately.
        const tables = await api.tableList(db);
        patchSchema(db, { tables });
        // 1 round trip: columns, indexes, FKs, routines for the whole database.
        const details = await api.schemaDetails(db);
        patchSchema(db, { details, loading: false });
        api.tableStats(db).then((stats) => patchSchema(db, { stats })).catch(() => {});
      } catch (e) {
        patchSchema(db, { loading: false, error: e.message });
      }
    })();
    inflight.current[db] = p;
    p.finally(() => {
      if (inflight.current[db] === p) delete inflight.current[db];
    });
    return p;
  }, []);

  // Load the database list and the active tab's schema as soon as we connect.
  useEffect(() => {
    api
      .databases()
      .then((list) => {
        setDatabases(list);
        // Drop databases that no longer exist from saved tabs.
        setTabsState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.db && !list.includes(t.db) ? { ...t, db: '', table: null } : t)) }));
      })
      .catch((e) => setErrorMsg(e.message));
  }, []);

  // Every database used by any tab gets loaded (active one first).
  useEffect(() => {
    loadSchema(active.db);
    for (const t of tabs) loadSchema(t.db);
  }, [active.db, tabs, loadSchema]);

  // Tabs (incl. their SQL) are stored encrypted by the main process.
  const tabsSnapshot = useRef(null);
  tabsSnapshot.current = { tabs: tabs.map(({ autorun, ...t }) => t), active: active.id };
  useEffect(() => {
    const h = setTimeout(() => api.saveTabs(cid, tabsSnapshot.current).catch(() => {}), 400);
    return () => clearTimeout(h);
  }, [tabs, active.id, cid]);
  useEffect(() => {
    const flush = () => api.saveTabsSync(cid, tabsSnapshot.current);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      api.saveTabs(cid, tabsSnapshot.current).catch(() => {}); // disconnect: don't lose the last edits
    };
  }, [cid]);

  useEffect(() => {
    if (active.db) saveLocal('lastDb:' + cid, active.db);
  }, [active.db, cid]);

  useEffect(() => {
    const onErr = (e) => setErrorMsg(e.detail);
    window.addEventListener('qrt-error', onErr);
    return () => window.removeEventListener('qrt-error', onErr);
  }, []);

  // ------------------------------------------------------------------ tab operations
  const updateTab = useCallback((id, p) => setTabsState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...p } : t)) })), []);
  const activate = (id) => setTabsState((s) => ({ ...s, active: id }));

  const addTab = (p = {}) => {
    const t = makeTab({ db: active.db, ...p });
    setTabsState((s) => {
      const i = s.tabs.findIndex((x) => x.id === s.active);
      const list = [...s.tabs];
      list.splice(i + 1, 0, t);
      return { tabs: list, active: t.id };
    });
    return t;
  };

  // Tabs whose connection holds an open transaction (closing would roll it back).
  const tabsWithOpenTx = async (ids) => {
    const open = [];
    for (const id of ids) if (await api.txState(id).catch(() => false)) open.push(id);
    return open;
  };
  const confirmTxLoss = async (ids, what) => {
    const open = await tabsWithOpenTx(ids);
    if (!open.length) return true;
    const names = open.map((id) => tabTitle(tabs.find((t) => t.id === id) || {})).join(', ');
    return api.confirm({
      message: `${what}? ${open.length === 1 ? 'A transaction is' : open.length + ' transactions are'} still open.`,
      detail: `Uncommitted changes in: ${names}\n\nThey will be ROLLED BACK. Cancel, then use Commit in that tab to keep them.`,
      okLabel: 'Roll Back and Continue',
    });
  };

  const closeTab = async (id) => {
    if (!(await confirmTxLoss([id], 'Close this tab'))) return;
    api.cancel(id).catch(() => {});
    api.closeTab(id).catch(() => {});
    delete commandRefs.current[id];
    setStatusMap(({ [id]: _, ...rest }) => rest);
    setTabsState((s) => {
      if (s.tabs.length === 1) {
        const t = makeTab({ db: s.tabs[0].db });
        return { tabs: [t], active: t.id };
      }
      const i = s.tabs.findIndex((t) => t.id === id);
      const list = s.tabs.filter((t) => t.id !== id);
      return { tabs: list, active: s.active === id ? list[Math.min(i, list.length - 1)].id : s.active };
    });
  };

  const closeOthers = async (id) => {
    const others = tabs.filter((t) => t.id !== id).map((t) => t.id);
    if (!(await confirmTxLoss(others, 'Close other tabs'))) return;
    for (const o of others) {
      api.cancel(o).catch(() => {});
      api.closeTab(o).catch(() => {});
      delete commandRefs.current[o];
    }
    setTabsState((s) => ({ tabs: s.tabs.filter((t) => t.id === id), active: id }));
  };

  const cycleTab = (dir) => {
    const i = tabs.findIndex((t) => t.id === active.id);
    activate(tabs[(i + dir + tabs.length) % tabs.length].id);
  };

  const moveTab = (fromId, toId) => {
    if (fromId === toId) return;
    setTabsState((s) => {
      const list = [...s.tabs];
      const from = list.findIndex((t) => t.id === fromId);
      const [t] = list.splice(from, 1);
      list.splice(list.findIndex((x) => x.id === toId), 0, t);
      return { ...s, tabs: list };
    });
  };

  // Sidebar: open a table. Reuse a tab already showing it; replace the active tab unless it is a query tab.
  const openTable = (name, { newTab = false, view } = {}) => {
    const db = active.db;
    if (!newTab) {
      const existing = tabs.find((t) => t.db === db && t.table === name && t.view !== 'query');
      if (existing) {
        activate(existing.id);
        if (view) updateTab(existing.id, { view });
        return;
      }
      if (active.view !== 'query') {
        updateTab(active.id, { table: name, view: view || (active.view === 'info' ? 'content' : active.view) });
        return;
      }
    }
    addTab({ db, table: name, view: view || 'content' });
  };

  const openQuery = (sql, run) => addTab({ view: 'query', sql, autorun: !!run });

  const selectDb = (db) => updateTab(active.id, { db, table: null });

  const refresh = useCallback(async () => {
    api.databases().then(setDatabases).catch(() => {});
    if (active.db) await loadSchema(active.db, true);
    window.dispatchEvent(new CustomEvent('qrt-refresh', { detail: active.id }));
  }, [active.db, active.id, loadSchema]);

  const disconnect = async () => {
    if (!(await confirmTxLoss(tabs.map((t) => t.id), 'Disconnect'))) return;
    await api.disconnect();
    onDisconnect();
  };

  const setStatus = useCallback((tabId, s) => setStatusMap((m) => ({ ...m, [tabId]: s })), []);

  // ------------------------------------------------------------------ menu commands
  useEffect(
    () =>
      api.onMenu((cmd) => {
        if (cmd === 'preferences') return; // handled by App (settings modal)
        if (cmd.startsWith('view:')) return updateTab(active.id, { view: cmd.slice(5) });
        if (cmd === 'refresh') return refresh();
        if (cmd === 'disconnect') return disconnect();
        if (cmd === 'focusFilter') return filterRef.current?.focus();
        if (cmd === 'newTab') return addTab({ view: 'query' });
        if (cmd === 'closeTab') return closeTab(active.id);
        if (cmd === 'nextTab') return cycleTab(1);
        if (cmd === 'prevTab') return cycleTab(-1);
        if (cmd === 'openSql') {
          api.openSql().then((f) => f && addTab({ view: 'query', sql: f.content, title: f.name })).catch((e) => setErrorMsg(e.message));
          return;
        }
        // Query commands go to the active tab (switching it to the Query view if needed).
        if (active.view !== 'query') updateTab(active.id, { view: 'query' });
        setTimeout(() => commandRefs.current[active.id]?.(cmd), 0);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active.id, active.view, tabs, refresh]
  );

  const startSideDrag = (e) => {
    e.preventDefault();
    const move = (ev) => setSideW(Math.max(180, Math.min(520, ev.clientX)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
      setSideW((w) => (saveLocal('sidebarWidth', w), w));
    };
    document.body.classList.add('col-resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const activeSchema = schemas[active.db];
  const st = status[active.id] || { text: `Connected · ${info.version}` };

  const tabMenu = (e, t) =>
    openMenu(e, [
      { label: 'New Tab', shortcut: '⌘T', onClick: () => addTab({ view: 'query' }) },
      {
        label: 'Duplicate Tab',
        onClick: () => {
          const { id: _id, ...rest } = t;
          addTab({ ...rest, autorun: false });
        },
      },
      '-',
      { label: 'Close Tab', shortcut: '⌘W', onClick: () => closeTab(t.id) },
      { label: 'Close Other Tabs', disabled: tabs.length < 2, onClick: () => closeOthers(t.id) },
    ]);

  return (
    <div className="workspace" style={{ '--conn-color': conn.color || 'transparent' }}>
      <Sidebar
        conn={conn}
        databases={databases}
        db={active.db}
        onDb={selectDb}
        schema={activeSchema}
        table={active.view === 'query' ? null : active.table}
        onTable={openTable}
        onRefresh={refresh}
        onDisconnect={disconnect}
        onOpenQuery={openQuery}
        filterRef={filterRef}
        width={sideW}
      />
      <div className="vsplit" onMouseDown={startSideDrag} />
      <section className="main">
        <nav className="wtabs">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={'wtab' + (t.id === active.id ? ' active' : '') + (dragTab === t.id ? ' dragging' : '')}
              onMouseDown={(e) => e.button === 0 && activate(t.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
              onDoubleClick={() => t.view === 'query' && setRenaming(t.id)}
              onContextMenu={(e) => tabMenu(e, t)}
              draggable={renaming !== t.id}
              onDragStart={() => setDragTab(t.id)}
              onDragEnd={() => setDragTab(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dragTab && moveTab(dragTab, t.id)}
              title={`${t.db || 'no database'}${t.table && t.view !== 'query' ? ' › ' + t.table : ''}`}
            >
              <span className="wtab-icon">{VIEW_ICON[t.view]}</span>
              {renaming === t.id ? (
                <input
                  className="wtab-rename"
                  autoFocus
                  defaultValue={tabTitle(t)}
                  onFocus={(e) => e.target.select()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    updateTab(t.id, { title: e.target.value.trim() });
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.target.blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span className="wtab-title">{tabTitle(t)}</span>
              )}
              {t.db && t.db !== active.db && <span className="wtab-db">{t.db}</span>}
              <span
                className="wtab-close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ×
              </span>
            </div>
          ))}
          <button className="wtab-add" title="New Tab (⌘T)" onClick={() => addTab({ view: 'query' })}>
            ＋
          </button>
          <div className="wtabs-drag" />
        </nav>
        {errorMsg && (
          <div className="error-banner closable" onClick={() => setErrorMsg(null)}>
            {errorMsg} <span className="close">×</span>
          </div>
        )}
        {tabs.map((t) => (
          <TabPane
            key={t.id}
            tab={t}
            active={t.id === active.id}
            conn={conn}
            schema={schemas[t.db]}
            onUpdate={(p) => updateTab(t.id, p)}
            onStatus={(s) => setStatus(t.id, s)}
            onSchemaChange={(db) => loadSchema(db || t.db, true)}
            onOpenTable={(name, view) => openTable(name, { view })}
            registerCommands={(fn) => (commandRefs.current[t.id] = fn)}
          />
        ))}
        <footer className={'statusbar' + (st.error ? ' error' : '')}>
          <span className="status-text">{st.text}</span>
          {st.sql && (
            <span className="status-sql" title="Click to copy" onClick={() => api.copy(st.sql)}>
              {st.sql.replace(/\s+/g, ' ').slice(0, 300)}
            </span>
          )}
          <span className="spacer" />
          {activeSchema?.loading && <span className="dim">Loading schema…</span>}
          <span className="dim">
            {conn.user}@{conn.host}
            {conn.useSsh ? ` via ${conn.sshHost}` : ''} · {info.version}
          </span>
        </footer>
      </section>
      {menuEl}
    </div>
  );
}
