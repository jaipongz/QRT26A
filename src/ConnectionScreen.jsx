import React, { useEffect, useState } from 'react';
import { api } from './util';

export const COLORS = ['', '#e5484d', '#f76b15', '#ffc53d', '#46a758', '#0090ff', '#8e4ec6', '#8d8d8d'];

const BLANK = {
  name: '',
  color: '',
  host: '127.0.0.1',
  port: '3306',
  user: 'root',
  password: '',
  database: '',
  socketPath: '',
  sslMode: 'disabled',
  sslCa: '',
  sslCert: '',
  sslKey: '',
  useSsh: false,
  sshHost: '',
  sshPort: '22',
  sshUser: '',
  sshAuth: 'key',
  sshPassword: '',
  sshKeyPath: '~/.ssh/id_rsa',
  sshPassphrase: '',
};

export default function ConnectionScreen({ onConnected }) {
  const [list, setList] = useState([]);
  const [form, setForm] = useState(BLANK);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState(null); // { kind: 'ok'|'error'|'busy', text }
  const [dragId, setDragId] = useState(null);

  const load = async () => {
    const l = await api.listConnections();
    setList(l);
    return l;
  };

  useEffect(() => {
    load().then((l) => {
      const lastId = localStorage.getItem('qrt:lastConnection');
      const last = l.find((c) => c.id === lastId) || l[0];
      if (last) setForm({ ...BLANK, ...last });
    });
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const save = async (silent) => {
    const { secretsLost, ...rest } = form;
    const toSave = { ...rest, name: form.name || defaultName(form) };
    // Main process encrypts secrets and returns the public view (no secret values come back).
    const saved = { ...BLANK, ...(await api.saveConnection(toSave)) };
    setForm(saved);
    await load();
    if (!silent) setStatus({ kind: 'ok', text: 'Saved' });
    return saved;
  };

  const test = async () => {
    setStatus({ kind: 'busy', text: 'Testing…' });
    try {
      const info = await api.testConnection(form);
      setStatus({ kind: 'ok', text: `Connected — MySQL ${info.version}` });
    } catch (e) {
      setStatus({ kind: 'error', text: e.message });
    }
  };

  const connect = async (cfg = form) => {
    setStatus({ kind: 'busy', text: 'Connecting…' });
    try {
      let conf = cfg;
      if (cfg === form && (form.id || form.name)) conf = await save(true);
      const info = await api.connect(conf);
      if (conf.id) localStorage.setItem('qrt:lastConnection', conf.id);
      setStatus(null);
      const { password, sshPassword, sshPassphrase, clear, ...pub } = conf;
      onConnected(pub, info);
    } catch (e) {
      setStatus({ kind: 'error', text: e.message });
    }
  };

  const remove = async () => {
    if (!form.id) return;
    if (!(await api.confirm({ message: `Delete connection “${form.name}”?`, okLabel: 'Delete' }))) return;
    await api.deleteConnection(form.id);
    const l = await load();
    setForm(l[0] ? { ...BLANK, ...l[0] } : BLANK);
  };

  const duplicate = () => setForm({ ...form, id: undefined, copyFrom: form.id, name: form.name + ' copy' });

  const onDrop = async (targetId) => {
    if (!dragId || dragId === targetId) return;
    const ids = list.map((c) => c.id).filter((x) => x !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    await api.reorderConnections(ids);
    setDragId(null);
    load();
  };

  const shown = list.filter((c) => !filter || (c.name + ' ' + c.host + ' ' + (c.sshHost || '')).toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="connect-screen">
      <div className="titlebar-drag" />
      <aside className="conn-list">
        <div className="conn-list-head">
          <input className="search" placeholder="Search connections" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="conn-items">
          {shown.map((c) => (
            <div
              key={c.id}
              className={'conn-item' + (form.id === c.id ? ' active' : '')}
              onClick={() => setForm({ ...BLANK, ...c })}
              onDoubleClick={() => connect({ ...BLANK, ...c })}
              draggable
              onDragStart={() => setDragId(c.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(c.id)}
            >
              <span className="dot" style={{ background: c.color || 'var(--text-faint)' }} />
              <div className="conn-item-text">
                <div className="conn-item-name">{c.name || defaultName(c)}</div>
                <div className="conn-item-sub">
                  {c.user}@{c.host}:{c.port}
                  {c.useSsh ? `  ·  SSH ${c.sshHost}` : ''}
                </div>
              </div>
            </div>
          ))}
          {!shown.length && <div className="empty-note">No saved connections</div>}
        </div>
        <button className="new-conn" onClick={() => { setForm(BLANK); setStatus(null); }}>
          ＋ New Connection
        </button>
      </aside>

      <main className="conn-form-wrap">
        <form
          className="conn-form"
          onSubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <h1>{form.id ? form.name || defaultName(form) : 'New Connection'}</h1>
          {form.secretsLost && (
            <div className="status-box error">Saved passwords for this connection could not be decrypted from the Keychain. Please re-enter them and Save.</div>
          )}

          <div className="row">
            <label>Name</label>
            <input value={form.name} onChange={set('name')} placeholder={defaultName(form)} />
          </div>
          <div className="row">
            <label>Color</label>
            <div className="colors">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c || 'none'}
                  className={'color-swatch' + (form.color === c ? ' on' : '')}
                  style={{ background: c || 'transparent' }}
                  onClick={() => setForm((f) => ({ ...f, color: c }))}
                  title={c || 'None'}
                />
              ))}
            </div>
          </div>

          <fieldset>
            <legend>MySQL</legend>
            <div className="row two">
              <label>Host</label>
              <input value={form.host} onChange={set('host')} placeholder="127.0.0.1" />
              <label className="small">Port</label>
              <input className="port" value={form.port} onChange={set('port')} placeholder="3306" />
            </div>
            <div className="row">
              <label>User</label>
              <input value={form.user} onChange={set('user')} autoComplete="off" />
            </div>
            <div className="row">
              <label>Password</label>
              <SecretInput form={form} setForm={setForm} field="password" />
            </div>
            <div className="row">
              <label>Database</label>
              <input value={form.database} onChange={set('database')} placeholder="optional" />
            </div>
            {!form.useSsh && (
              <div className="row">
                <label>Socket</label>
                <input value={form.socketPath} onChange={set('socketPath')} placeholder="optional, e.g. /tmp/mysql.sock" />
              </div>
            )}
            <div className="row">
              <label>SSL/TLS</label>
              <select value={form.sslMode || 'disabled'} onChange={set('sslMode')}>
                <option value="disabled">Disabled</option>
                <option value="required">Required — encrypt only (server not verified)</option>
                <option value="verify_ca">Verify CA — encrypt + verify certificate</option>
                <option value="verify_identity">Verify identity — also check host name/IP</option>
              </select>
            </div>
            {form.sslMode === 'required' && (
              <div className="hint indent warn-text">Traffic is encrypted but the server's certificate is not checked, so a man-in-the-middle is still possible. Use Verify CA / Verify identity when you can.</div>
            )}
            {(form.sslMode === 'verify_ca' || form.sslMode === 'verify_identity' || form.sslMode === 'required') && (
              <>
                <FileRow label="CA cert" value={form.sslCa} onChange={(v) => setForm((f) => ({ ...f, sslCa: v }))} placeholder={form.sslMode === 'required' ? 'optional' : 'ca.pem — empty = system CAs'} />
                <FileRow label="Client cert" value={form.sslCert} onChange={(v) => setForm((f) => ({ ...f, sslCert: v }))} placeholder="optional" />
                <FileRow label="Client key" value={form.sslKey} onChange={(v) => setForm((f) => ({ ...f, sslKey: v }))} placeholder="optional" />
              </>
            )}
          </fieldset>

          <fieldset>
            <legend>
              <label className="check">
                <input type="checkbox" checked={!!form.useSsh} onChange={set('useSsh')} /> Connect over SSH
              </label>
            </legend>
            {form.useSsh && (
              <>
                <div className="row two">
                  <label>SSH Host</label>
                  <input value={form.sshHost} onChange={set('sshHost')} />
                  <label className="small">Port</label>
                  <input className="port" value={form.sshPort} onChange={set('sshPort')} />
                </div>
                <div className="row">
                  <label>SSH User</label>
                  <input value={form.sshUser} onChange={set('sshUser')} />
                </div>
                <div className="row">
                  <label>Auth</label>
                  <div className="seg">
                    {[
                      ['key', 'Private Key'],
                      ['password', 'Password'],
                      ['agent', 'SSH Agent'],
                    ].map(([k, l]) => (
                      <button type="button" key={k} className={form.sshAuth === k ? 'on' : ''} onClick={() => setForm((f) => ({ ...f, sshAuth: k }))}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                {form.sshAuth === 'password' && (
                  <div className="row">
                    <label>SSH Password</label>
                    <SecretInput form={form} setForm={setForm} field="sshPassword" />
                  </div>
                )}
                {form.sshAuth === 'key' && (
                  <>
                    <div className="row with-btn">
                      <label>Key File</label>
                      <input value={form.sshKeyPath} onChange={set('sshKeyPath')} />
                      <button
                        type="button"
                        onClick={async () => {
                          const p = await api.chooseKeyFile();
                          if (p) setForm((f) => ({ ...f, sshKeyPath: p }));
                        }}
                      >
                        Choose…
                      </button>
                    </div>
                    <div className="row">
                      <label>Passphrase</label>
                      <SecretInput form={form} setForm={setForm} field="sshPassphrase" placeholder="if the key is encrypted" />
                    </div>
                  </>
                )}
                <div className="hint indent">MySQL host/port above are resolved from the SSH server (usually 127.0.0.1).</div>
              </>
            )}
          </fieldset>

          {status && <div className={'status-box ' + status.kind}>{status.text}</div>}

          <div className="actions">
            {form.id && (
              <>
                <button type="button" className="danger-link" onClick={remove}>
                  Delete
                </button>
                <button type="button" onClick={duplicate}>
                  Duplicate
                </button>
              </>
            )}
            <span className="spacer" />
            <button type="button" onClick={test} disabled={status?.kind === 'busy'}>
              Test
            </button>
            <button type="button" onClick={() => save()}>
              Save
            </button>
            <button type="submit" className="primary" disabled={status?.kind === 'busy'}>
              Connect
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

// Password field that never receives the stored secret: it shows that one is saved and lets you replace or clear it.
function SecretInput({ form, setForm, field, placeholder }) {
  const saved = form['has_' + field] && !(form.clear && form.clear[field]);
  return (
    <>
      <input
        type="password"
        value={form[field] || ''}
        placeholder={saved ? '•••••••• saved in Keychain' : placeholder || ''}
        autoComplete="new-password"
        onChange={(e) => {
          const v = e.target.value;
          setForm((f) => ({ ...f, [field]: v, clear: { ...(f.clear || {}), [field]: false } }));
        }}
      />
      {saved && !form[field] && (
        <button type="button" className="small-btn" title="Remove the saved value" onClick={() => setForm((f) => ({ ...f, clear: { ...(f.clear || {}), [field]: true } }))}>
          Clear
        </button>
      )}
    </>
  );
}

function FileRow({ label, value, onChange, placeholder }) {
  return (
    <div className="row with-btn">
      <label>{label}</label>
      <input value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <button
        type="button"
        onClick={async () => {
          const p = await api.chooseFile({ title: `Choose ${label}` });
          if (p) onChange(p);
        }}
      >
        Choose…
      </button>
    </div>
  );
}

function defaultName(c) {
  if (c.useSsh && c.sshHost) return `${c.sshHost} (SSH)`;
  return c.host ? `${c.user || ''}@${c.host}` : 'Untitled';
}
