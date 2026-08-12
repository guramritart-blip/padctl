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

Two permissions are needed. The daemon asks macOS for them a few seconds after
it starts, so you should get the real system dialogs and System Settings opened
at the right pane without looking anything up.

Requires macOS, node, and `swiftc` (`xcode-select --install`).

## Permissions, the part that wastes everyone's afternoon

macOS grants Accessibility to an **exact binary path**, not to a program. So:

- `install.sh` copies node into `~/padctl/bin/node` and points launchd at that
  copy. If it pointed at `/opt/homebrew/bin/node`, a `brew upgrade node` would
  silently revoke the grant and every hotkey would stop working with no error.
- **Accessibility** and **Input Monitoring** both have to land on
  `~/padctl/bin/node` specifically.

You shouldn't have to do that by hand. The daemon spawns `permissions request`
at startup, which raises the real macOS dialogs and opens the two panes. Once
you flip the switches it notices within about three seconds and restarts itself,
so there is no `kickstart` step to remember.

Two things that catch people when doing it manually anyway:

- It's **Privacy & Security > Accessibility**, not the Accessibility pane in the
  sidebar. macOS has two unrelated things by that name and only one of them
  grants anything.
- Adding a binary with `+` does not always switch it **on**. Check the toggle.

`padctl.log` prints `accessibility OK` at startup, or a loud banner if not.
Buttons that only move the mouse will work regardless, which is exactly what
makes this confusing: **half of it working is the symptom.**

### Why the installer doesn't ask

macOS attributes a permission request to the *responsible* process, which is the
top-level app rather than whichever binary made the call. Ask from `install.sh`
and the responsible process is Terminal or Warp, so macOS grants **that** and
leaves the daemon exactly as broken while appearing to have worked. Under
launchd there is no terminal in the chain, so the request lands on
`~/padctl/bin/node` where it belongs. That is the entire reason the asking lives
in the daemon and the installer only waits for the verdict.

## The configurator

The daemon serves one, on loopback:

```
http://127.0.0.1:7757
```

**Press a button on the controller and the page selects it.** The daemon already
sees every press, so binding never means hunting through a dropdown. Shortcut
fields work the same way: click, then press the keys you want.

It's served by the daemon rather than from a website on purpose. A page on
`https://` talking to `http://127.0.0.1` runs into mixed-content blocking, CORS
and Chrome's private-network rules, each breaking differently per browser. Same
origin has none of those problems.

Turn it off or move it with `"ui": { "enabled": false }` or `"ui": { "port": 7788 }`.

**Install it as a window.** In Chrome, install it from the address bar; Safari
calls it Add to Dock. You get a standalone window with its own Dock icon and no
browser chrome. `localhost` counts as a secure context, so this needs no
certificate, no notarisation and no developer account. It only works while the
daemon is running, since the daemon is what serves it.

Reopen it any time:

```bash
node scripts/open-ui.js
```

Or from the pad. First run binds **L1 + Options** to open it.

### Behaviour

In the configurator, or in `config.json` directly:

```json
"behaviour": {
  "on_connect": { "type": "exec", "cmd": "open -a Warp" },
  "on_disconnect": { "type": "exec", "cmd": "osascript -e 'display notification \"pad gone\"'" }
}
```

**Start at login** is the LaunchAgent's `RunAtLoad`, toggled from the
configurator. Turning it off only changes what happens at your *next* login;
whatever is running now keeps running. Pointer and scroll speed are sliders in
the same panel.

## Configuring

Edit `config.json` and save. It reloads live, no restart. Invalid JSON keeps the
last good config rather than crashing.

### Your shortcuts, not ours

On first run the installer writes a config **for your machine**, and the
configurator can rebuild it any time.

- **System shortcuts are read from your settings.** Screenshot, Mission Control
  and space-switching are all remappable, and macOS keeps the real values in
  `com.apple.symbolichotkeys`. padctl reads them, so the screenshot chord fires
  *your* combination. If you've switched one off entirely, it stays unbound.
- **App bindings appear only if the app is there.** No herdr means no pane
  targeting, so those controls are left out rather than bound to something that
  silently fails. Same for the dictation button.
- **Whatever gets left out says why**, in the configurator and in the installer
  output. An unbound button is honest. A bound button that does nothing is a bug
  report.

Rebuild it yourself with:

```bash
node scripts/init-config.js --force   # keeps your old one as config.json.bak
```

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
| `agent` | herdr only | `{dir: next\|prev}`. Cycles agent panes only — several in one workspace are all separate stops, and workspaces with no agent are skipped. |

`keys`, `text`, `workspace` and `agent` need herdr. Without it, use `hotkey` and `exec`.
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
