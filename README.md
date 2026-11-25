# QRT — MySQL / MariaDB query tool

A Querious-style desktop app for macOS (Electron + mysql2 + ssh2 + React + CodeMirror 6).

## Run / build

```bash
npm install
npm start          # dev: build renderer + launch Electron
npm run app        # build release/mac-arm64/QRT.app (unsigned)
npm run dist       # build .dmg + .zip
```

> In a VS Code terminal, run `unset ELECTRON_RUN_AS_NODE` first, otherwise Electron starts as plain Node.

## Features

- Saved connections (Keychain-encrypted passwords via `safeStorage`), colors, drag to reorder, Test/Duplicate
- SSH tunnel: private key, password, or SSH agent · SSL · Unix socket · auto-reconnect (SSH and MySQL)
- **Tabs** (⌘T new, ⌘W close, ⌃Tab next, drag to reorder, double-click to rename, restored on reconnect).
  Each tab has its own database/table/view, its own query editor + results, and its **own server connection**,
  so a long query in one tab never blocks another tab or the sidebar. Click a table → reuses a table tab;
  ⌘-click / middle-click / “Open in New Tab” → new tab.
- **Schema preload**: choosing a database (or connecting with one) loads table names, then all columns, indexes,
  foreign keys and routines for that database in one round trip; Structure, Content keys and autocomplete read from that cache.
- **Content**: paging, sort, filter (column + operator or custom WHERE), inline edit, Set NULL / NOW(),
  add / duplicate / delete rows, copy as TSV / INSERT / JSON, export CSV. Exact COUNT(*) runs in the background (shows ~estimate first).
- **Structure**: columns, indexes, foreign keys, CREATE statement. Add / edit / drop column, add / drop index, drop FK —
  every change shows the ALTER statement for review (editable) before it runs.
- **Query**: schema-aware autocomplete, ⌘↩ run statement at cursor or selection, ⇧⌘↩ run all, ⌘. cancel (KILL QUERY),
  multiple result sets, error highlighting, confirm on DROP/TRUNCATE/DELETE/UPDATE without WHERE, history (⌘Y),
  open/save .sql (⌘O/⌘S); single-table results with a primary key are editable
- **Info**: table/database sizes

## Layout

- `main/` — Electron main process: `db.js` (session: SSH, meta/aux/per-tab connections, schema loading, queries, edits, DDL), `store.js` (connections/history), `preload.js`
- `src/` — React renderer (bundled with esbuild to `dist/renderer.js`): `Workspace` (tabs + schema cache), `TabPane`, `ContentView`, `StructureView`, `QueryView`, `Grid`, `Editor`
- `renderer/` — `index.html`, `styles.css`

Data lives in `~/Library/Application Support/QRT/` (`connections.json`, `history.json`).

## Security

- **SSH host keys** are verified (OpenSSH-compatible: `~/.ssh/known_hosts`, hashed entries, `[host]:port`, wildcards, `@revoked`).
  Unknown hosts show the SHA256 fingerprint and must be trusted explicitly; a *changed* key is refused unless you
  explicitly trust the new one. Keys trusted in QRT are stored in `known_hosts.json`.
- **TLS modes** (like MySQL `--ssl-mode`): Disabled / Required (encrypt only) / Verify CA / Verify identity, with CA file and
  optional client cert/key. Identity is checked for IP hosts too, including through SSH tunnels.
- **Secrets never reach the UI process**: passwords are encrypted with the macOS Keychain (`safeStorage`) and resolved only in
  the main process; the UI just knows that one is saved. Nothing secret is ever written in plaintext.
- **History and open tabs are encrypted at rest** (`history.enc`, `tabs.enc`). Passwords written in statements
  (`IDENTIFIED BY`, `PASSWORD()`, `SOURCE_PASSWORD=`, `AES_ENCRYPT(…, key)` …) are masked before they are stored.
  History can be turned off and has a retention period (default 30 days).
- **Electron hardening**: context isolation + sandbox, CSP, UI served from a private `qrt://app` scheme (not `file://`),
  navigation locked to the app. Fuses in the packaged app: RunAsNode, `NODE_OPTIONS` and `--inspect` disabled,
  embedded ASAR integrity + only-load-from-asar enabled (a modified app refuses to start).
- Upgrading from older builds migrates plaintext data (old `history.json`, localStorage tabs) into the encrypted stores and deletes the plaintext.

Not covered yet: Apple code signing/notarization (the build is ad-hoc signed, so macOS asks for Keychain access again after each rebuild),
IPC sender validation, read-only/production-safe connection mode, auto-update.
