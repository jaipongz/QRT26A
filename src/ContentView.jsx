import React, { useCallback, useEffect, useRef, useState } from 'react';
import Grid from './Grid';
import { useContextMenu } from './ContextMenu';
import { api, qid, sqlLiteral, toCsv, toTsv, toInsert, toJson, formatNumber, formatMs, loadLocal, saveLocal } from './util';

const OPS = [
  ['contains', 'contains'],
  ['=', '='],
  ['!=', '≠'],
  ['>', '>'],
  ['<', '<'],
  ['>=', '≥'],
  ['<=', '≤'],
  ['LIKE', 'LIKE'],
  ['NOT LIKE', 'NOT LIKE'],
  ['IN', 'IN'],
  ['IS NULL', 'IS NULL'],
  ['IS NOT NULL', 'IS NOT NULL'],
  ['custom', 'Custom WHERE…'],
];

function buildWhere(f) {
  if (f.op === 'custom') return f.value.trim();
  if (!f.col) {
    // Any column contains value
    return null;
  }
  const c = qid(f.col);
  switch (f.op) {
    case 'IS NULL':
    case 'IS NOT NULL':
      return `${c} ${f.op}`;
    case 'contains':
      return f.value === '' ? '' : `${c} LIKE ${sqlLiteral('%' + f.value.replace(/[\\%_]/g, (m) => '\\' + m) + '%')}`;
    case 'IN': {
      const parts = f.value.split(',').map((s) => s.trim()).filter(Boolean);
      return parts.length ? `${c} IN (${parts.map(sqlLiteral).join(', ')})` : '';
    }
    default:
      return f.value === '' && f.op !== '=' ? '' : `${c} ${f.op} ${sqlLiteral(f.value)}`;
  }
}

export default function ContentView({ tabId, db, table, schema, refreshKey, onStatus, isView }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(null); // exact count, loaded after the rows
  const [filter, setFilter] = useState({ col: '', op: 'contains', value: '' });
  const [applied, setApplied] = useState('');
  const [sort, setSort] = useState(null);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(() => loadLocal('pageSize', 1000));
  const [selected, setSelected] = useState(new Set());
  const [draft, setDraft] = useState(null); // { values: [], edited: Set }
  const [openMenu, menuEl] = useContextMenu();
  const reqId = useRef(0);

  // Column / key info comes from the schema cache loaded when the database was selected.
  const schemaCols = schema?.details?.columns?.[table] || null;
  const pkIndex = schema?.details?.indexes?.[table]?.find((i) => i.name === 'PRIMARY');
  const structure = schemaCols ? { columns: schemaCols, primaryKey: pkIndex ? pkIndex.columns.map((c) => c.name) : [] } : null;
  const estimate = schema?.stats?.find((t) => t.name === table)?.rows;

  const load = useCallback(async () => {
    if (!db || !table) return;
    const my = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.content(tabId, { db, table, where: applied, orderBy: sort?.col, orderDir: sort?.dir, limit, offset });
      if (my !== reqId.current) return;
      setData(r);
      setSelected(new Set());
      onStatus({ text: `${formatNumber(r.rows.length)} rows · ${formatMs(r.ms)}`, sql: r.sql });
      // Exact total in the background (can be slow on big tables; never blocks the rows).
      if (r.rows.length < limit && offset === 0) setTotal(r.rows.length);
      else {
        setTotal(null);
        api.count({ db, table, where: applied }).then((n) => my === reqId.current && setTotal(n)).catch(() => {});
      }
    } catch (e) {
      if (my !== reqId.current) return;
      setError(e.message);
      setData(null);
    } finally {
      if (my === reqId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, db, table, applied, sort, limit, offset]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const apply = () => {
    const w = buildWhere(filter);
    if (w === null) {
      // "Any column" search: OR across all columns.
      const cols = (structure?.columns || data?.columns || []).map((c) => c.name);
      const v = filter.value;
      setApplied(v ? cols.map((c) => `${qid(c)} LIKE ${sqlLiteral('%' + v + '%')}`).join(' OR ') : '');
    } else {
      setApplied(w);
    }
    setOffset(0);
  };

  const columns = data?.columns || [];
  const rows = data?.rows || [];
  const pk = structure?.primaryKey || [];
  const editable = !isView && !!data;

  const rowKey = (row) => {
    const names = columns.map((c) => c.name);
    if (pk.length && pk.every((p) => names.includes(p))) return Object.fromEntries(pk.map((p) => [p, row[names.indexOf(p)]]));
    return Object.fromEntries(names.map((n, i) => [n, row[i]]));
  };

  const updateCell = async (r, c, value) => {
    if (draft && r === rows.length) {
      setDraft((d) => {
        const values = [...d.values];
        values[c] = value;
        return { values, edited: new Set([...d.edited, c]) };
      });
      return;
    }
    const row = rows[r];
    try {
      const res = await api.updateRow(tabId, { db, table, key: rowKey(row), changes: { [columns[c].name]: value } });
      if (res.affectedRows === 0) onStatus({ text: 'No row was updated (row changed or not found)', sql: res.sql, error: true });
      else onStatus({ text: 'Row updated', sql: res.sql });
      setData((d) => ({ ...d, rows: d.rows.map((x, i) => (i === r ? x.map((v, j) => (j === c ? value : v)) : x)) }));
    } catch (e) {
      onStatus({ text: e.message, error: true });
      alertError(e.message);
    }
  };

  const deleteRows = async (idxs) => {
    const real = idxs.filter((i) => i < rows.length);
    if (!real.length) return;
    const ok = await api.confirm({
      message: `Delete ${real.length} row${real.length > 1 ? 's' : ''} from ${table}?`,
      detail: pk.length ? undefined : 'This table has no primary key — rows are matched on all column values.',
      okLabel: 'Delete',
    });
    if (!ok) return;
    try {
      const res = await api.deleteRows(tabId, { db, table, keys: real.map((i) => rowKey(rows[i])) });
      onStatus({ text: `${res.affectedRows} row(s) deleted`, sql: res.sql });
      load();
    } catch (e) {
      alertError(e.message);
    }
  };

  const addRow = () => {
    if (!columns.length) return;
    setDraft({ values: columns.map(() => null), edited: new Set() });
  };

  const saveDraft = async () => {
    const values = {};
    for (const c of draft.edited) values[columns[c].name] = draft.values[c];
    try {
      const res = await api.insertRow(tabId, { db, table, values });
      onStatus({ text: `Row inserted${res.insertId ? ' (id ' + res.insertId + ')' : ''}`, sql: res.sql });
      setDraft(null);
      load();
    } catch (e) {
      alertError(e.message);
    }
  };

  const setNull = async (r, c) => updateCell(r, c, null);

  const shownRows = draft ? [...rows, draft.values] : rows;

  const onCtx = (e, r, c) => {
    const sel = selected.has(r) ? [...selected].sort((a, b) => a - b).filter((i) => i < rows.length) : [r];
    const selRows = sel.map((i) => rows[i]);
    const v = c >= 0 ? shownRows[r]?.[c] : undefined;
    openMenu(e, [
      c >= 0 && { label: 'Copy Value', onClick: () => api.copy(v === null ? 'NULL' : String(v)) },
      { label: `Copy ${selRows.length > 1 ? selRows.length + ' Rows' : 'Row'}`, shortcut: '⌘C', onClick: () => api.copy(toTsv(columns, selRows)) },
      { label: 'Copy with Header', shortcut: '⇧⌘C', onClick: () => api.copy(toTsv(columns, selRows, true)) },
      { label: 'Copy as INSERT', onClick: () => api.copy(toInsert(table, columns, selRows)) },
      { label: 'Copy as JSON', onClick: () => api.copy(toJson(columns, selRows)) },
      c >= 0 && '-',
      c >= 0 && {
        label: `Filter: ${columns[c]?.name} = ${v === null ? 'NULL' : String(v).slice(0, 30)}`,
        onClick: () => {
          const f = v === null ? { col: columns[c].name, op: 'IS NULL', value: '' } : { col: columns[c].name, op: '=', value: String(v) };
          setFilter(f);
          setApplied(buildWhere(f));
          setOffset(0);
        },
      },
      '-',
      editable && c >= 0 && { label: 'Set NULL', onClick: () => setNull(r, c) },
      editable && c >= 0 && { label: 'Set to NOW()', onClick: () => updateCell(r, c, { expr: 'NOW()' }).then(load) },
      editable && {
        label: 'Duplicate Row',
        onClick: () => {
          const src = rows[r];
          const values = columns.map((col, i) => (pk.includes(col.name) ? null : src[i]));
          setDraft({ values, edited: new Set(columns.map((_, i) => i).filter((i) => !pk.includes(columns[i].name))) });
        },
      },
      editable && { label: `Delete ${sel.length > 1 ? sel.length + ' Rows' : 'Row'}`, shortcut: '⌫', danger: true, onClick: () => deleteRows(sel) },
    ].filter(Boolean).filter((x, i, a) => !(x === '-' && (i === 0 || a[i - 1] === '-' || i === a.length - 1))));
  };

  const exportCsv = async () => {
    const p = await api.saveText({ defaultName: `${table}.csv`, content: toCsv(columns, rows) });
    if (p) onStatus({ text: `Exported ${rows.length} rows to ${p}` });
  };

  const knownTotal = total ?? (estimate != null ? Number(estimate) : null);
  const from = rows.length ? offset + 1 : 0;
  const to = offset + rows.length;
  const totalLabel = total != null ? formatNumber(total) : knownTotal != null ? '~' + formatNumber(knownTotal) : '…';
  const hasMore = total != null ? offset + limit < total : rows.length === limit;
  const colNames = (structure?.columns || data?.columns || []).map((c) => c.name);

  return (
    <div className="content-view">
      <div className="toolbar">
        <select value={filter.col} onChange={(e) => setFilter((f) => ({ ...f, col: e.target.value }))} disabled={filter.op === 'custom'}>
          <option value="">Any column</option>
          {colNames.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={filter.op} onChange={(e) => setFilter((f) => ({ ...f, op: e.target.value }))}>
          {OPS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {!['IS NULL', 'IS NOT NULL'].includes(filter.op) && (
          <input
            className="filter-input"
            value={filter.value}
            placeholder={filter.op === 'custom' ? "e.g. status = 'active' AND id > 100" : filter.op === 'IN' ? 'a, b, c' : 'value'}
            onChange={(e) => setFilter((f) => ({ ...f, value: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        )}
        <button onClick={apply}>Filter</button>
        {applied && (
          <button
            onClick={() => {
              setFilter({ col: '', op: 'contains', value: '' });
              setApplied('');
              setOffset(0);
            }}
          >
            Clear
          </button>
        )}
        <span className="spacer" />
        {editable && !draft && (
          <button onClick={addRow} title="Add row">
            ＋ Row
          </button>
        )}
        {draft && (
          <>
            <button className="primary" onClick={saveDraft}>
              Save Row
            </button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </>
        )}
        <button onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </button>
      </div>
      {applied && <div className="applied-filter">WHERE {applied}</div>}
      {error && <div className="error-banner">{error}</div>}
      {!pk.length && structure && !isView && rows.length > 0 && (
        <div className="warn-banner">No primary key — edits match rows on all column values.</div>
      )}
      <div className="grid-wrap">
        {data && (
          <Grid
            columns={columns}
            rows={shownRows}
            rowOffset={offset}
            editable={editable}
            sort={sort}
            onSort={(col) => {
              setSort((s) => (s && s.col === col ? (s.dir === 'ASC' ? { col, dir: 'DESC' } : null) : { col, dir: 'ASC' }));
              setOffset(0);
            }}
            onCommitEdit={updateCell}
            onDeleteRows={deleteRows}
            onContextMenu={onCtx}
            selected={selected}
            onSelect={setSelected}
            rowClass={(r) => (draft && r === rows.length ? 'draft' : '')}
            emptyText={applied ? 'No rows match the filter' : 'Table is empty'}
          />
        )}
        {loading && <div className="loading-overlay">Loading…</div>}
      </div>
      <div className="pager">
        <span>
          {formatNumber(from)}–{formatNumber(to)} of {totalLabel} rows
        </span>
        <span className="spacer" />
        <button disabled={offset === 0} onClick={() => setOffset(0)}>
          ⇤
        </button>
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
          ‹ Prev
        </button>
        <button disabled={!hasMore} onClick={() => setOffset(offset + limit)}>
          Next ›
        </button>
        <button disabled={!hasMore || total == null} onClick={() => setOffset(Math.floor((total - 1) / limit) * limit)}>
          ⇥
        </button>
        <select
          value={limit}
          onChange={(e) => {
            const v = Number(e.target.value);
            setLimit(v);
            saveLocal('pageSize', v);
            setOffset(0);
          }}
        >
          {[100, 500, 1000, 5000, 10000].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      </div>
      {menuEl}
    </div>
  );
}

function alertError(msg) {
  window.dispatchEvent(new CustomEvent('qrt-error', { detail: msg }));
}
