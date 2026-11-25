import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Editor from './Editor';
import Grid from './Grid';
import { useContextMenu } from './ContextMenu';
import { splitSql, isDangerous } from './sqlSplit';
import { api, toCsv, toTsv, toInsert, toJson, formatMs, formatNumber, loadLocal, saveLocal } from './util';

// MySQL errors that mean "this change is already in the database" — safe to skip when re-running a migration.
export const ALREADY_APPLIED = {
  1050: 'table already exists',
  1060: 'column already exists',
  1061: 'index already exists',
  1068: 'primary key already defined',
  1091: 'nothing to drop — already removed',
  1826: 'foreign key already exists',
};

const ON_ERROR = [
  ['skip-existing', 'Skip “already exists”, stop on other errors'],
  ['stop', 'Stop at the first error'],
  ['continue', 'Continue after every error'],
];

function stripLeadingComments(sql) {
  return sql.replace(/^(\s|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/, '');
}

// Statements that change data or schema (used for the pre-run confirmation).
export function isWrite(sql) {
  const s = stripLeadingComments(sql).toUpperCase();
  if (/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|HELP|USE|SET|START\s+TRANSACTION|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/.test(s)) return false;
  if (/^WITH\b/.test(s)) return /\b(UPDATE|DELETE|INSERT)\b/.test(s);
  return true;
}

const lineOf = (text, offset) => (offset === undefined ? null : text.slice(0, offset).split('\n').length);

// The Query view of one workspace tab. Runs on the tab's own server connection.
export default function QueryView({ tab, conn, schema, visible, onUpdate, onStatus, onSchemaChange, registerCommands }) {
  const [results, setResults] = useState(null); // { items, active, script, summary }
  const [running, setRunning] = useState(null); // { started, index, total }
  const [elapsed, setElapsed] = useState(0);
  const [split, setSplit] = useState(() => loadLocal('querySplit', 0.45));
  const [showHistory, setShowHistory] = useState(false);
  const [onError, setOnError] = useState(() => loadLocal('onError', 'skip-existing'));
  const [txOpen, setTxOpen] = useState(false);
  const editorRef = useRef(null);
  const bodyRef = useRef(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const runningRef = useRef(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => setElapsed(Date.now() - running.started), 100);
    return () => clearInterval(h);
  }, [running]);

  const refreshTx = useCallback(() => api.txState(tabRef.current.id).then(setTxOpen).catch(() => {}), []);

  // Run statements one by one, recording an outcome for every statement (including the ones not reached).
  const run = useCallback(
    async (stmts) => {
      if (runningRef.current) return;
      stmts = stmts.filter((s) => s && s.text && s.text.trim());
      if (!stmts.length) return;
      const db = tabRef.current.db;
      const policy = stmts.length > 1 ? onError : 'stop';
      const writes = stmts.filter((s) => isWrite(s.text)).length;
      const danger = stmts.filter((s) => isDangerous(s.text));
      if (danger.length || (stmts.length > 1 && writes > 0)) {
        const target = `${conn.name || conn.host} (${conn.user}@${conn.host}${conn.useSsh ? ' via SSH ' + conn.sshHost : ''})`;
        const ok = await api.confirm({
          message: danger.length ? 'Run potentially destructive statement?' : `Run ${stmts.length} statements on “${db || 'no database'}”?`,
          detail: [
            `Connection: ${target}`,
            `Database: ${db || '(none selected — DATABASE() will be NULL)'}`,
            `${writes} of ${stmts.length} statement(s) change data or schema.`,
            stmts.length > 1 ? `On error: ${ON_ERROR.find((o) => o[0] === policy)[1]}` : null,
            danger.length ? '\nDestructive:\n' + danger.map((s) => s.text.slice(0, 300)).join('\n\n') : null,
          ]
            .filter(Boolean)
            .join('\n'),
          okLabel: 'Run',
        });
        if (!ok) return;
      }
      runningRef.current = true;
      cancelRef.current = false;
      editorRef.current?.markError(null);
      const started = Date.now();
      setElapsed(0);
      let items = stmts.map((s, i) => ({ n: (s.n || i + 1), line: s.line ?? null, from: s.from, to: s.to, sql: s.text, status: 'pending' }));
      const script = stmts.length > 1;
      const publish = (active) => setResults((r) => ({ items, script, active: active ?? (r && r.items === items ? r.active : 'report') }));
      publish('report');
      let currentDb = db;
      const changedDbs = new Set();
      let stopped = false;
      for (let i = 0; i < stmts.length; i++) {
        if (stopped || cancelRef.current) {
          items[i] = { ...items[i], status: cancelRef.current && !stopped ? 'cancelled' : 'notrun' };
          continue;
        }
        setRunning({ started, index: i, total: stmts.length });
        const s = stmts[i];
        let item = items[i];
        try {
          const r = await api.query(tabRef.current.id, s.text, currentDb);
          item = { ...item, ...r, status: 'ok' };
          if (r.kind === 'ok' && /^CREATE\s+(TABLE|DATABASE|SCHEMA|INDEX)\s+IF\s+NOT\s+EXISTS/i.test(stripLeadingComments(s.text)) && (r.warnings || []).some((w) => w.code === 1050 || w.code === 1007)) {
            item = { ...item, status: 'skipped', note: 'already existed (IF NOT EXISTS — nothing created)' };
          }
          api.addHistory({ connectionId: conn.id || conn.host, sql: s.text, db: currentDb, ts: Date.now(), ms: r.ms, rows: r.kind === 'rows' ? r.total : r.affectedRows }).catch(() => {});
          const use = /^\s*use\s+`?([^`;\s]+)`?/i.exec(s.text);
          if (use) {
            currentDb = use[1];
            onUpdate({ db: currentDb });
          }
          if (/^\s*(create|alter|drop|rename|truncate)\b/i.test(stripLeadingComments(s.text))) changedDbs.add(currentDb);
        } catch (e) {
          const already = ALREADY_APPLIED[e.errno];
          const txLost = /transaction was open/i.test(e.message);
          if (already && policy !== 'stop' && !txLost) {
            item = { ...item, status: 'skipped', note: `${already} (MySQL ${e.errno})`, error: e.message, errno: e.errno };
          } else {
            item = { ...item, status: 'error', error: e.message, errno: e.errno };
            if (s.from !== undefined && !s.selection) editorRef.current?.markError({ from: s.from, to: s.to });
            if (policy !== 'continue' || txLost) stopped = true;
          }
        }
        items = items.map((x, j) => (j === i ? item : x));
        publish();
      }
      // Mark anything still pending (loop ended early).
      items = items.map((x) => (x.status === 'pending' ? { ...x, status: cancelRef.current ? 'cancelled' : 'notrun' } : x));
      runningRef.current = false;
      setRunning(null);

      const count = (st) => items.filter((x) => x.status === st).length;
      const ok = count('ok'), skipped = count('skipped'), failed = count('error'), notrun = count('notrun') + count('cancelled');
      const withWarnings = items.filter((x) => x.status === 'ok' && x.warnings && x.warnings.length).length;
      const firstRows = items.findIndex((x) => x.kind === 'rows');
      let active = 'report';
      if (!script && failed === 0 && firstRows >= 0) active = firstRows;
      if (script && failed === 0 && skipped === 0 && notrun === 0 && writes === 0 && firstRows >= 0) active = firstRows;
      publish(active);

      const totalMs = items.reduce((a, x) => a + (x.ms || 0), 0);
      const last = items.filter((x) => x.status !== 'notrun' && x.status !== 'cancelled').pop();
      if (script) {
        const parts = [`${ok} ok`, skipped && `${skipped} skipped`, withWarnings && `${withWarnings} with warnings`, failed && `${failed} failed`, notrun && `${notrun} not run`].filter(Boolean);
        onStatus({ text: `Script: ${parts.join(' · ')} · ${formatMs(Date.now() - started)}`, error: failed > 0, sql: failed ? items.find((x) => x.status === 'error').sql : undefined });
      } else if (last.status === 'error') onStatus({ text: last.error, error: true, sql: last.sql });
      else if (last.kind === 'rows') onStatus({ text: `${formatNumber(last.total)} rows · ${formatMs(totalMs)}`, sql: last.sql });
      else onStatus({ text: `${formatNumber(last.affectedRows)} affected · ${formatMs(totalMs)}${last.warnings?.length ? ` · ${last.warnings.length} warning(s)` : ''}`, sql: last.sql });
      for (const d of changedDbs) onSchemaChange(d);
      refreshTx();
    },
    [onError, conn, onStatus, onUpdate, onSchemaChange, refreshTx]
  );

  const withLines = (text, list) => list.map((s, i) => ({ ...s, n: i + 1, line: lineOf(text, s.from) }));

  const runCurrent = (cur) => {
    cur = cur || editorRef.current?.current();
    if (!cur) return;
    const text = editorRef.current?.getValue() || '';
    // A selection can contain several statements.
    const stmts = cur.selection
      ? splitSql(cur.text).map((s, i) => ({ ...s, n: i + 1, line: lineOf(text, cur.from) + lineOf(cur.text, s.from) - 1, from: cur.from + s.from, to: cur.from + s.to }))
      : [{ ...cur, n: 1, line: lineOf(text, cur.from) }];
    run(stmts);
  };
  const runAll = (text) => {
    text = text ?? editorRef.current?.getValue() ?? '';
    run(withLines(text, splitSql(text)));
  };
  // Re-run from a statement (e.g. after fixing the one that failed): everything from that offset to the end.
  const runFrom = (offset) => {
    const text = editorRef.current?.getValue() ?? '';
    const all = withLines(text, splitSql(text));
    run(all.filter((s) => s.to > offset));
  };
  const cancel = () => {
    cancelRef.current = true;
    api.cancel(tab.id).catch(() => {});
  };
  const endTx = async (sql) => {
    try {
      await api.query(tab.id, sql, tab.db);
      onStatus({ text: sql === 'COMMIT' ? 'Transaction committed' : 'Transaction rolled back', sql });
    } catch (e) {
      onStatus({ text: e.message, error: true, sql });
    }
    refreshTx();
  };

  // Menu commands routed here by the workspace when this tab is active.
  useEffect(() => {
    registerCommands((cmd) => {
      switch (cmd) {
        case 'runCurrent':
          return runCurrent();
        case 'runAll':
          return runAll();
        case 'cancel':
          return cancel();
        case 'history':
          return setShowHistory(true);
        case 'saveSql':
          return api
            .saveText({
              defaultName: (tab.title || 'query').replace(/\.sql$/, '') + '.sql',
              content: editorRef.current?.getValue() || '',
              filters: [{ name: 'SQL', extensions: ['sql'] }],
            })
            .then((p) => p && onUpdate({ title: p.split('/').pop() }));
        default:
      }
    });
  });

  // Tabs opened with "run" (e.g. Show CREATE from the sidebar).
  useEffect(() => {
    if (tab.autorun) {
      onUpdate({ autorun: false });
      setTimeout(() => run(withLines(tab.sql, splitSql(tab.sql))), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (visible) {
      setTimeout(() => editorRef.current?.focus(), 0);
      refreshTx();
    }
  }, [visible, refreshTx]);

  const startSplitDrag = (e) => {
    e.preventDefault();
    const rect = bodyRef.current.getBoundingClientRect();
    const move = (ev) => setSplit(Math.max(0.12, Math.min(0.88, (ev.clientY - rect.top) / rect.height)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('row-resizing');
      setSplit((v) => (saveLocal('querySplit', v), v));
    };
    document.body.classList.add('row-resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="query-view">
      <div className="toolbar">
        <button className="primary" onClick={() => runCurrent()} disabled={!!running} title="Run current statement or selection (⌘↩)">
          ▶ Run
        </button>
        <button onClick={() => runAll()} disabled={!!running} title="Run all statements (⇧⌘↩)">
          Run All
        </button>
        <select
          className="on-error"
          value={onError}
          disabled={!!running}
          title="What Run All does when a statement fails"
          onChange={(e) => {
            setOnError(e.target.value);
            saveLocal('onError', e.target.value);
          }}
        >
          {ON_ERROR.map(([v, l]) => (
            <option key={v} value={v}>
              On error: {l}
            </option>
          ))}
        </select>
        {running && (
          <button className="danger" onClick={cancel} title="Cancel (⌘.)">
            ■ Stop
          </button>
        )}
        {running && (
          <span className="running-time">
            {running.total > 1 ? `${running.index + 1}/${running.total} · ` : ''}
            {formatMs(elapsed)}
          </span>
        )}
        <span className="spacer" />
        {txOpen && (
          <span className="tx-pill" title="A transaction is open on this tab's connection">
            ● Transaction open
          </span>
        )}
        <span className="db-pill" title="Statements in this tab run against this database">
          {tab.db || 'no database'}
        </span>
        <button onClick={() => setShowHistory(true)} title="History (⌘Y)">
          History
        </button>
        <button className="icon-text" onClick={() => window.dispatchEvent(new Event('qrt-open-settings'))} title="Editor theme & font (⌘,)">
          🎨
        </button>
      </div>
      {txOpen && !running && (
        <div className="tx-banner">
          <span>
            <strong>Transaction is still open on this tab.</strong> Changes since START TRANSACTION are not saved until you COMMIT — closing the tab or losing the
            connection rolls them back.
          </span>
          <span className="spacer" />
          <button className="primary" onClick={() => endTx('COMMIT')}>
            Commit
          </button>
          <button onClick={() => endTx('ROLLBACK')}>Rollback</button>
        </div>
      )}
      <div className="query-body" ref={bodyRef}>
        <div className="editor-pane" style={{ height: `${split * 100}%` }}>
          <Editor
            value={tab.sql}
            onChange={(v) => onUpdate({ sql: v })}
            schema={schema}
            onRun={(cur) => runCurrent(cur)}
            onRunAll={(text) => runAll(text)}
            editorRef={editorRef}
          />
        </div>
        <div className="hsplit" onMouseDown={startSplitDrag} />
        <div className="results-pane">
          {results ? (
            <Results
              res={results}
              tab={tab}
              running={!!running}
              onActive={(a) => setResults((r) => ({ ...r, active: a }))}
              onStatus={onStatus}
              onJump={(it) => it.from !== undefined && editorRef.current?.select(it.from, it.to)}
              onRunFrom={(it) => runFrom(it.from)}
            />
          ) : (
            <div className="placeholder">
              <div>
                <kbd>⌘</kbd> <kbd>↩</kbd> run statement at cursor · <kbd>⇧</kbd> <kbd>⌘</kbd> <kbd>↩</kbd> run all · <kbd>⌘</kbd> <kbd>.</kbd> cancel ·{' '}
                <kbd>⌘</kbd> <kbd>T</kbd> new tab
              </div>
            </div>
          )}
          {running && running.total === 1 && <div className="loading-overlay">Running… {formatMs(elapsed)}</div>}
        </div>
      </div>
      {showHistory && (
        <HistoryModal
          conn={conn}
          onClose={() => setShowHistory(false)}
          onPick={(sql) => {
            setShowHistory(false);
            setTimeout(() => editorRef.current?.insert(sql), 0);
          }}
        />
      )}
    </div>
  );
}

function Results({ res, tab, running, onActive, onStatus, onJump, onRunFrom }) {
  const rowsResults = res.items.map((x, i) => [x, i]).filter(([x]) => x.kind === 'rows' && x.status === 'ok');
  const active = res.active;
  const current = typeof active === 'number' ? res.items[active] : null;
  const failed = res.items.some((x) => x.status === 'error');
  return (
    <div className="results">
      <div className="rtabs">
        {rowsResults.map(([x, i], n) => (
          <button key={i} className={active === i ? 'on' : ''} onClick={() => onActive(i)}>
            Result {rowsResults.length > 1 ? n + 1 : ''} <span className="dim">({formatNumber(x.total)})</span>
          </button>
        ))}
        <button className={active === 'report' ? 'on' : ''} onClick={() => onActive('report')}>
          {res.script ? 'Script Report' : 'Messages'} {failed && <span className="err-dot" />}
        </button>
      </div>
      {current ? (
        <ResultGrid key={active + ':' + res.items.length + ':' + current.ms} result={current} tab={tab} onStatus={onStatus} />
      ) : (
        <ScriptReport items={res.items} running={running} onJump={onJump} onRunFrom={onRunFrom} />
      )}
    </div>
  );
}

const STATUS = {
  ok: ['✓', 'ok', 'Ran'],
  skipped: ['↷', 'skipped', 'Skipped'],
  error: ['✕', 'error', 'Failed'],
  notrun: ['○', 'notrun', 'Not run'],
  cancelled: ['○', 'notrun', 'Cancelled'],
  pending: ['…', 'pending', 'Waiting'],
};

function outcome(x) {
  if (x.status === 'error') return x.error;
  if (x.status === 'skipped') return x.note;
  if (x.status === 'notrun') return 'not run — the script stopped before this statement';
  if (x.status === 'cancelled') return 'cancelled';
  if (x.status === 'pending') return '';
  if (x.kind === 'rows') return `${formatNumber(x.total)} row(s)${x.truncated ? ' (first 50,000 shown)' : ''}`;
  return `${formatNumber(x.affectedRows)} affected${x.info ? ' · ' + x.info.trim() : ''}`;
}

function ScriptReport({ items, running, onJump, onRunFrom }) {
  const [open, setOpen] = useState(() => new Set());
  const count = (st) => items.filter((x) => x.status === st).length;
  const warnCount = items.filter((x) => x.status === 'ok' && x.warnings && x.warnings.length).length;
  const firstFailed = items.find((x) => x.status === 'error');
  const firstNotRun = items.find((x) => x.status === 'notrun' || x.status === 'cancelled');
  const resumeAt = firstFailed || firstNotRun;
  const toggle = (n) => setOpen((s) => { const t = new Set(s); t.has(n) ? t.delete(n) : t.add(n); return t; });

  const copyReport = () => {
    const lines = items.map((x) => `${STATUS[x.status][0]} #${x.n}${x.line ? ' L' + x.line : ''}  ${x.sql.replace(/\s+/g, ' ').slice(0, 100)}\n     ${outcome(x) || ''}${(x.warnings || []).map((w) => `\n     ${w.level} ${w.code}: ${w.message}`).join('')}`);
    api.copy(`ok ${count('ok')} · skipped ${count('skipped')} · failed ${count('error')} · not run ${count('notrun') + count('cancelled')}\n\n` + lines.join('\n'));
  };

  return (
    <div className="script-report">
      <div className="report-summary">
        <span className="chip ok">✓ {count('ok')} ran</span>
        {count('skipped') > 0 && <span className="chip skipped">↷ {count('skipped')} already applied</span>}
        {warnCount > 0 && <span className="chip warn">⚠ {warnCount} with warnings</span>}
        {count('error') > 0 && <span className="chip error">✕ {count('error')} failed</span>}
        {count('notrun') + count('cancelled') > 0 && <span className="chip notrun">○ {count('notrun') + count('cancelled')} not run</span>}
        {running && <span className="chip pending">running…</span>}
        <span className="spacer" />
        {!running && resumeAt && resumeAt.from !== undefined && (
          <button className="primary" onClick={() => onRunFrom(resumeAt)} title="Fix the statement in the editor first, then run from it to the end">
            ▶ Run from #{resumeAt.n} to end
          </button>
        )}
        <button onClick={copyReport}>Copy Report</button>
      </div>
      <div className="report-rows">
        {items.map((x) => {
          const [icon, cls, label] = STATUS[x.status];
          const hasDetail = (x.warnings && x.warnings.length) || x.status === 'error' || x.status === 'skipped';
          return (
            <div key={x.n} className={'report-row ' + cls}>
              <div className="report-main" onClick={() => onJump(x)} title="Click to select this statement in the editor">
                <span className="r-icon" title={label}>{icon}</span>
                <span className="r-n">#{x.n}</span>
                <span className="r-line">{x.line ? 'L' + x.line : ''}</span>
                <span className="r-sql">{x.sql.replace(/\s+/g, ' ').slice(0, 160)}</span>
                <span className="r-out">
                  {outcome(x)}
                  {x.warnings && x.warnings.length > 0 && x.status === 'ok' && <span className="warn-badge"> ⚠ {x.warnings.length}</span>}
                </span>
                <span className="r-ms">{x.ms !== undefined ? formatMs(x.ms) : ''}</span>
                {hasDetail ? (
                  <button className="r-more" onClick={(e) => { e.stopPropagation(); toggle(x.n); }}>
                    {open.has(x.n) ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="r-more" />
                )}
              </div>
              {open.has(x.n) && (
                <div className="report-detail">
                  {x.error && <div className="d-error">{x.errno ? `MySQL ${x.errno}: ` : ''}{x.error}</div>}
                  {(x.warnings || []).map((w, i) => (
                    <div key={i} className="d-warn">{w.level} {w.code}: {w.message}</div>
                  ))}
                  <pre className="d-sql">{x.sql}</pre>
                  {x.status === 'error' && x.from !== undefined && !running && (
                    <button onClick={() => onRunFrom(x)}>▶ Run from here to end</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Results from a single table that include its primary key are editable.
function ResultGrid({ result, tab, onStatus }) {
  const [rows, setRows] = useState(result.rows);
  const [selected, setSelected] = useState(new Set());
  const [sort, setSort] = useState(null);
  const [edit, setEdit] = useState(null); // { db, table, pk: [orgName], index: {orgName: colIdx} }
  const [openMenu, menuEl] = useContextMenu();

  const source = useMemo(() => {
    const tables = new Set(result.columns.map((c) => (c.db || tab.db) + '\u0001' + c.table));
    if (tables.size !== 1 || result.columns.some((c) => !c.table)) return null;
    const c0 = result.columns[0];
    return { db: c0.db || tab.db, table: c0.table };
  }, [result, tab.db]);

  useEffect(() => {
    setEdit(null);
    if (!source) return;
    let alive = true;
    // Primary key from information_schema (one small query, only for single-table results).
    api
      .query(
        tab.id,
        `SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '${source.db.replace(/'/g, "''")}' AND TABLE_NAME = '${source.table.replace(/'/g, "''")}' AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`,
        null
      )
      .then((r) => {
        if (!alive || r.kind !== 'rows' || !r.rows.length) return;
        const pk = r.rows.map((x) => x[0]);
        const index = {};
        result.columns.forEach((c, i) => {
          if (!(c.orgName in index)) index[c.orgName] = i;
        });
        if (pk.every((p) => p in index)) setEdit({ ...source, pk, index });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [source, result, tab.id]);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const i = result.columns.findIndex((c) => c.name === sort.col);
    const dir = sort.dir === 'DESC' ? -1 : 1;
    const num = (v) => (v !== null && v !== '' && !isNaN(v) ? Number(v) : null);
    return [...rows].sort((a, b) => {
      const x = a[i];
      const y = b[i];
      if (x === null) return y === null ? 0 : -dir;
      if (y === null) return dir;
      const nx = num(x);
      const ny = num(y);
      if (nx !== null && ny !== null) return (nx - ny) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }, [rows, sort, result.columns]);

  const commit = async (r, c, value) => {
    const row = sortedRows[r];
    const key = Object.fromEntries(edit.pk.map((p) => [p, row[edit.index[p]]]));
    try {
      const res = await api.updateRow(tab.id, { db: edit.db, table: edit.table, key, changes: { [result.columns[c].orgName]: value } });
      onStatus({ text: res.affectedRows ? 'Row updated' : 'No row was updated', sql: res.sql, error: !res.affectedRows });
      setRows((rs) => rs.map((x) => (x === row ? x.map((v, j) => (j === c ? value : v)) : x)));
    } catch (e) {
      onStatus({ text: e.message, error: true });
      window.dispatchEvent(new CustomEvent('qrt-error', { detail: e.message }));
    }
  };

  const onCtx = (e, r, c) => {
    const idx = selected.has(r) ? [...selected].sort((a, b) => a - b) : [r];
    const sel = idx.map((i) => sortedRows[i]);
    const v = c >= 0 ? sortedRows[r][c] : undefined;
    openMenu(
      e,
      [
        c >= 0 && { label: 'Copy Value', onClick: () => api.copy(v === null ? 'NULL' : String(v)) },
        { label: `Copy ${sel.length > 1 ? sel.length + ' Rows' : 'Row'}`, shortcut: '⌘C', onClick: () => api.copy(toTsv(result.columns, sel)) },
        { label: 'Copy with Header', shortcut: '⇧⌘C', onClick: () => api.copy(toTsv(result.columns, sel, true)) },
        { label: 'Copy as INSERT', onClick: () => api.copy(toInsert(source?.table, result.columns, sel)) },
        { label: 'Copy as JSON', onClick: () => api.copy(toJson(result.columns, sel)) },
        edit && c >= 0 && '-',
        edit && c >= 0 && { label: 'Set NULL', onClick: () => commit(r, c, null) },
      ].filter(Boolean)
    );
  };

  const exportAs = async (ext) => {
    const content = ext === 'json' ? toJson(result.columns, rows) : toCsv(result.columns, rows);
    const p = await api.saveText({ defaultName: `${source?.table || 'result'}.${ext}`, content, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (p) onStatus({ text: `Exported ${rows.length} rows to ${p}` });
  };

  return (
    <div className="result-grid">
      <div className="result-bar">
        <span className="dim">
          {formatNumber(result.total)} rows{result.truncated ? ' (first 50,000 shown)' : ''} · {formatMs(result.ms)}
          {edit ? ` · editable (${edit.table})` : ''}
        </span>
        <span className="spacer" />
        <button onClick={() => api.copy(toTsv(result.columns, rows, true))}>Copy All</button>
        <button onClick={() => exportAs('csv')}>Export CSV</button>
        <button onClick={() => exportAs('json')}>JSON</button>
      </div>
      <div className="grid-wrap">
        <Grid
          columns={result.columns}
          rows={sortedRows}
          editable={!!edit}
          onCommitEdit={commit}
          onContextMenu={onCtx}
          selected={selected}
          onSelect={setSelected}
          sort={sort}
          onSort={(col) => setSort((s) => (s && s.col === col ? (s.dir === 'ASC' ? { col, dir: 'DESC' } : null) : { col, dir: 'ASC' }))}
          emptyText="Query returned no rows"
        />
      </div>
      {menuEl}
    </div>
  );
}

function HistoryModal({ conn, onClose, onPick }) {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [settings, setSettings] = useState(null);
  const cid = conn.id || conn.host;
  useEffect(() => {
    api.history(cid).then(setItems);
    api.getSettings().then(setSettings);
  }, [cid]);
  const updateSettings = async (patch) => {
    if (patch.historyEnabled === false && items.length) {
      const ok = await api.confirm({ message: 'Turn off query history?', detail: 'Existing history for all connections will be deleted.', okLabel: 'Turn Off' });
      if (!ok) return;
    }
    setSettings(await api.setSettings(patch));
    setItems(await api.history(cid));
  };
  const shown = items.filter((h) => !q || h.sql.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide history" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          Query History
          <span className="spacer" />
          <button
            className="danger-link"
            onClick={async () => {
              if (await api.confirm({ message: 'Clear history for this connection?', okLabel: 'Clear' })) {
                await api.clearHistory(cid);
                setItems([]);
              }
            }}
          >
            Clear
          </button>
        </div>
        <input
          className="search"
          autoFocus
          placeholder="Search history"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') setSel((s) => Math.min(shown.length - 1, s + 1));
            if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
            if (e.key === 'Enter' && shown[sel]) onPick(shown[sel].sql);
          }}
        />
        <div className="history-list">
          {shown.map((h, i) => (
            <div key={i} className={'history-item' + (i === sel ? ' sel' : '')} onClick={() => setSel(i)} onDoubleClick={() => onPick(h.sql)}>
              <pre>{h.sql.length > 600 ? h.sql.slice(0, 600) + '…' : h.sql}</pre>
              <div className="dim small">
                {new Date(h.ts).toLocaleString()} · {h.db || '—'} · {h.rows ?? 0} rows · {formatMs(h.ms || 0)}
              </div>
            </div>
          ))}
          {!shown.length && <div className="empty-note">No history</div>}
        </div>
        {settings && (
          <div className="history-settings">
            <label className="check">
              <input type="checkbox" checked={settings.historyEnabled} onChange={(e) => updateSettings({ historyEnabled: e.target.checked })} /> Save query history
            </label>
            <label className="check">
              Keep for
              <select value={settings.historyRetentionDays} disabled={!settings.historyEnabled} onChange={(e) => updateSettings({ historyRetentionDays: Number(e.target.value) })}>
                <option value={1}>1 day</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>1 year</option>
                <option value={0}>Forever</option>
              </select>
            </label>
            <span className="hint">Stored encrypted (Keychain). Passwords written in statements are masked.</span>
          </div>
        )}
        <div className="modal-actions">
          <span className="hint">↩ insert at cursor</span>
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={!shown[sel]} onClick={() => onPick(shown[sel].sql)}>
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
