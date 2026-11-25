#!/usr/bin/env bash
# QRT launcher.
#   ./start.sh           run in dev mode (builds the UI bundle, then starts Electron)
#   ./start.sh app       open the packaged Q-Bit.app (builds it first if missing or out of date)
#   ./start.sh build     build release/mac-<arch>/Q-Bit.app
#   ./start.sh dmg       build release/QRT-<version>-<arch>.dmg (+ .zip) for installing / sharing
#   ./start.sh watch     dev mode + rebuild the UI bundle on every change (⌘R in the app to reload)
set -euo pipefail

cd "$(dirname "$0")"

# VS Code's integrated terminal exports this; with it set Electron starts as plain Node and no window appears.
unset ELECTRON_RUN_AS_NODE

ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH="x64"
APP="release/mac-${ARCH}/Q-Bit.app"

die() { echo "start.sh: $*" >&2; exit 1; }

node_works() { command -v node >/dev/null 2>&1 && node -v >/dev/null 2>&1; }

# Find a Node that actually runs. The shell may not have loaded ~/.zshrc (Finder, other tools),
# and an Intel-only Homebrew node in /usr/local fails on Apple Silicon without Rosetta.
find_node() {
  node_works && return 0
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" --no-use
    nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
    node_works && return 0
  fi
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
    if [ -x "$dir/node" ] && "$dir/node" -v >/dev/null 2>&1; then
      export PATH="$dir:$PATH"
      return 0
    fi
  done
  return 1
}

ensure_deps() {
  find_node || die "Node.js not found (install it, or nvm install --lts)"
  echo "→ Using node $(node -v)"
  if [ ! -d node_modules ]; then
    echo "→ Installing dependencies…"
    npm install
  fi
  # npm may skip Electron's download script (install-scripts policy); fetch the binary if it's missing.
  if [ ! -f node_modules/electron/path.txt ] || [ ! -d node_modules/electron/dist ]; then
    echo "→ Downloading Electron…"
    node node_modules/electron/install.js
  fi
}

build_ui() {
  echo "→ Building UI bundle…"
  npm run --silent build:renderer
}

# The packaged app is stale if any source file is newer than it.
app_is_stale() {
  [ ! -d "$APP" ] && return 0
  [ -n "$(find main src renderer package.json -newer "$APP/Contents/Info.plist" -print -quit 2>/dev/null)" ]
}

build_app() {
  ensure_deps
  echo "→ Building $APP …"
  npm run --silent app
  echo "✓ Built $APP"
}

case "${1:-dev}" in
  dev)
    ensure_deps
    build_ui
    echo "→ Starting QRT (dev)…"
    exec ./node_modules/.bin/electron .
    ;;
  watch)
    ensure_deps
    build_ui
    npm run --silent watch &
    WATCH_PID=$!
    trap 'kill $WATCH_PID 2>/dev/null' EXIT
    echo "→ Starting QRT (dev, watching src/)…"
    ./node_modules/.bin/electron .
    ;;
  app)
    if app_is_stale; then build_app; fi
    echo "→ Opening $APP"
    open "$APP"
    ;;
  build)
    build_app
    ;;
  dmg)
    ensure_deps
    echo "→ Building DMG…"
    npm run --silent dist
    echo "✓ $(ls -t release/*.dmg | head -1)"
    ;;
  -h|--help|help)
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    die "unknown command '$1' (use: dev | app | build | dmg | watch)"
    ;;
esac
