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
  for f in padctl.js mousehelper.swift permissions.swift package.json package-lock.json \
           com.g.padctl.plist.template config.example.json README.md LICENSE; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$PADCTL/$f"
  done
  for d in lib ui scripts; do
    [ -d "$SRC/$d" ] && { rm -rf "${PADCTL:?}/$d"; cp -R "$SRC/$d" "$PADCTL/$d"; }
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

# The daemon spawns this to raise the real macOS permission dialogs. See the
# header of permissions.swift for why it can't be run from here.
say "Building the permission helper"
swiftc -O -o "$PADCTL/permissions" "$PADCTL/permissions.swift"

# ---------------------------------------------------------------- config
# Built for this machine rather than copied: it reads your real screenshot,
# spaces and Mission Control shortcuts out of your own settings, and only binds
# apps it can actually find. Falls back to the example if anything goes wrong.
if [ ! -f "$PADCTL/config.json" ]; then
  say "Building a config for this machine"
  if ! "$PADCTL/bin/node" "$PADCTL/scripts/init-config.js"; then
    cp "$PADCTL/config.example.json" "$PADCTL/config.json"
    echo "  fell back to config.example.json"
  fi
fi

# ---------------------------------------------------------------- launch agent
say "Writing the LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__PADCTL__|$PADCTL|g" -e "s|__HOME__|$HOME|g" \
  "$PADCTL/com.g.padctl.plist.template" > "$PLIST"

# The log is appended across runs, so remember where this run starts. Otherwise
# an "accessibility OK" from last week counts as today's verdict.
LOG="$PADCTL/padctl.log"
LOG_MARK=1
[ -f "$LOG" ] && LOG_MARK=$(( $(wc -c < "$LOG") + 1 ))

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "  loaded $LABEL"

# ---------------------------------------------------------------- permissions
# Deliberately not asked for from this script. macOS grants to the *responsible*
# process, which from a shell is Terminal or Warp — it would grant that and
# leave the daemon broken. The daemon asks for itself a few seconds after it
# starts, so all this does is wait for the answer.
say "Permissions"
echo "  The daemon is asking macOS now. Approve the dialogs if they appear."
echo "  (If you've already granted these, this passes straight through.)"

verdict=""
for _ in $(seq 1 90); do
  tail -c "+$LOG_MARK" "$LOG" 2>/dev/null > /tmp/padctl-install-tail.$$ || true
  if grep -q "accessibility OK\|^\[.*\] permissions granted" /tmp/padctl-install-tail.$$ 2>/dev/null; then
    verdict=granted; break
  fi
  if grep -q "PERMISSIONS MISSING" /tmp/padctl-install-tail.$$ 2>/dev/null; then
    verdict=asked
  fi
  sleep 1
done
rm -f /tmp/padctl-install-tail.$$

if [ "$verdict" = "granted" ]; then
  printf '  \033[1mBoth granted.\033[0m\n'
else
  cat <<EOF

$(printf '\033[1mStill waiting on two permissions, for this exact binary:\033[0m')

  $PADCTL/bin/node

System Settings should already be open at the right pane. If not:

  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"

Note this is Privacy & Security > Accessibility, NOT the Accessibility pane in
the sidebar — macOS has two things by that name and only this one grants.

Add the binary with the "+" button (Cmd+Shift+G in the picker, paste the path
above), then make sure the toggle is ON. Adding it does not always enable it.

The daemon is watching and restarts itself the moment both land, so there is
nothing to run afterwards.
EOF
fi

cat <<EOF

Pair the DualSense over Bluetooth (hold PS + Create until the bar flashes) and
watch it come up:

  tail -f $LOG

You want "controller connected" and "accessibility OK".

The configurator is at http://127.0.0.1:7757 — press a button on the pad and it
selects there. Reopen it any time with:

  node $PADCTL/scripts/open-ui.js
EOF

# Opening it is the friendlier last step than a wall of text, but only once the
# daemon is actually serving, so give it a moment to come up.
if [ -z "${PADCTL_NO_OPEN:-}" ]; then
  ( sleep 3; "$PADCTL/bin/node" "$PADCTL/scripts/open-ui.js" >/dev/null 2>&1 || true ) &
fi
