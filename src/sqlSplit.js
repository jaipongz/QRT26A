// Split a MySQL script into statements, honouring quotes, comments and DELIMITER.
// Returns [{ text, from, to }] with offsets into the original string.
export function splitSql(src) {
  const out = [];
  let delimiter = ';';
  let start = 0;
  let i = 0;
  const n = src.length;

  const push = (end, nextStart) => {
    const raw = src.slice(start, end);
    if (raw.trim() && !isOnlyComments(raw)) {
      const lead = leadingJunk(raw);
      const text = raw.slice(lead).trimEnd();
      out.push({ text, from: start + lead, to: start + lead + text.length });
    }
    start = nextStart;
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // DELIMITER command at the beginning of a line/statement
    if ((ch === 'D' || ch === 'd') && atStatementStart(src, start, i) && /^delimiter[ \t]+/i.test(src.slice(i, i + 11))) {
      const lineEnd = src.indexOf('\n', i);
      const end = lineEnd === -1 ? n : lineEnd;
      const m = /^delimiter[ \t]+(\S+)/i.exec(src.slice(i, end));
      if (m) delimiter = m[1];
      start = end;
      i = end;
      continue;
    }

    if (ch === '-' && next === '-' && (src[i + 2] === ' ' || src[i + 2] === '\t' || src[i + 2] === '\n' || i + 2 >= n)) {
      const e = src.indexOf('\n', i);
      i = e === -1 ? n : e + 1;
      continue;
    }
    if (ch === '#') {
      const e = src.indexOf('\n', i);
      i = e === -1 ? n : e + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(src, i, ch);
      continue;
    }
    if (src.startsWith(delimiter, i)) {
      push(i, i + delimiter.length);
      i += delimiter.length;
      continue;
    }
    i++;
  }
  push(n, n);
  return out;
}

// Length of leading whitespace + comments.
function leadingJunk(s) {
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s.startsWith('--', i) && /^(\s|$)/.test(s[i + 2] || "")) {
      const e = s.indexOf('\n', i);
      i = e === -1 ? s.length : e + 1;
    } else if (s[i] === '#') {
      const e = s.indexOf('\n', i);
      i = e === -1 ? s.length : e + 1;
    } else if (s.startsWith('/*', i) && s[i + 2] !== '!') {
      const e = s.indexOf('*/', i + 2);
      i = e === -1 ? s.length : e + 2;
    } else return i;
  }
}

function skipQuoted(src, i, q) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\' && q !== '`') {
      j += 2;
      continue;
    }
    if (c === q) {
      if (src[j + 1] === q) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return src.length;
}

function atStatementStart(src, start, i) {
  return src.slice(start, i).trim() === '' || /\n\s*$/.test(src.slice(start, i)) && stripComments(src.slice(start, i)).trim() === '';
}

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(--\s|#)[^\n]*/g, '');
}

function isOnlyComments(s) {
  return stripComments(s).trim() === '';
}

// Statement under the cursor; when the cursor sits after a statement's terminator on the
// same/whitespace region, pick the preceding statement (Querious-like behaviour).
export function statementAt(src, pos) {
  const stmts = splitSql(src);
  if (!stmts.length) return null;
  for (const s of stmts) if (pos >= s.from && pos <= s.to + 1) return s;
  let best = null;
  for (const s of stmts) if (s.to <= pos) best = s;
  return best || stmts[0];
}

// Rough check for statements that may change data/schema (used for confirm prompts).
export function isDangerous(sql) {
  const s = stripComments(sql).trim().toLowerCase();
  if (/^(drop|truncate)\b/.test(s)) return true;
  if (/^(delete|update)\b/.test(s) && !/\bwhere\b/.test(s)) return true;
  return false;
}
