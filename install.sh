#!/bin/bash
# padctl installer. Safe to re-run; every step is idempotent.
#
#   curl -fsSL https://raw.githubusercontent.com/guramritart-blip/padctl/main/install.sh | bash
#   ./install.sh                    (from a checkout)
#   PADCTL_HOME=~/.padctl ./install.sh
#
# Rebuilds the three machine-specific pieces (native module, Swift helper,
# frozen node), writes the LaunchAgent for this machine's paths, starts it,
# then tells you which permissions to grant.

set -euo pipefail

REPO="https://github.com/guramritart-blip/padctl.git"
LABEL="com.g.padctl"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- locate source
# Are we sitting in a checkout, or being piped in from curl with nothing around us?
SRC=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  maybe="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  [ -n "$maybe" ] && [ -f "$maybe/padctl.js" ] && SRC="$maybe"
fi

if [ -z "$SRC" ]; then
  command -v git >/dev/null || { echo "git is required to bootstrap. Install Xcode CLT: xcode-select --install"; exit 1; }
  TARGET="${PADCTL_HOME:-$HOME/padctl}"
  say "Fetching padctl into $TARGET"
  if [ -d "$TARGET/.git" ]; then
    git -C "$TARGET" pull --ff-only
  else
    git clone --depth 1 "$REPO" "$TARGET"
  fi
  exec bash "$TARGET/install.sh"
fi

# Where padctl actually runs from. Usually the checkout itself. It differs for
# `brew install`, where the source lands in a versioned Cellar path that changes
# on every upgrade. Accessibility is granted per path, so the runtime needs a
# home that never moves.
PADCTL="${PADCTL_HOME:-$SRC}"

if [ "$PADCTL" != "$SRC" ]; then
  say "Installing runtime to $PADCTL"
  mkdir -p "$PADCTL"
  # config.json is deliberately not copied. It belongs to whoever's checkout
  # this is, and a fresh install should start from the example rather than
  # inherit someone else's bindings, half of which reference tools you may
  # not have.
  for f in padctl.js mousehelper.swift package.json package-lock.json \
           com.g.padctl.plist.template config.example.json README.md; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$PADCTL/$f"
  done
fi

cd "$PADCTL"

# ---------------------------------------------------------------- prereqs
missing=()
command -v node >/dev/null || missing+=("node (brew install node)")
command -v npm  >/dev/null || missing+=("npm (comes with node)")
command -v swiftc >/dev/null || missing+=("swiftc (xcode-select --install)")
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing prerequisites:"
  printf '  - %s\n' "${missing[@]}"
  exit 1
fi

# ---------------------------------------------------------------- deps
say "Installing node-hid (native, must be built on this machine)"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---------------------------------------------------------------- frozen node
# macOS grants Accessibility to an exact binary path. Pointing launchd at
# /opt/homebrew/bin/node would mean a `brew upgrade node` silently revokes the
# grant and every hotkey dies with no error. So we keep our own copy.
say "Freezing a private copy of node"
mkdir -p "$PADCTL/bin"
REAL_NODE="$(node -e 'console.log(process.execPath)')"
if [ ! -f "$PADCTL/bin/node" ] || ! cmp -s "$REAL_NODE" "$PADCTL/bin/node"; then
  rm -f "$PADCTL/bin/node"
  cp "$REAL_NODE" "$PADCTL/bin/node"
  chmod 555 "$PADCTL/bin/node"
  echo "  copied $REAL_NODE"
else
  echo "  already current"
fi

# ---------------------------------------------------------------- swift helper
# A resident process taking deltas on stdin. Spawning one per frame stutters.
say "Building mousehelper"
# Can't overwrite a running binary, so stop the daemon first if it's up.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "$PADCTL/mousehelper" 2>/dev/null || true
sleep 1
swiftc -O -o "$PADCTL/mousehelper" "$PADCTL/mousehelper.swift"

# ---------------------------------------------------------------- config
if [ ! -f "$PADCTL/config.json" ]; then
  cp "$PADCTL/config.example.json" "$PADCTL/config.json"
  say "Started you on config.example.json"
fi

# ---------------------------------------------------------------- launch agent
say "Writing the LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__PADCTL__|$PADCTL|g" -e "s|__HOME__|$HOME|g" \
  "$PADCTL/com.g.padctl.plist.template" > "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "  loaded $LABEL"

# ---------------------------------------------------------------- permissions
cat <<EOF

$(printf '\033[1mAlmost done. Two permissions, granted to this exact binary:\033[0m')

  $PADCTL/bin/node

System Settings > Privacy & Security >
  - Accessibility       (required, or hotkeys silently do nothing)
  - Input Monitoring    (required to read the controller)

Add the binary with the + button. Cmd+Shift+G in the file picker, then paste
the path above. After granting, restart it:

  launchctl kickstart -k gui/$(id -u)/$LABEL

Then pair the DualSense over Bluetooth (hold PS + Create until the bar flashes)
and watch it come up:

  tail -f $PADCTL/padctl.log

You want to see "controller connected" and "accessibility OK".

Edit $PADCTL/config.json to rebind. It reloads live, no restart.
EOF
