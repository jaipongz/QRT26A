export const api = window.api;

export const qid = (name) => '`' + String(name).replace(/`/g, '``') + '`';

export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0') + "'";
}

export function formatBytes(n) {
  if (n === null || n === undefined) return '—';
  n = Number(n);
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}

export function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

export function formatMs(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvCell(c.name)).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n');
}

export function toTsv(columns, rows, withHeader) {
  const cell = (v) => (v === null || v === undefined ? 'NULL' : String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' '));
  const lines = withHeader ? [columns.map((c) => c.name).join('\t')] : [];
  for (const r of rows) lines.push(r.map(cell).join('\t'));
  return lines.join('\n');
}

export function toInsert(table, columns, rows) {
  if (!rows.length) return '';
  const cols = columns.map((c) => qid(c.name)).join(', ');
  const values = rows.map((r) => '(' + r.map(sqlLiteral).join(', ') + ')').join(',\n  ');
  return `INSERT INTO ${qid(table || 'table')} (${cols}) VALUES\n  ${values};`;
}

export function toJson(columns, rows) {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i]]))),
    null,
    2
  );
}

const LS_PREFIX = 'qrt:';
export function loadLocal(key, fallback) {
  try {
    const v = localStorage.getItem(LS_PREFIX + key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
export function saveLocal(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const isMac = navigator.platform.toLowerCase().includes('mac');
