import React, { useEffect, useMemo, useState } from 'react';
import { api, qid, sqlLiteral, formatBytes, formatNumber } from './util';
import { useContextMenu } from './ContextMenu';

const TEXT_TYPE = /^(var)?char|text|enum|set\b|^tinytext|^mediumtext|^longtext/i;
const COMMON_TYPES = [
  'int', 'int unsigned', 'bigint', 'bigint unsigned', 'tinyint(1)', 'smallint', 'mediumint',
  'decimal(10,2)', 'float', 'double',
  'varchar(255)', 'varchar(100)', 'char(36)', 'text', 'mediumtext', 'longtext',
  'datetime', 'timestamp', 'date', 'time', 'year',
  'json', 'blob', 'varbinary(255)', "enum('a','b')", 'bit(1)',
];

const PLAIN_EXPR = /^(current_timestamp|now|localtime|localtimestamp|current_date|curdate)(\(\d*\))?$|^b'[01]*'$|^-?\d+(\.\d+)?$/i;

// Column definition used by ADD / CHANGE COLUMN.
export function columnDefinition(c) {
  let s = `${qid(c.name)} ${c.type.trim()}`;
  if (c.collation && TEXT_TYPE.test(c.type)) s += ` COLLATE ${c.collation}`;
  s += c.nullable ? ' NULL' : ' NOT NULL';
  if (c.defaultKind === 'null' && c.nullable) s += ' DEFAULT NULL';
  else if (c.defaultKind === 'value') s += ` DEFAULT ${sqlLiteral(c.defaultValue)}`;
  else if (c.defaultKind === 'expr' && c.defaultValue.trim()) {
    const e = c.defaultValue.trim();
    s += ` DEFAULT ${PLAIN_EXPR.test(e) ? e : '(' + e + ')'}`;
  }
  if (c.autoIncrement) s += ' AUTO_INCREMENT';
  if (c.onUpdate) s += ` ON UPDATE ${c.onUpdate}`;
  if (c.comment) s += ` COMMENT ${sqlLiteral(c.comment)}`;
  return s;
}

function toEditable(col) {
  const m = /on update (\S+)/i.exec(col.extra || '');
  return {
    name: col.name,
    type: col.type,
    nullable: col.nullable,
    defaultKind: col.defaultKind,
    defaultValue: col.defaultValue || '',
    autoIncrement: /auto_increment/i.test(col.extra || ''),
    onUpdate: m ? m[1] : '',
    comment: col.comment || '',
    collation: col.collation || '',
  };
}

const isGenerated = (col) => /\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b/i.test(col.extra || '');

export default function StructureView({ tabId, db, table, schema, isView, refreshKey, onStatus, onSchemaChange }) {
  const [tab, setTab] = useState('columns');
  const [ddl, setDdl] = useState(null);
  const [selCol, setSelCol] = useState(null);
  const [editor, setEditor] = useState(null); // { mode: 'add'|'edit', original, col }
  const [ixEditor, setIxEditor] = useState(null);
  const [preview, setPreview] = useState(null); // { sql, title }
  const [busy, setBusy] = useState(false);
  const [openMenu, menuEl] = useContextMenu();

  const details = schema?.details;
  const columns = details?.columns?.[table];
  const indexes = useMemo(() => {
    const list = details?.indexes?.[table] || [];
    return [...list].sort((a, b) => (a.name === 'PRIMARY' ? -1 : b.name === 'PRIMARY' ? 1 : 0));
  }, [details, table]);
  const fks = details?.foreignKeys?.[table] || [];
  const from = `${qid(db)}.${qid(table)}`;
  const readOnly = isView;

  useEffect(() => {
    setDdl(null);
  }, [db, table, refreshKey, details]);

  useEffect(() => {
    if (tab !== 'ddl' || ddl !== null) return;
    api.createStatement(db, table).then(setDdl).catch((e) => setDdl('-- ' + e.message));
  }, [tab, ddl, db, table]);

  if (schema?.error && !details) return <div className="error-banner">{schema.error}</div>;
  if (!columns) {
    if (details) return <div className="placeholder">Table “{table}” not found — try Refresh (⌘R)</div>;
    return <div className="placeholder">Loading structure…</div>;
  }

  const apply = async () => {
    setBusy(true);
    try {
      await api.ddl(tabId, preview.sql, db);
      onStatus({ text: preview.title + ' — done', sql: preview.sql });
      setPreview(null);
      setEditor(null);
      setIxEditor(null);
      onSchemaChange();
    } catch (e) {
      setPreview((p) => ({ ...p, error: e.message }));
    } finally {
      setBusy(false);
    }
  };

  const askDropColumn = (c) => setPreview({ title: `Drop column ${c.name}`, sql: `ALTER TABLE ${from} DROP COLUMN ${qid(c.name)};`, danger: true });
  const askDropIndex = (ix) =>
    setPreview({
      title: `Drop index ${ix.name}`,
      sql: ix.name === 'PRIMARY' ? `ALTER TABLE ${from} DROP PRIMARY KEY;` : `ALTER TABLE ${from} DROP INDEX ${qid(ix.name)};`,
      danger: true,
    });
  const askDropFk = (fk) => setPreview({ title: `Drop foreign key ${fk.name}`, sql: `ALTER TABLE ${from} DROP FOREIGN KEY ${qid(fk.name)};`, danger: true });

  const colMenu = (e, c, i) => {
    setSelCol(i);
    openMenu(e, [
      { label: 'Edit Column…', disabled: readOnly || isGenerated(c), onClick: () => setEditor({ mode: 'edit', original: c, col: toEditable(c) }) },
      { label: 'Add Column After…', disabled: readOnly, onClick: () => setEditor({ mode: 'add', after: c.name, col: blankColumn() }) },
      '-',
      { label: 'Copy Name', onClick: () => api.copy(c.name) },
      { label: 'Copy Definition', onClick: () => api.copy(columnDefinition(toEditable(c))) },
      '-',
      { label: 'Drop Column…', danger: true, disabled: readOnly || columns.length < 2, onClick: () => askDropColumn(c) },
    ]);
  };

  return (
    <div className="structure-view">
      <div className="toolbar">
        <div className="seg">
          {[
            ['columns', `Columns (${columns.length})`],
            ['indexes', `Indexes (${indexes.length})`],
            ['fks', `Foreign Keys (${fks.length})`],
            ['ddl', 'CREATE Statement'],
          ].map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {tab === 'columns' && !readOnly && (
          <>
            <button onClick={() => setEditor({ mode: 'add', after: columns[columns.length - 1]?.name, col: blankColumn() })}>＋ Column</button>
            <button
              disabled={selCol === null || isGenerated(columns[selCol] || {})}
              onClick={() => setEditor({ mode: 'edit', original: columns[selCol], col: toEditable(columns[selCol]) })}
            >
              Edit
            </button>
            <button disabled={selCol === null || columns.length < 2} onClick={() => askDropColumn(columns[selCol])}>
              Drop
            </button>
          </>
        )}
        {tab === 'indexes' && !readOnly && <button onClick={() => setIxEditor({ name: '', kind: 'INDEX', cols: [] })}>＋ Index</button>}
        {tab === 'ddl' && <button onClick={() => api.copy(ddl || '')}>Copy</button>}
        {readOnly && <span className="dim">View — read only</span>}
      </div>
      <div className="structure-body">
        {tab === 'columns' && (
          <table className="simple-table selectable">
            <thead>
              <tr>
                <th>#</th>
                <th>Field</th>
                <th>Type</th>
                <th>Null</th>
                <th>Key</th>
                <th>Default</th>
                <th>Extra</th>
                <th>Collation</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c, i) => (
                <tr
                  key={c.name}
                  className={selCol === i ? 'sel' : ''}
                  onClick={() => setSelCol(i)}
                  onDoubleClick={() => !readOnly && !isGenerated(c) && setEditor({ mode: 'edit', original: c, col: toEditable(c) })}
                  onContextMenu={(e) => colMenu(e, c, i)}
                >
                  <td className="dim">{i + 1}</td>
                  <td className="strong">
                    {c.key === 'PRI' && <span className="key-badge">PK</span>}
                    {c.name}
                  </td>
                  <td className="mono">{c.type}</td>
                  <td>{c.nullable ? '✓' : ''}</td>
                  <td>{c.key}</td>
                  <td className={'mono' + (c.defaultKind === 'null' ? ' null' : '')}>
                    {c.defaultKind === 'null' ? 'NULL' : c.defaultKind === 'none' ? '' : c.defaultValue}
                  </td>
                  <td>{c.extra.replace(/DEFAULT_GENERATED\s*/i, '')}</td>
                  <td className="dim">{c.collation}</td>
                  <td className="dim">{c.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'indexes' && (
          <table className="simple-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Unique</th>
                <th>Type</th>
                <th>Comment</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {indexes.map((ix) => (
                <tr key={ix.name}>
                  <td className="strong">{ix.name}</td>
                  <td className="mono">{ix.columns.map((c) => c.name + (c.subPart ? `(${c.subPart})` : '')).join(', ')}</td>
                  <td>{ix.unique ? '✓' : ''}</td>
                  <td>{ix.type}</td>
                  <td className="dim">{ix.comment}</td>
                  <td className="row-actions">{!readOnly && <button onClick={() => askDropIndex(ix)}>Drop</button>}</td>
                </tr>
              ))}
              {!indexes.length && (
                <tr>
                  <td colSpan={6} className="dim">
                    No indexes
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {tab === 'fks' && (
          <table className="simple-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>References</th>
                <th>On Update</th>
                <th>On Delete</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {fks.map((fk) => (
                <tr key={fk.name}>
                  <td className="strong">{fk.name}</td>
                  <td className="mono">{fk.columns.join(', ')}</td>
                  <td className="mono">
                    {fk.refDb !== db ? fk.refDb + '.' : ''}
                    {fk.refTable}({fk.refColumns.join(', ')})
                  </td>
                  <td>{fk.onUpdate}</td>
                  <td>{fk.onDelete}</td>
                  <td className="row-actions">{!readOnly && <button onClick={() => askDropFk(fk)}>Drop</button>}</td>
                </tr>
              ))}
              {!fks.length && (
                <tr>
                  <td colSpan={6} className="dim">
                    No foreign keys
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {tab === 'ddl' && <pre className="ddl">{ddl === null ? 'Loading…' : ddl}</pre>}
      </div>

      {editor && (
        <ColumnEditor
          editor={editor}
          columns={columns}
          onCancel={() => setEditor(null)}
          onPreview={(col, position) => {
            const def = columnDefinition(col);
            const pos = position === '__first' ? ' FIRST' : position ? ` AFTER ${qid(position)}` : '';
            const sql =
              editor.mode === 'add'
                ? `ALTER TABLE ${from} ADD COLUMN ${def}${pos};`
                : `ALTER TABLE ${from} CHANGE COLUMN ${qid(editor.original.name)} ${def}${pos};`;
            setPreview({ title: editor.mode === 'add' ? `Add column ${col.name}` : `Change column ${editor.original.name}`, sql });
          }}
        />
      )}
      {ixEditor && (
        <IndexEditor
          value={ixEditor}
          columns={columns}
          onCancel={() => setIxEditor(null)}
          onPreview={(ix) => {
            const cols = ix.cols.map(qid).join(', ');
            const sql =
              ix.kind === 'PRIMARY KEY'
                ? `ALTER TABLE ${from} ADD PRIMARY KEY (${cols});`
                : `ALTER TABLE ${from} ADD ${ix.kind === 'INDEX' ? 'INDEX' : ix.kind + ' INDEX'} ${ix.name ? qid(ix.name) + ' ' : ''}(${cols});`;
            setPreview({ title: `Add ${ix.kind.toLowerCase()} ${ix.name}`.trim(), sql });
          }}
        />
      )}
      {preview && (
        <div className="modal-backdrop" onMouseDown={() => !busy && setPreview(null)}>
          <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">{preview.title}</div>
            <div className="hint">This statement will run on the server:</div>
            <textarea className="sql-preview" value={preview.sql} spellCheck={false} onChange={(e) => setPreview({ ...preview, sql: e.target.value, error: null })} />
            {preview.error && <div className="status-box error">{preview.error}</div>}
            <div className="modal-actions">
              <button onClick={() => setPreview(null)} disabled={busy}>
                Cancel
              </button>
              <button className={preview.danger ? 'danger' : 'primary'} onClick={apply} disabled={busy}>
                {busy ? 'Running…' : preview.danger ? 'Drop' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
      {menuEl}
    </div>
  );
}

function blankColumn() {
  return { name: '', type: 'varchar(255)', nullable: true, defaultKind: 'null', defaultValue: '', autoIncrement: false, onUpdate: '', comment: '', collation: '' };
}

function ColumnEditor({ editor, columns, onCancel, onPreview }) {
  const [col, setCol] = useState(editor.col);
  const others = columns.filter((c) => !editor.original || c.name !== editor.original.name);
  const currentAfter = editor.original ? columns[columns.findIndex((c) => c.name === editor.original.name) - 1]?.name || '__first' : editor.after || '';
  const [position, setPosition] = useState(currentAfter);
  const set = (k) => (e) => setCol((c) => ({ ...c, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const isTime = /^(datetime|timestamp)/i.test(col.type);
  const valid = col.name.trim() && col.type.trim();

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="modal col-editor"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onPreview({ ...col, name: col.name.trim() }, position === currentAfter && editor.mode === 'edit' ? '' : position);
        }}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      >
        <div className="modal-title">{editor.mode === 'add' ? 'Add Column' : `Edit Column “${editor.original.name}”`}</div>
        <div className="row">
          <label>Name</label>
          <input autoFocus value={col.name} onChange={set('name')} />
        </div>
        <div className="row">
          <label>Type</label>
          <input list="qrt-types" value={col.type} onChange={set('type')} className="mono" />
          <datalist id="qrt-types">
            {COMMON_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        <div className="row">
          <label />
          <label className="check">
            <input type="checkbox" checked={col.nullable} onChange={set('nullable')} /> Allow NULL
          </label>
          <label className="check">
            <input type="checkbox" checked={col.autoIncrement} onChange={set('autoIncrement')} /> Auto increment
          </label>
        </div>
        <div className="row">
          <label>Default</label>
          <select value={col.defaultKind} onChange={set('defaultKind')}>
            <option value="none">No default</option>
            <option value="null" disabled={!col.nullable}>
              NULL
            </option>
            <option value="value">Value</option>
            <option value="expr">Expression</option>
          </select>
          {(col.defaultKind === 'value' || col.defaultKind === 'expr') && (
            <input
              value={col.defaultValue}
              onChange={set('defaultValue')}
              className="mono"
              placeholder={col.defaultKind === 'expr' ? 'CURRENT_TIMESTAMP, uuid() …' : 'literal value'}
            />
          )}
        </div>
        {isTime && (
          <div className="row">
            <label />
            <label className="check">
              <input
                type="checkbox"
                checked={!!col.onUpdate}
                onChange={(e) => setCol((c) => ({ ...c, onUpdate: e.target.checked ? 'CURRENT_TIMESTAMP' : '' }))}
              />{' '}
              ON UPDATE CURRENT_TIMESTAMP
            </label>
          </div>
        )}
        <div className="row">
          <label>Comment</label>
          <input value={col.comment} onChange={set('comment')} />
        </div>
        <div className="row">
          <label>Position</label>
          <select value={position} onChange={(e) => setPosition(e.target.value)}>
            {editor.mode === 'add' && <option value="">At the end</option>}
            <option value="__first">First</option>
            {others.map((c) => (
              <option key={c.name} value={c.name}>
                After {c.name}
              </option>
            ))}
          </select>
        </div>
        <pre className="def-preview">{valid ? columnDefinition(col) : ' '}</pre>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            Review SQL…
          </button>
        </div>
      </form>
    </div>
  );
}

function IndexEditor({ value, columns, onCancel, onPreview }) {
  const [ix, setIx] = useState(value);
  const toggle = (name) => setIx((x) => ({ ...x, cols: x.cols.includes(name) ? x.cols.filter((c) => c !== name) : [...x.cols, name] }));
  const valid = ix.cols.length > 0;
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onPreview(ix);
        }}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      >
        <div className="modal-title">Add Index</div>
        <div className="row">
          <label>Kind</label>
          <select value={ix.kind} onChange={(e) => setIx({ ...ix, kind: e.target.value })}>
            <option>INDEX</option>
            <option>UNIQUE</option>
            <option>FULLTEXT</option>
            <option>PRIMARY KEY</option>
          </select>
        </div>
        {ix.kind !== 'PRIMARY KEY' && (
          <div className="row">
            <label>Name</label>
            <input autoFocus value={ix.name} onChange={(e) => setIx({ ...ix, name: e.target.value })} placeholder={'idx_' + (ix.cols.join('_') || 'name')} />
          </div>
        )}
        <div className="hint">Columns (click in index order):</div>
        <div className="col-picker">
          {columns.map((c) => {
            const n = ix.cols.indexOf(c.name);
            return (
              <label key={c.name} className={'check' + (n >= 0 ? ' on' : '')}>
                <input type="checkbox" checked={n >= 0} onChange={() => toggle(c.name)} />
                {n >= 0 && <span className="order">{n + 1}</span>}
                {c.name} <span className="dim mono">{c.type}</span>
              </label>
            );
          })}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            Review SQL…
          </button>
        </div>
      </form>
    </div>
  );
}

export function InfoView({ db, table, schema, onTable }) {
  const stats = schema?.stats;
  if (!stats) return <div className="placeholder">{schema?.error || 'Loading table statistics…'}</div>;
  const t = table && stats.find((x) => x.name === table);
  if (t) {
    const items = [
      ['Name', t.name],
      ['Type', t.type],
      ['Engine', t.engine],
      ['Rows (approx.)', formatNumber(t.rows)],
      ['Data size', formatBytes(t.dataLength)],
      ['Index size', formatBytes(t.indexLength)],
      ['Auto increment', t.autoIncrement ?? '—'],
      ['Collation', t.collation],
      ['Created', t.created],
      ['Updated', t.updated || '—'],
      ['Comment', t.comment || '—'],
    ];
    return (
      <div className="info-view">
        <dl className="info-list">
          {items.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v === null || v === undefined ? '—' : String(v)}</dd>
            </React.Fragment>
          ))}
        </dl>
      </div>
    );
  }
  const totalData = stats.reduce((a, x) => a + Number(x.dataLength || 0), 0);
  const totalIdx = stats.reduce((a, x) => a + Number(x.indexLength || 0), 0);
  return (
    <div className="info-view">
      <div className="db-summary">
        <strong>{db}</strong> · {stats.length} tables · data {formatBytes(totalData)} · indexes {formatBytes(totalIdx)}
      </div>
      <table className="simple-table">
        <thead>
          <tr>
            <th>Table</th>
            <th>Engine</th>
            <th className="num">Rows</th>
            <th className="num">Data</th>
            <th className="num">Index</th>
            <th>Collation</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((x) => (
            <tr key={x.name} className="clickable" onClick={() => onTable(x.name)}>
              <td className="strong">{x.name}</td>
              <td>{x.type === 'VIEW' ? 'VIEW' : x.engine}</td>
              <td className="num">{formatNumber(x.rows)}</td>
              <td className="num">{formatBytes(x.dataLength)}</td>
              <td className="num">{formatBytes(x.indexLength)}</td>
              <td className="dim">{x.collation}</td>
              <td className="dim">{x.comment}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
