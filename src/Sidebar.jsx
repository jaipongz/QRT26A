import React, { useMemo, useRef, useState, useEffect } from 'react';
import { api, qid } from './util';
import { useContextMenu } from './ContextMenu';

export default function Sidebar({ conn, databases, db, onDb, schema, table, onTable, onRefresh, onDisconnect, onOpenQuery, filterRef, width }) {
  const tables = schema?.tables || [];
  const routines = schema?.details?.routines || [];
  const [filter, setFilter] = useState('');
  const [openMenu, menuEl] = useContextMenu();
  const [collapsed, setCollapsed] = useState({});
  const listRef = useRef(null);

  useEffect(() => setFilter(''), [db]);

  const f = filter.toLowerCase();
  const groups = useMemo(() => {
    const match = (n) => !f || n.toLowerCase().includes(f);
    return [
      { key: 'tables', title: 'Tables', items: tables.filter((t) => t.type !== 'VIEW' && match(t.name)), icon: '▦' },
      { key: 'views', title: 'Views', items: tables.filter((t) => t.type === 'VIEW' && match(t.name)), icon: '◫' },
      { key: 'routines', title: 'Routines', items: routines.filter((r) => match(r.name)), icon: 'ƒ' },
    ];
  }, [tables, routines, f]);

  const flat = groups.slice(0, 2).flatMap((g) => (collapsed[g.key] ? [] : g.items));

  const onFilterKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = flat.findIndex((t) => t.name === table);
      const next = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) onTable(next.name);
    } else if (e.key === 'Enter' && flat[0] && !flat.some((t) => t.name === table)) {
      onTable(flat[0].name);
    } else if (e.key === 'Escape') {
      setFilter('');
    }
  };

  const tableMenu = (e, t) =>
    openMenu(e, [
      { label: 'Open Content', onClick: () => onTable(t.name, { view: 'content' }) },
      { label: 'Open Structure', onClick: () => onTable(t.name, { view: 'structure' }) },
      { label: 'Open in New Tab', shortcut: '⌘-click', onClick: () => onTable(t.name, { newTab: true }) },
      '-',
      { label: 'Copy Name', onClick: () => api.copy(t.name) },
      { label: 'Copy SELECT Statement', onClick: () => api.copy(`SELECT * FROM ${qid(t.name)};`) },
      { label: 'New Query: SELECT * …', onClick: () => onOpenQuery(`SELECT *\nFROM ${qid(t.name)}\nLIMIT 100;`) },
      { label: 'Show CREATE Statement', onClick: () => onOpenQuery(`SHOW CREATE ${t.type === 'VIEW' ? 'VIEW' : 'TABLE'} ${qid(t.name)};`, true) },
      '-',
      { label: 'Refresh', onClick: onRefresh },
    ]);

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <div className="conn-chip" title={`${conn.user}@${conn.host}:${conn.port}${conn.useSsh ? ' via SSH ' + conn.sshHost : ''}`}>
          <span className="dot" style={{ background: conn.color || 'var(--accent)' }} />
          <span className="conn-chip-name">{conn.name || conn.host}</span>
          <button className="icon-btn" title="Disconnect (⇧⌘D)" onClick={onDisconnect}>
            ⏏
          </button>
        </div>
        <div className="db-select-row">
          <select className="db-select" value={db || ''} onChange={(e) => onDb(e.target.value)}>
            <option value="" disabled>
              Choose database…
            </option>
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <button className="icon-btn" title="Refresh (⌘R)" onClick={onRefresh}>
            ↻
          </button>
        </div>
        <input ref={filterRef} className="search" placeholder="Filter tables" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={onFilterKey} />
      </div>
      <div className="sidebar-list" ref={listRef}>
        {groups.map((g) =>
          g.items.length || (g.key === 'tables' && !f) ? (
            <div key={g.key} className="side-group">
              <div className="side-group-title" onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}>
                <span className="caret">{collapsed[g.key] ? '▸' : '▾'}</span>
                {g.title}
                <span className="count">{g.items.length}</span>
              </div>
              {!collapsed[g.key] &&
                g.items.map((t) =>
                  g.key === 'routines' ? (
                    <div
                      key={t.name}
                      className="side-item"
                      onDoubleClick={() => onOpenQuery(`SHOW CREATE ${t.type} ${qid(t.name)};`, true)}
                      onContextMenu={(e) =>
                        openMenu(e, [
                          { label: 'Show CREATE Statement', onClick: () => onOpenQuery(`SHOW CREATE ${t.type} ${qid(t.name)};`, true) },
                          { label: 'Copy Name', onClick: () => api.copy(t.name) },
                        ])
                      }
                      title={t.type}
                    >
                      <span className="side-icon">{g.icon}</span>
                      <span className="side-name">{t.name}</span>
                    </div>
                  ) : (
                    <div
                      key={t.name}
                      className={'side-item' + (t.name === table ? ' active' : '')}
                      onClick={(e) => onTable(t.name, { newTab: e.metaKey || e.ctrlKey })}
                      onAuxClick={(e) => e.button === 1 && onTable(t.name, { newTab: true })}
                      onContextMenu={(e) => tableMenu(e, t)}
                      title={t.comment || t.name}
                    >
                      <span className="side-icon">{g.icon}</span>
                      <span className="side-name">{t.name}</span>
                    </div>
                  )
                )}
            </div>
          ) : null
        )}
        {!db && <div className="empty-note">Choose a database</div>}
        {db && schema?.error && <div className="error-note">{schema.error}</div>}
        {db && !schema?.tables && !schema?.error && <div className="empty-note">Loading…</div>}
      </div>
      {menuEl}
    </aside>
  );
}
