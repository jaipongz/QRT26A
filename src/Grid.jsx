import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api, toTsv } from './util';

const ROW_H = 24;
const HEADER_H = 26;
const RN_W = 52;
const OVERSCAN = 12;

function initialWidths(columns, rows) {
  const sample = rows.slice(0, 200);
  return columns.map((c, i) => {
    let len = String(c.name).length + 2;
    for (const r of sample) {
      const v = r[i];
      const l = v === null || v === undefined ? 4 : Math.min(String(v).length, 60);
      if (l > len) len = l;
    }
    return Math.max(64, Math.min(420, len * 7.4 + 18));
  });
}

function display(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > 300 ? s.slice(0, 300) + '…' : s.replace(/\r?\n/g, '↵ ');
}

export default function Grid({
  columns,
  rows,
  editable = false,
  rowOffset = 0,
  sort,
  onSort,
  onCommitEdit,
  onDeleteRows,
  onContextMenu,
  rowClass,
  selected,
  onSelect,
  emptyText = 'No rows',
}) {
  const scrollRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [widths, setWidths] = useState(() => initialWidths(columns, rows));
  const [active, setActive] = useState(null); // { r, c }
  const [editing, setEditingState] = useState(null); // { r, c, value, long }
  const editingRef = useRef(null);
  const setEditing = (v) => {
    editingRef.current = v;
    setEditingState(v);
  };
  const anchorRef = useRef(null);
  const colsKey = columns.map((c) => c.name).join('\u0001');

  useEffect(() => {
    setWidths(initialWidths(columns, rows));
    setActive(null);
    setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colsKey]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const offsets = useMemo(() => {
    const o = [0];
    for (const w of widths) o.push(o[o.length - 1] + w);
    return o;
  }, [widths]);
  const totalW = RN_W + offsets[offsets.length - 1];

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  const sel = selected || new Set();
  const setSel = (s) => onSelect && onSelect(s);

  const scrollIntoView = useCallback(
    (r, c) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = r * ROW_H;
      const bodyH = el.clientHeight - HEADER_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + bodyH) el.scrollTop = top + ROW_H - bodyH;
      if (c !== undefined && c >= 0) {
        const left = offsets[c];
        const right = offsets[c + 1];
        const viewW = el.clientWidth - RN_W;
        if (left < el.scrollLeft) el.scrollLeft = left;
        else if (right > el.scrollLeft + viewW) el.scrollLeft = right - viewW;
      }
    },
    [offsets]
  );

  const clickCell = (e, r, c) => {
    scrollRef.current.focus({ preventScroll: true });
    setActive({ r, c });
    if (e.shiftKey && anchorRef.current !== null) {
      const a = anchorRef.current;
      const s = new Set(e.metaKey || e.ctrlKey ? sel : []);
      for (let i = Math.min(a, r); i <= Math.max(a, r); i++) s.add(i);
      setSel(s);
    } else if (e.metaKey || e.ctrlKey) {
      const s = new Set(sel);
      s.has(r) ? s.delete(r) : s.add(r);
      setSel(s);
      anchorRef.current = r;
    } else {
      setSel(new Set([r]));
      anchorRef.current = r;
    }
  };

  const startEdit = (r, c) => {
    if (!editable || c < 0) return;
    const v = rows[r][c];
    const s = v === null || v === undefined ? '' : String(v);
    setEditing({ r, c, value: s, wasNull: v === null, long: s.length > 120 || s.includes('\n') });
  };

  const commitEdit = async (value) => {
    const ed = editingRef.current;
    setEditing(null);
    scrollRef.current?.focus({ preventScroll: true });
    if (!ed) return;
    const orig = rows[ed.r][ed.c];
    if (value === orig || (value === '' && orig === null && ed.wasNull)) return;
    if (onCommitEdit) await onCommitEdit(ed.r, ed.c, value);
  };

  const copySelection = (withHeader) => {
    const idx = [...sel].sort((a, b) => a - b);
    if (idx.length > 1 || (idx.length === 1 && (!active || withHeader))) {
      api.copy(toTsv(columns, idx.map((i) => rows[i]), withHeader));
    } else if (active && active.c >= 0) {
      const v = rows[active.r]?.[active.c];
      api.copy(v === null || v === undefined ? 'NULL' : String(v));
    }
  };

  const onKeyDown = (e) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'c') {
      e.preventDefault();
      copySelection(e.shiftKey);
      return;
    }
    if (mod && e.key === 'a') {
      e.preventDefault();
      setSel(new Set(rows.map((_, i) => i)));
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && editable && sel.size && onDeleteRows) {
      e.preventDefault();
      onDeleteRows([...sel].sort((a, b) => a - b));
      return;
    }
    if (!rows.length) return;
    let { r, c } = active || { r: 0, c: 0 };
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1] };
    if (moves[e.key]) {
      e.preventDefault();
      if (!active) {
        r = 0;
        c = 0;
      } else {
        const page = mod ? 1e9 : 1;
        r = Math.max(0, Math.min(rows.length - 1, r + moves[e.key][0] * page));
        c = Math.max(0, Math.min(columns.length - 1, c + moves[e.key][1] * (mod ? 1e9 : 1)));
      }
      setActive({ r, c });
      if (e.shiftKey && e.key !== 'Tab' && anchorRef.current !== null) {
        const s = new Set();
        for (let i = Math.min(anchorRef.current, r); i <= Math.max(anchorRef.current, r); i++) s.add(i);
        setSel(s);
      } else {
        setSel(new Set([r]));
        anchorRef.current = r;
      }
      scrollIntoView(r, c);
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const step = Math.floor((viewH - HEADER_H) / ROW_H) * (e.key === 'PageDown' ? 1 : -1);
      r = Math.max(0, Math.min(rows.length - 1, r + step));
      setActive({ r, c });
      setSel(new Set([r]));
      anchorRef.current = r;
      scrollIntoView(r);
      return;
    }
    if (e.key === 'Enter' && active && editable) {
      e.preventDefault();
      startEdit(active.r, active.c);
    }
  };

  const startResize = (e, i) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[i];
    const move = (ev) => {
      const w = Math.max(40, startW + ev.clientX - startX);
      setWidths((ws) => ws.map((x, j) => (j === i ? w : x)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
    };
    document.body.classList.add('col-resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const autoFit = (i) => {
    let len = String(columns[i].name).length + 2;
    for (const r of rows.slice(0, 2000)) {
      const v = r[i];
      const l = v === null || v === undefined ? 4 : Math.min(String(v).length, 200);
      if (l > len) len = l;
    }
    setWidths((ws) => ws.map((x, j) => (j === i ? Math.max(48, len * 7.4 + 18) : x)));
  };

  const visible = [];
  for (let r = first; r < last; r++) {
    const row = rows[r];
    const cls = ['g-row', r % 2 ? 'odd' : '', sel.has(r) ? 'sel' : '', rowClass ? rowClass(r) : ''].join(' ');
    visible.push(
      <div key={r} className={cls} style={{ top: HEADER_H + r * ROW_H, width: totalW }}>
        <div className="g-rn" onMouseDown={(e) => clickCell(e, r, -1)} onContextMenu={(e) => onContextMenu && onContextMenu(e, r, -1)}>
          {rowOffset + r + 1}
        </div>
        {columns.map((col, c) => {
          const v = row[c];
          const d = display(v);
          const isActive = active && active.r === r && active.c === c;
          return (
            <div
              key={c}
              className={'g-cell' + (d === null ? ' null' : '') + (isActive ? ' active' : '')}
              style={{ left: RN_W + offsets[c], width: widths[c] }}
              onMouseDown={(e) => {
                if (e.button === 0) clickCell(e, r, c);
              }}
              onDoubleClick={() => startEdit(r, c)}
              onContextMenu={(e) => {
                if (!sel.has(r)) {
                  setSel(new Set([r]));
                  anchorRef.current = r;
                }
                setActive({ r, c });
                onContextMenu && onContextMenu(e, r, c);
              }}
              title={d !== null && String(v).length > 40 ? String(v).slice(0, 2000) : undefined}
            >
              {d === null ? 'NULL' : d}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div className="g-inner" style={{ width: totalW, height: HEADER_H + rows.length * ROW_H }}>
        <div className="g-header" style={{ width: totalW }}>
          <div className="g-rn g-hcell" />
          {columns.map((col, c) => (
            <div
              key={c}
              className={'g-hcell' + (sort && sort.col === col.name ? ' sorted' : '')}
              style={{ left: RN_W + offsets[c], width: widths[c] }}
              onClick={() => onSort && onSort(col.name)}
              title={col.name}
            >
              <span className="g-hname">{col.name}</span>
              {sort && sort.col === col.name && <span className="g-sort">{sort.dir === 'DESC' ? '▼' : '▲'}</span>}
              <span className="g-resize" onMouseDown={(e) => startResize(e, c)} onDoubleClick={(e) => { e.stopPropagation(); autoFit(c); }} onClick={(e) => e.stopPropagation()} />
            </div>
          ))}
        </div>
        {visible}
        {editing && !editing.long && (
          <input
            className="g-editor"
            autoFocus
            style={{ top: HEADER_H + editing.r * ROW_H, left: RN_W + offsets[editing.c], width: Math.max(widths[editing.c], 160) }}
            defaultValue={editing.value}
            placeholder={editing.wasNull ? 'NULL' : ''}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitEdit(e.target.value);
              else if (e.key === 'Escape') {
                setEditing(null);
                scrollRef.current?.focus({ preventScroll: true });
              } else if (e.key === 'Tab') {
                e.preventDefault();
                commitEdit(e.target.value);
              }
            }}
            onBlur={(e) => commitEdit(e.target.value)}
          />
        )}
      </div>
      {!rows.length && <div className="g-empty">{emptyText}</div>}
      {editing && editing.long && (
        <LongTextEditor
          title={columns[editing.c].name}
          value={editing.value}
          onCancel={() => setEditing(null)}
          onSave={(v) => commitEdit(v)}
        />
      )}
    </div>
  );
}

function LongTextEditor({ title, value, onCancel, onSave }) {
  const ref = useRef(null);
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Edit “{title}”</div>
        <textarea
          ref={ref}
          className="long-text"
          defaultValue={value}
          autoFocus
          spellCheck={false}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') onCancel();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(ref.current.value);
          }}
        />
        <div className="modal-actions">
          <span className="hint">⌘↩ to save</span>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onSave(ref.current.value)}>Save</button>
        </div>
      </div>
    </div>
  );
}
