import React, { useEffect, useMemo, useState } from 'react';
import ContentView from './ContentView';
import StructureView, { InfoView } from './StructureView';
import QueryView from './QueryView';

const VIEWS = [
  ['content', 'Content', '⌘1'],
  ['structure', 'Structure', '⌘2'],
  ['query', 'Query', '⌘3'],
  ['info', 'Info', '⌘4'],
];

// One workspace tab: its own database/table/view, its own query editor + results, its own server connection.
export default function TabPane({ tab, active, conn, schema, onUpdate, onStatus, onSchemaChange, onOpenTable, registerCommands }) {
  const { db, table, view } = tab;
  const [visitedQuery, setVisitedQuery] = useState(view === 'query');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (view === 'query') setVisitedQuery(true);
  }, [view]);

  useEffect(() => {
    const h = (e) => e.detail === tab.id && setRefreshKey((k) => k + 1);
    window.addEventListener('qrt-refresh', h);
    return () => window.removeEventListener('qrt-refresh', h);
  }, [tab.id]);

  const completion = useMemo(() => {
    const cols = schema?.details?.columns;
    if (cols) return Object.fromEntries(Object.entries(cols).map(([t, cs]) => [t, cs.map((c) => c.name)]));
    if (schema?.tables) return Object.fromEntries(schema.tables.map((t) => [t.name, []]));
    return {};
  }, [schema]);

  const tableMeta = schema?.tables?.find((t) => t.name === table);
  const isView = tableMeta?.type === 'VIEW';
  const needsTable = view === 'content' || view === 'structure';
  const tableMissing = table && schema?.tables && !tableMeta;

  return (
    <div className="tabpane" style={{ display: active ? 'flex' : 'none' }}>
      <header className="topbar">
        <div className="seg big">
          {VIEWS.map(([k, l, sc]) => (
            <button key={k} className={view === k ? 'on' : ''} onClick={() => onUpdate({ view: k })} title={sc}>
              {l}
            </button>
          ))}
        </div>
        <div className="crumb">
          {db ? <span>{db}</span> : <span className="dim">no database selected</span>}
          {db && table && view !== 'query' && (
            <>
              <span className="sep">›</span>
              <span className="strong">{table}</span>
            </>
          )}
        </div>
      </header>
      <div className="view-area">
        {needsTable && !db && <div className="placeholder">Choose a database in the sidebar</div>}
        {needsTable && db && !table && <div className="placeholder">Select a table in the sidebar</div>}
        {needsTable && tableMissing && <div className="placeholder">Table “{table}” no longer exists</div>}
        {view === 'content' && db && table && !tableMissing && (
          <ContentView
            key={db + '.' + table}
            tabId={tab.id}
            db={db}
            table={table}
            schema={schema}
            isView={isView}
            refreshKey={refreshKey}
            onStatus={onStatus}
          />
        )}
        {view === 'structure' && db && table && !tableMissing && (
          <StructureView
            key={db + '.' + table}
            tabId={tab.id}
            db={db}
            table={table}
            schema={schema}
            isView={isView}
            refreshKey={refreshKey}
            onStatus={onStatus}
            onSchemaChange={() => onSchemaChange(db)}
          />
        )}
        {view === 'info' && (db ? <InfoView db={db} table={table} schema={schema} onTable={(t) => onOpenTable(t, 'content')} /> : <div className="placeholder">Choose a database in the sidebar</div>)}
        {(visitedQuery || view === 'query') && (
          <div className="query-host" style={{ display: view === 'query' ? 'flex' : 'none' }}>
            <QueryView
              tab={tab}
              conn={conn}
              schema={completion}
              visible={active && view === 'query'}
              onUpdate={onUpdate}
              onStatus={onStatus}
              onSchemaChange={onSchemaChange}
              registerCommands={registerCommands}
            />
          </div>
        )}
      </div>
    </div>
  );
}
