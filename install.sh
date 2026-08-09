#!/bin/bash
# padctl installer. Safe to re-run; every step is idempotent.
#
# Rebuilds the three machine-specific pieces (native module, Swift helper,
# frozen node), writes the LaunchAgent for this machine's paths, starts it,
# then tells you which permissions to grant.

set -euo pipefail

PADCTL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.g.padctl"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

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
cd "$PADCTL"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---------------------------------------------------------------- frozen node
# macOS grants Accessibility to an exact binary path. Pointing launchd at
# /opt/homebrew/bin/node would mean a `brew upgrade node` silently revokes the
# grant and every hotkey dies with no error. So we keep our own copy.
say "Freezing a private copy of node"
mkdir -p "$PADCTL/bin"
REAL_NODE="$(node -e 'console.log(process.execPath)')"
if [ ! -f "$PADCTL/bin/node" ] || ! cmp -s "$REAL_NODE" "$PADCTL/bin/node"; then
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

# ---------------------------------------------------------------- launch agent
say "Writing the LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__PADCTL__|$PADCTL|g" -e "s|__HOME__|$HOME|g" \
  "$PADCTL/com.g.padctl.plist.template" > "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "  loaded $LABEL"

# ---------------------------------------------------------------- config
if [ ! -f "$PADCTL/config.json" ]; then
  cp "$PADCTL/config.example.json" "$PADCTL/config.json"
  say "Started you on config.example.json"
fi

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
EOF
