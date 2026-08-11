#!/bin/bash
# Builds L1R1.app: a window around the daemon.
#
# The bundle carries everything, including its own copy of node, so a person who
# downloads it never opens a terminal. Unsigned by default, which means Gatekeeper
# will warn on first open. Set SIGN_ID to a Developer ID to skip that.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build"
APP="$BUILD/L1R1.app"
RES="$APP/Contents/Resources"
RUNTIME="$RES/runtime"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

command -v swiftc >/dev/null || { echo "swiftc missing: xcode-select --install"; exit 1; }
command -v node >/dev/null || { echo "node missing: brew install node"; exit 1; }

say "Clearing $BUILD"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RUNTIME"

# ---------------------------------------------------------------- runtime
# The same daemon a terminal install runs. No fork, no second implementation.
say "Bundling the daemon"
for f in padctl.js package.json package-lock.json config.example.json; do
  cp "$ROOT/$f" "$RUNTIME/"
done
for d in lib ui scripts; do cp -R "$ROOT/$d" "$RUNTIME/$d"; done

if [ -d "$ROOT/node_modules" ]; then
  cp -R "$ROOT/node_modules" "$RUNTIME/node_modules"
else
  (cd "$RUNTIME" && npm install --omit=dev)
fi

mkdir -p "$RUNTIME/bin"
cp "$(node -e 'console.log(process.execPath)')" "$RUNTIME/bin/node"
chmod 755 "$RUNTIME/bin/node"

say "Building mousehelper"
swiftc -O -o "$RUNTIME/mousehelper" "$ROOT/mousehelper.swift"

# A bundled app writes its config next to itself, not into the repo.
[ -f "$RUNTIME/config.json" ] || cp "$RUNTIME/config.example.json" "$RUNTIME/config.json"

# ---------------------------------------------------------------- icon
say "Building the icon"
ICONSET="$BUILD/L1R1.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
SRC="$ROOT/ui/icon-512.png"
for size in 16 32 64 128 256 512; do
  sips -z $size $size "$SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/L1R1.icns"
rm -rf "$ICONSET"

# ---------------------------------------------------------------- binary
say "Compiling the app"
swiftc -O -o "$APP/Contents/MacOS/L1R1" "$ROOT/app/main.swift" \
  -framework AppKit -framework WebKit

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>L1R1</string>
  <key>CFBundleDisplayName</key><string>L1R1</string>
  <key>CFBundleIdentifier</key><string>com.g.l1r1</string>
  <key>CFBundleExecutable</key><string>L1R1</string>
  <key>CFBundleIconFile</key><string>L1R1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- Loopback only, but WKWebView still needs http allowed to reach it. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <key>NSHumanReadableCopyright</key><string>MIT</string>
</dict>
</plist>
PLIST

printf 'APPL????' > "$APP/Contents/PkgInfo"

if [ -n "${SIGN_ID:-}" ]; then
  say "Signing as $SIGN_ID"
  codesign --deep --force --options runtime --sign "$SIGN_ID" "$APP"
else
  # An ad-hoc signature keeps macOS from refusing to launch it at all on Apple
  # silicon. It does NOT remove the "unidentified developer" warning.
  say "Ad-hoc signing (unsigned build)"
  codesign --force --deep --sign - "$APP" 2>/dev/null || true
fi

SIZE=$(du -sh "$APP" | cut -f1)
cat <<EOF

Built $APP  ($SIZE)

  open "$APP"

First launch on another Mac will warn that the developer is unidentified.
Right-click the app and choose Open, or System Settings > Privacy & Security >
Open Anyway. That warning goes away only with a notarised build.

Accessibility and Input Monitoring still have to be granted, but to the app
itself now rather than to a copy of node in your home directory.
EOF
