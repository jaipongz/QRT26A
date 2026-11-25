// One Session per window. A session owns:
//   - an optional SSH client (all MySQL connections are forwarded through it)
//   - a "meta" connection for schema metadata (multi-statement, so a whole schema loads in one round trip)
//   - an "aux" connection for slow side work (COUNT(*), KILL QUERY)
//   - one connection per workspace tab, so a long query in one tab never blocks another tab or the sidebar
const fs = require('fs');
const os = require('os');
const net = require('net');
const mysql = require('mysql2/promise');
const mysqlCore = require('mysql2');
const { Client: SshClient } = require('ssh2');

const MAX_RESULT_ROWS = 50000;
const MAX_CELL_CHARS = 65536;
const IDLE_PING_MS = 60_000;

const id = (name) => mysql.escapeId(name);

function expandHome(p) {
  return p && p.startsWith('~') ? os.homedir() + p.slice(1) : p;
}

// Convert driver values into something that is safe/cheap to send over IPC and display.
function serializeValue(v, field) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) {
    // BIT columns arrive as buffers: show them as numbers.
    if (field && field.columnType === 16) {
      let n = 0n;
      for (const b of v) n = (n << 8n) | BigInt(b);
      return n.toString();
    }
    const text = v.toString('utf8');
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000e-\u001f�]/.test(text)) return text;
    const hex = v.subarray(0, 512).toString('hex').toUpperCase();
    return '0x' + hex + (v.length > 512 ? `… (${v.length} bytes)` : '');
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function describeFields(fields) {
  return (fields || []).map((f) => ({
    name: f.name,
    table: f.orgTable || f.table || '',
    orgName: f.orgName || f.name,
    db: f.db || f.schema || '',
    type: f.columnType,
  }));
}

// Errors meaning "this connection is gone" (safe to reconnect; the statement never ran).
function isStaleConnError(e) {
  return (
    e &&
    (e.code === 'PROTOCOL_CONNECTION_LOST' ||
      e.code === 'ECONNRESET' ||
      e.code === 'EPIPE' ||
      e.fatal === true ||
      /closed state|Connection lost|connection is closed/i.test(e.message || ''))
  );
}

const TX_LOST =
  'Connection to the server was lost while a transaction was open (START TRANSACTION without COMMIT). ' +
  'The server rolled back every change made since START TRANSACTION — re-run that part of the script.';

// Keep e.inTx in sync. OK packets carry the server's SERVER_STATUS_IN_TRANS flag (authoritative);
// for result sets fall back to the statement itself.
function trackTransaction(e, sql, okPacket) {
  if (okPacket && typeof okPacket.serverStatus === 'number') {
    e.inTx = (okPacket.serverStatus & 1) === 1;
    return;
  }
  const s = sql.replace(/^(\s|--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '').toUpperCase();
  if (/^(START\s+TRANSACTION|BEGIN\b)/.test(s)) e.inTx = true;
  else if (/^(COMMIT|ROLLBACK)\b/.test(s) && !/^ROLLBACK\s+TO\b/.test(s)) e.inTx = false;
  else if (/^(CREATE|ALTER|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK\s+TABLES)\b/.test(s)) e.inTx = false; // implicit commit
}

const SSL_MODES = ['disabled', 'required', 'verify_ca', 'verify_identity'];

function sslModeOf(cfg) {
  const m = cfg.sslMode || (cfg.ssl ? 'required' : 'disabled');
  return SSL_MODES.includes(m) ? m : 'disabled';
}

function readPem(p, label) {
  try {
    return fs.readFileSync(expandHome(p));
  } catch (e) {
    throw new Error(`Cannot read ${label} file ${p}: ${e.message}`);
  }
}

class Session {
  // hooks.verifyHostKey({ host, port, key }) → Promise<true | string(reason)>
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.config = null;
    this.ssh = null;
    this.sshAlive = false;
    this.flavor = 'mysql'; // or 'mariadb'
    this.version = '';
    this.conns = new Map(); // key -> { conn, db, lastUsed, running: threadId|null, dead }
    this.spare = null; // Promise<entry>: a pre-opened connection handed to the next new tab
  }

  newEntry(multi = false) {
    return (async () => {
      const conn = await this.createConnection(null, { multi });
      const ent = { conn, db: null, lastUsed: Date.now(), running: null, dead: false };
      conn.on('error', () => { ent.dead = true; });
      conn.on('end', () => { ent.dead = true; });
      return ent;
    })();
  }

  // Keep one idle connection ready so opening a tab costs no connect round trips.
  warmSpare() {
    if (this.spare || !this.config) return;
    const p = this.newEntry();
    this.spare = p;
    p.catch(() => {
      if (this.spare === p) this.spare = null;
    });
  }

  async takeSpare() {
    const p = this.spare;
    this.spare = null;
    if (!p) return null;
    try {
      const e = await p;
      if (!e.dead && Date.now() - e.lastUsed > IDLE_PING_MS) await e.conn.ping();
      return e.dead ? null : e;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- transport
  async openSsh() {
    const cfg = this.config;
    const ssh = new SshClient();
    const opts = {
      host: cfg.sshHost,
      port: Number(cfg.sshPort) || 22,
      username: cfg.sshUser,
      readyTimeout: 20000,
      keepaliveInterval: 20000,
      keepaliveCountMax: 3,
    };
    // Host key verification (MITM protection). Without a verifier hook nothing is trusted.
    let rejectReason = null;
    opts.hostVerifier = (key, verify) => {
      const check = this.hooks.verifyHostKey
        ? this.hooks.verifyHostKey({ host: opts.host, port: opts.port, key })
        : Promise.resolve('No host key verifier configured');
      check.then(
        (r) => {
          if (r === true) return verify(true);
          rejectReason = r || 'Host key was not trusted';
          verify(false);
        },
        (e) => {
          rejectReason = e.message;
          verify(false);
        }
      );
    };
    if (cfg.sshAuth === 'key') {
      const keyPath = expandHome(cfg.sshKeyPath || '~/.ssh/id_rsa');
      opts.privateKey = fs.readFileSync(keyPath);
      if (cfg.sshPassphrase) opts.passphrase = cfg.sshPassphrase;
    } else if (cfg.sshAuth === 'agent') {
      opts.agent = process.env.SSH_AUTH_SOCK;
    } else {
      opts.password = cfg.sshPassword;
      opts.tryKeyboard = true;
      ssh.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => cfg.sshPassword)));
    }
    await new Promise((resolve, reject) => {
      ssh.once('ready', resolve);
      ssh.once('error', (e) => reject(new Error('SSH: ' + (rejectReason || e.message))));
      ssh.connect(opts);
    });
    ssh.on('error', () => {});
    ssh.on('close', () => {
      if (this.ssh === ssh) this.sshAlive = false;
    });
    this.ssh = ssh;
    this.sshAlive = true;
  }

  forward() {
    const cfg = this.config;
    return new Promise((resolve, reject) => {
      this.ssh.forwardOut('127.0.0.1', 0, cfg.host || '127.0.0.1', Number(cfg.port) || 3306, (err, stream) =>
        err ? reject(new Error('SSH forward: ' + err.message)) : resolve(stream)
      );
    });
  }

  async createConnection(database, { multi = false } = {}) {
    const cfg = this.config;
    const opts = {
      host: cfg.host || '127.0.0.1',
      port: Number(cfg.port) || 3306,
      user: cfg.user,
      password: cfg.password || undefined,
      database: database || undefined,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: multi,
      connectTimeout: 20000,
      enableKeepAlive: true,
    };
    const mode = sslModeOf(cfg);
    if (mode !== 'disabled') {
      const ssl = {};
      if (cfg.sslCa) ssl.ca = readPem(cfg.sslCa, 'CA certificate');
      if (cfg.sslCert) ssl.cert = readPem(cfg.sslCert, 'client certificate');
      if (cfg.sslKey) ssl.key = readPem(cfg.sslKey, 'client key');
      if (mode === 'required') {
        ssl.rejectUnauthorized = false; // encrypted, but the server is NOT authenticated
      } else {
        ssl.rejectUnauthorized = true; // chain must verify against the CA (or system CAs)
        ssl.verifyIdentity = mode === 'verify_identity'; // certificate must also match the host name/IP
      }
      opts.ssl = ssl;
    }
    if (cfg.socketPath && !cfg.useSsh) {
      opts.socketPath = cfg.socketPath;
      delete opts.host;
      delete opts.port;
    }
    if (cfg.useSsh) {
      if (!this.sshAlive) {
        try { this.ssh && this.ssh.end(); } catch { /* ignore */ }
        await this.openSsh();
      }
      opts.stream = await this.forward();
      // Node's TLS identity check falls back to socket._host when no SNI name is set (IP hosts);
      // without this a tunnelled IP host would be checked against "localhost".
      opts.stream._host = opts.host;
    } else if (opts.ssl && opts.ssl.verifyIdentity && net.isIP(opts.host)) {
      // Same for a direct TCP connection to an IP address (Node only records _host for names).
      const sock = net.connect({ host: opts.host, port: opts.port });
      sock._host = opts.host;
      opts.stream = sock;
    }
    // Use the core API so an 'error' listener is attached before the handshake starts:
    // a failed TLS/auth handshake must reject this promise, never crash the main process.
    return new Promise((resolve, reject) => {
      const core = mysqlCore.createConnection(opts);
      let settled = false;
      core.on('error', (e) => {
        if (!settled) {
          settled = true;
          try { core.destroy(); } catch { /* ignore */ }
          reject(e);
        }
      });
      core.once('connect', () => {
        settled = true;
        resolve(core.promise());
      });
    });
  }

  async connect(cfg) {
    await this.close();
    this.config = cfg;
    try {
      const entry = await this.entry('meta');
      const [[row]] = await entry.conn.query('SELECT VERSION() AS v');
      this.version = row.v;
      this.flavor = /mariadb/i.test(row.v) ? 'mariadb' : 'mysql';
      this.warmSpare();
      return { version: row.v, flavor: this.flavor, database: cfg.database || null };
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  async close() {
    const spare = this.spare;
    this.spare = null;
    if (spare) spare.then((e) => e.conn.destroy(), () => {});
    for (const e of this.conns.values()) {
      try { e.conn.destroy(); } catch { /* ignore */ }
    }
    this.conns.clear();
    try { if (this.ssh) this.ssh.end(); } catch { /* ignore */ }
    this.ssh = null;
    this.sshAlive = false;
  }

  async closeKey(key) {
    const e = this.conns.get(key);
    if (!e) return;
    this.conns.delete(key);
    try { await e.conn.end(); } catch { try { e.conn.destroy(); } catch { /* ignore */ } }
  }

  // Get (or lazily create) the connection for `key`, reconnecting if it went stale.
  async entry(key) {
    if (!this.config) throw new Error('Not connected');
    let e = this.conns.get(key);
    if (e && !e.dead && Date.now() - e.lastUsed > IDLE_PING_MS && !e.running) {
      try {
        await e.conn.ping();
      } catch {
        e.dead = true;
      }
    }
    if (e && e.dead) {
      try { e.conn.destroy(); } catch { /* ignore */ }
      this.conns.delete(key);
      if (e.inTx) throw new Error(TX_LOST); // next call gets a fresh connection
      e = null;
    }
    if (!e) {
      const pending = this.conns.get(key + ':pending');
      if (pending) return pending.promise;
      const promise = (async () => {
        const isTab = key !== 'meta' && key !== 'aux';
        const ent = (isTab && (await this.takeSpare())) || (await this.newEntry(key === 'meta'));
        this.conns.set(key, ent);
        if (isTab) this.warmSpare();
        return ent;
      })();
      this.conns.set(key + ':pending', { promise });
      try {
        return await promise;
      } finally {
        this.conns.delete(key + ':pending');
      }
    }
    return e;
  }

  // Run fn(entry) on a connection; reconnect once if the connection turned out to be stale.
  // Non-idempotent work (user SQL, row edits, DDL) is only retried when the statement was never sent.
  async withConn(key, fn, { idempotent = true } = {}) {
    let e = await this.entry(key);
    try {
      const r = await fn(e);
      e.lastUsed = Date.now();
      return r;
    } catch (err) {
      if (!isStaleConnError(err)) throw err;
      e.dead = true;
      if (e.inTx) {
        this.conns.delete(key);
        try { e.conn.destroy(); } catch { /* ignore */ }
        throw new Error(TX_LOST);
      }
      if (!idempotent && !/closed state/i.test(err.message || '')) {
        throw new Error('Connection to the server was lost while the statement was running. It may or may not have been applied — check before re-running.');
      }
      const prevDb = e.db;
      e = await this.entry(key);
      if (prevDb) {
        await e.conn.query('USE ' + id(prevDb));
        e.db = prevDb;
      }
      const r = await fn(e);
      e.lastUsed = Date.now();
      return r;
    }
  }

  meta(sql, params) {
    return this.withConn('meta', async (e) => (await e.conn.query(sql, params))[0]);
  }

  // ---------------------------------------------------------------- metadata
  async databases() {
    const rows = await this.meta('SHOW DATABASES');
    return rows.map((r) => Object.values(r)[0]);
  }

  // Fast: just names and types for the sidebar.
  async tableList(db) {
    const rows = await this.meta(`SHOW FULL TABLES FROM ${id(db)}`);
    return rows.map((r) => {
      const v = Object.values(r);
      return { name: v[0], type: v[1] === 'VIEW' ? 'VIEW' : 'BASE TABLE' };
    });
  }

  // Everything needed for Structure / Content / autocomplete, in ONE round trip.
  async schemaDetails(db) {
    const q = mysql.escape(db);
    const sql = [
      `SELECT TABLE_NAME t, COLUMN_NAME name, ORDINAL_POSITION pos, COLUMN_TYPE type, IS_NULLABLE nullable, COLUMN_KEY \`key\`,
              COLUMN_DEFAULT def, EXTRA extra, CHARACTER_SET_NAME charset, COLLATION_NAME collation, COLUMN_COMMENT comment
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${q} ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      `SELECT TABLE_NAME t, INDEX_NAME name, NON_UNIQUE nonUnique, SEQ_IN_INDEX seq, COLUMN_NAME col, SUB_PART subPart,
              INDEX_TYPE type, INDEX_COMMENT comment
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${q} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      `SELECT TABLE_NAME t, CONSTRAINT_NAME name, COLUMN_NAME col, REFERENCED_TABLE_SCHEMA refDb, REFERENCED_TABLE_NAME refTable,
              REFERENCED_COLUMN_NAME refCol, ORDINAL_POSITION pos
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ${q} AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
      `SELECT TABLE_NAME t, CONSTRAINT_NAME name, UPDATE_RULE onUpdate, DELETE_RULE onDelete
         FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ${q}`,
      `SELECT ROUTINE_NAME name, ROUTINE_TYPE type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${q} ORDER BY ROUTINE_NAME`,
    ].join(';\n');
    const [cols, stats, kcu, rc, routines] = await this.meta(sql);

    const columns = {};
    for (const c of cols) {
      (columns[c.t] ||= []).push({
        name: c.name,
        type: c.type,
        nullable: c.nullable === 'YES',
        key: c.key,
        extra: c.extra || '',
        charset: c.charset,
        collation: c.collation,
        comment: c.comment || '',
        ...this.normalizeDefault(c),
      });
    }
    const indexes = {};
    for (const s of stats) {
      const list = (indexes[s.t] ||= []);
      let ix = list.find((x) => x.name === s.name);
      if (!ix) list.push((ix = { name: s.name, unique: !Number(s.nonUnique), type: s.type, comment: s.comment || '', columns: [] }));
      ix.columns.push({ name: s.col, subPart: s.subPart });
    }
    const rules = new Map(rc.map((r) => [r.t + '\u0001' + r.name, r]));
    const foreignKeys = {};
    for (const k of kcu) {
      const list = (foreignKeys[k.t] ||= []);
      let fk = list.find((x) => x.name === k.name);
      if (!fk) {
        const r = rules.get(k.t + '\u0001' + k.name) || {};
        list.push((fk = { name: k.name, refDb: k.refDb, refTable: k.refTable, columns: [], refColumns: [], onUpdate: r.onUpdate, onDelete: r.onDelete }));
      }
      fk.columns.push(k.col);
      fk.refColumns.push(k.refCol);
    }
    return { columns, indexes, foreignKeys, routines };
  }

  // Table sizes etc. for the Info view (can be slow on old servers, so it is loaded separately).
  async tableStats(db) {
    return this.meta(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS \`rows\`,
              DATA_LENGTH AS dataLength, INDEX_LENGTH AS indexLength, TABLE_COLLATION AS collation,
              CREATE_TIME AS created, UPDATE_TIME AS updated, TABLE_COMMENT AS comment, AUTO_INCREMENT AS autoIncrement
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [db]
    );
  }

  async createStatement(db, table) {
    const [row] = await this.meta(`SHOW CREATE TABLE ${id(db)}.${id(table)}`);
    return row['Create Table'] || row['Create View'] || '';
  }

  // Normalise COLUMN_DEFAULT across MySQL and MariaDB into { defaultKind, defaultValue }.
  //   none  – no DEFAULT clause      null – DEFAULT NULL
  //   value – literal                expr – expression (CURRENT_TIMESTAMP, uuid(), b'0' …)
  normalizeDefault(c) {
    const d = c.def;
    if (this.flavor === 'mariadb') {
      if (d === null) return { defaultKind: 'none', defaultValue: '' };
      if (d === 'NULL') return { defaultKind: 'null', defaultValue: '' };
      if (/^'.*'$/s.test(d)) return { defaultKind: 'value', defaultValue: d.slice(1, -1).replace(/''/g, "'").replace(/\\\\/g, '\\') };
      if (/^-?\d+(\.\d+)?$/.test(d)) return { defaultKind: 'value', defaultValue: d };
      return { defaultKind: 'expr', defaultValue: d };
    }
    if (d === null) return { defaultKind: c.nullable === 'YES' ? 'null' : 'none', defaultValue: '' };
    if (/DEFAULT_GENERATED/i.test(c.extra || '') || /^b'[01]*'$/.test(d)) return { defaultKind: 'expr', defaultValue: d };
    return { defaultKind: 'value', defaultValue: d };
  }

  // ---------------------------------------------------------------- tab work
  async useDb(e, db) {
    if (db && e.db !== db) {
      await e.conn.query('USE ' + id(db));
      e.db = db;
    }
  }

  async content(tabId, { db, table, where, orderBy, orderDir, limit = 1000, offset = 0 }) {
    const whereSql = where && where.trim() ? ` WHERE ${where}` : '';
    const orderSql = orderBy ? ` ORDER BY ${id(orderBy)} ${orderDir === 'DESC' ? 'DESC' : 'ASC'}` : '';
    const sql = `SELECT * FROM ${id(db)}.${id(table)}${whereSql}${orderSql} LIMIT ${Number(limit) | 0} OFFSET ${Number(offset) | 0}`;
    return this.withConn(tabId, async (e) => {
      const started = Date.now();
      e.running = e.conn.threadId;
      try {
        const [rows, fields] = await e.conn.query({ sql, rowsAsArray: true });
        return {
          sql,
          ms: Date.now() - started,
          columns: describeFields(fields),
          rows: rows.map((r) => r.map((v, i) => serializeValue(v, fields[i]))),
        };
      } finally {
        e.running = null;
      }
    });
  }

  async count({ db, table, where }) {
    const whereSql = where && where.trim() ? ` WHERE ${where}` : '';
    return this.withConn('aux', async (e) => {
      const [[r]] = await e.conn.query(`SELECT COUNT(*) AS n FROM ${id(db)}.${id(table)}${whereSql}`);
      return Number(r.n);
    });
  }

  async runQuery(tabId, sql, database) {
    return this.withConn(tabId, async (e) => {
      await this.useDb(e, database);
      e.running = e.conn.threadId;
      const started = Date.now();
      try {
        let [result, fields] = await e.conn.query({ sql, rowsAsArray: true });
        const ms = Date.now() - started;
        const m = /^\s*use\s+`?([^`;\s]+)`?/i.exec(sql);
        if (m) e.db = m[1];
        // CALL returns several result sets: [[rows], ..., ResultSetHeader] with fields [[f], ..., undefined].
        const multi = Array.isArray(fields) && fields.some((f) => Array.isArray(f));
        const setIdx = multi ? fields.findIndex((f) => Array.isArray(f)) : -1;
        const rowSet = multi ? result[setIdx] : Array.isArray(result) && fields ? result : null;
        const rowFields = multi ? fields[setIdx] : fields;
        trackTransaction(e, sql, Array.isArray(result) ? null : result);
        if (rowSet) {
          const truncated = rowSet.length > MAX_RESULT_ROWS;
          const rows = truncated ? rowSet.slice(0, MAX_RESULT_ROWS) : rowSet;
          return {
            kind: 'rows',
            ms,
            total: rowSet.length,
            truncated,
            columns: describeFields(rowFields),
            rows: rows.map((r) => r.map((v, i) => serializeValue(v, rowFields[i]))),
          };
        }
        if (Array.isArray(result)) result = result[result.length - 1] || {};
        // Warnings/notes matter for scripts: "IF NOT EXISTS" on an existing table, INSERT IGNORE skips, truncation…
        let warnings = [];
        if (result.warningStatus > 0) {
          try {
            const [w] = await e.conn.query('SHOW WARNINGS LIMIT 50');
            warnings = w.map((r) => ({ level: r.Level, code: r.Code, message: r.Message }));
          } catch { /* ignore */ }
        }
        return {
          kind: 'ok',
          ms,
          affectedRows: result.affectedRows,
          changedRows: result.changedRows,
          insertId: result.insertId,
          info: result.info,
          warningStatus: result.warningStatus,
          warnings,
        };
      } catch (err) {
        if (err.errno === 1213) e.inTx = false; // deadlock: the server rolled the whole transaction back
        throw err;
      } finally {
        e.running = null;
      }
    }, { idempotent: false });
  }

  // Is a transaction open on this tab's connection (uncommitted changes would be lost if it closes)?
  txState(tabId) {
    const e = this.conns.get(tabId);
    return !!(e && !e.dead && e.inTx);
  }

  // Cancel the statement running in a tab (KILL QUERY from the aux connection).
  async cancel(tabId) {
    const e = this.conns.get(tabId);
    if (!e || !e.running) return false;
    const threadId = Number(e.running);
    await this.withConn('aux', (a) => a.conn.query('KILL QUERY ' + threadId));
    return true;
  }

  // ---------------------------------------------------------------- row editing
  whereFor(key) {
    return Object.entries(key)
      .map(([c, v]) => `${id(c)} <=> ${mysql.escape(v)}`)
      .join(' AND ');
  }

  async updateRow(tabId, { db, table, key, changes }) {
    const set = Object.entries(changes).map(([c, v]) => `${id(c)} = ${valueSql(v)}`).join(', ');
    const sql = `UPDATE ${id(db)}.${id(table)} SET ${set} WHERE ${this.whereFor(key)} LIMIT 1`;
    const [res] = await this.withConn(tabId, (e) => e.conn.query(sql), { idempotent: false });
    return { sql, affectedRows: res.affectedRows };
  }

  async insertRow(tabId, { db, table, values }) {
    const cols = Object.keys(values);
    const sql = cols.length
      ? `INSERT INTO ${id(db)}.${id(table)} (${cols.map(id).join(', ')}) VALUES (${cols.map((c) => valueSql(values[c])).join(', ')})`
      : `INSERT INTO ${id(db)}.${id(table)} () VALUES ()`;
    const [res] = await this.withConn(tabId, (e) => e.conn.query(sql), { idempotent: false });
    return { sql, insertId: res.insertId, affectedRows: res.affectedRows };
  }

  async deleteRows(tabId, { db, table, keys }) {
    return this.withConn(tabId, async (e) => {
      let affected = 0;
      const statements = [];
      await e.conn.beginTransaction();
      try {
        for (const key of keys) {
          const sql = `DELETE FROM ${id(db)}.${id(table)} WHERE ${this.whereFor(key)} LIMIT 1`;
          statements.push(sql);
          const [res] = await e.conn.query(sql);
          affected += res.affectedRows;
        }
        await e.conn.commit();
      } catch (err) {
        await e.conn.rollback().catch(() => {});
        throw err;
      }
      return { sql: statements.join(';\n'), affectedRows: affected };
    }, { idempotent: false });
  }

  // Run a DDL statement built by the Structure editor.
  async execDdl(tabId, sql, db) {
    await this.withConn(tabId, async (e) => {
      await this.useDb(e, db); // the reviewed SQL may be edited to use unqualified names
      return e.conn.query(sql);
    }, { idempotent: false });
    return { sql };
  }
}

// Values from the editor: null → NULL, { expr } → raw SQL expression (e.g. NOW()), else escaped literal.
function valueSql(v) {
  if (v === null) return 'NULL';
  if (v && typeof v === 'object' && typeof v.expr === 'string') return v.expr;
  return mysql.escape(v);
}

module.exports = { Session };
