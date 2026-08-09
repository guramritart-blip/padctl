# padctl

Drive a Mac from a DualSense. Buttons run **shell commands**, post real
system-wide keystrokes and clicks, or type into a [herdr](https://github.com/) pane
so you can steer a coding agent from the couch.

One dependency (`node-hid`), a small Swift mouse helper, and a JSON file.

## Install

```bash
git clone <this repo> ~/padctl
cd ~/padctl
./install.sh
```

Then grant two permissions, described below. That step is not optional and the
failure mode is silent, so do it before deciding something is broken.

Requires macOS, node, and `swiftc` (`xcode-select --install`).

## Permissions, the part that wastes everyone's afternoon

macOS grants Accessibility to an **exact binary path**, not to a program. So:

- `install.sh` copies node into `~/padctl/bin/node` and points launchd at that
  copy. If it pointed at `/opt/homebrew/bin/node`, a `brew upgrade node` would
  silently revoke the grant and every hotkey would stop working with no error.
- You must grant **Accessibility** and **Input Monitoring** to
  `~/padctl/bin/node` specifically.

System Settings > Privacy & Security. Add it with `+`, using Cmd+Shift+G in the
file picker to paste the path.

`padctl.log` prints `accessibility OK` at startup, or a loud banner if not.
Buttons that only move the mouse will work regardless, which is exactly what
makes this confusing: **half of it working is the symptom.**

## Configuring

Edit `config.json` and save. It reloads live, no restart. Invalid JSON keeps the
last good config rather than crashing.

Three tables, in priority order:

| Table | When it applies |
|---|---|
| `l1_bindings` | Whenever L1 is held. Wins everywhere. |
| `desktop_bindings` | Frontmost app is **not** `terminal_bundle` |
| `bindings` | Everything else |

L1 is the layer modifier and can never be bound itself.

### Actions

| Type | Reach | Notes |
|---|---|---|
| `hotkey` | System-wide | Any app. `{key, modifiers}`. a-z, 0-9, arrows, enter, escape, or a raw key code. |
| `click` | System-wide | `{button: left\|right}` |
| `hold` | System-wide | Down on press, up on release. Tap = click, hold = **drag**. |
| `exec` | System-wide | Any shell command |
| `keys` | herdr pane only | Sends keystrokes to the focused agent pane |
| `text` | herdr pane only | Types a string, optionally submits |
| `workspace` | herdr only | `{dir: next\|prev}` |

`keys`, `text` and `workspace` need herdr. Without it, use `hotkey` and `exec`.
That's the whole reason `desktop_bindings` exists: `keys` can't leave the
terminal, `hotkey` can.

### Key repeat

```json
"dpad_down": { "type": "hotkey", "key": "down", "repeat": true }
```

Holding the button fires the action again, the way a held keyboard key behaves:
once immediately, then after 400ms, then every 60ms. Tune per binding with
`repeat_delay_ms` and `repeat_ms`.

Ignored on `hold` actions, which already mean something on release, and on
chords, where there is no single button to watch.

### Double swipes

```json
"swipe_up_x2": { "type": "hotkey", "key": "up", "modifiers": ["control"] }
```

Two swipes the same direction within 450ms. Any direction takes an `_x2`.

A direction only waits to see whether a second swipe is coming **if its `_x2` is
bound**, so directions without one stay instant. Bind both single and double for
the same direction and the single one necessarily gets a 450ms delay, which is
the cost of telling them apart.

### Chords

```json
"chords": { "l2+r2": { "type": "hotkey", "key": "2", "modifiers": ["command", "shift"] } }
```

Both presses must land within 140ms of each other **and** stay held 250ms.

The cost: any button named in a chord pays a 140ms delay on its own solo action,
because it has to wait and see whether a partner is coming. So chord buttons you
can afford to have feel slightly slow, and **never put a destructive action on a
chord of two buttons you already use constantly.** Ask how it fails when it fires
by accident, because it will.

## Editing the daemon

`config.json` hot-reloads. `padctl.js` does not:

```bash
launchctl kickstart -k gui/$(id -u)/com.g.padctl
```

Useful flags: `--dry` resolves bindings and logs them without firing anything,
`--debug` prints every press.

## Gotchas

- **node-hid opens the pad exclusively.** Any other program holding the
  controller (openmicro, some mappers, some games) means padctl gets
  `exclusive access and device already open` and goes deaf. It also loses the
  race on every restart, so if the pad dies right after a restart, look for the
  other program first.
- **Over Bluetooth the DualSense defaults to a short 10-byte report**: buttons
  only, no touchpad, no gyro. Every button works, so nothing looks broken.
  Reading the calibration feature report at connect switches it to the full
  78-byte report. Already handled, but that's what to check if touch input ever
  goes dead.
- **Don't swap the inline HID decoder for `dualsense-ts`.** It silently drops
  circle and square over Bluetooth.
- Actions with two halves (`hold`) key on the raw control id, never the log
  label. The layer and the frontmost app can both change while a button is down.

## Layout

```
padctl.js                    daemon: HID decode, binding resolution, actions
mousehelper.swift            resident mouse/scroll/drag driver (stdin protocol)
config.json                  your bindings (hot-reloaded)
config.example.json          herdr-free starting point
install.sh                   per-machine setup
com.g.padctl.plist.template  LaunchAgent, paths filled in at install
```

`node_modules/`, `bin/` and the compiled `mousehelper` are per-machine and not
in the repo. `install.sh` rebuilds all three.
