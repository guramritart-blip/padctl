# Where this is up to

Working notes for picking this back up. The README explains how the thing works;
this file is only what's done, what isn't, and what's undecided.

## What it is now

**L1R1** (the repo is still called `padctl`, see the open decisions). A DualSense
drives macOS: mouse, keyboard, clipboard, and a different set of bindings per app.

Three ways to run it, all the same daemon:

| | |
|---|---|
| `./install.sh` | terminal install, LaunchAgent, hot-reloading config |
| `http://127.0.0.1:7757` | the configurator, served by the daemon |
| `./scripts/build-app.sh` | `build/L1R1.app`, a real window around that same UI |

## Built, working, tested

- **Bindings** with `hotkey`, `click`, `hold`, `exec`, `keys`, `text`, `workspace`
- **Tap vs hold** as separate actions on one control (350ms). Writes the cheapest
  form: tap-click + hold-drag stays a single `hold`, "repeat" stays the `repeat`
  flag, and `{tap, hold}` is only used when it's genuinely two actions
- **Key repeat** while held, 400ms then every 60ms
- **Chords** (`l2+r2`), 140ms simultaneity plus a 250ms hold so they can't misfire
- **Double swipes** (`swipe_up_x2`), and a direction only pays the wait if its
  `_x2` is bound
- **Per-app profiles**, matched on the frontmost bundle id. Ships herdr, Warp and
  Lightroom. `requires: 'herdr'` keeps a profile dormant until its tool exists
- **Reads your real macOS shortcuts** out of `com.apple.symbolichotkeys`, so the
  screenshot chord fires whatever *you* have set, and stays unbound if you
  disabled it
- **Only binds apps it can find**, and says why when it leaves something out
- **The configurator**: press-to-bind, shortcut capture, profile rail, live log,
  start-at-login, connect/disconnect actions, pointer and scroll speed
- **L1R1.app**: bundles node and the daemon, attaches to an already-running
  daemon rather than starting a second one, and only stops what it started

## Not done

1. **`.dmg` and notarisation.** The app is ad-hoc signed, so other Macs show the
   unidentified-developer warning. Needs the $99/yr Apple Developer Program, then
   the landing page's install command becomes a Download button.
2. **Homebrew tap.** Deliberately not created, because the formula name is the
   product name and that isn't settled.
3. **The Lightroom profile is untested against Lightroom.** The bindings are
   right on paper (`p` pick, `x` reject, `u` unflag, arrows, `1`-`5` on the L1
   layer) but nobody has culled with it yet. Bundle ids may need adding.
4. **The landing page still shows a `curl` command** pointing at `l1r1.sh`, a
   domain that doesn't exist. Either register it or put the GitHub raw URL back.

## Open decisions

- **The name is L1R1**, and the repo is still `padctl`. Renaming means the repo,
  the install URL, the LaunchAgent label (`com.g.padctl`) and the setup prompt.
  GitHub keeps redirects, so nothing breaks the moment it happens.
- **The domain.** Every real word is taken; nothing has been bought. My DNS and
  whois checks from here were both unreliable, so check at a registrar.
- **What the product is.** The agent angle is novel but the audience is thin.
  Lightroom culling points at photographers, who are an audience you already
  have. Whichever one gets the demo video decides what this becomes.
- **Free or paid.** Current thinking: the CLI stays free and open, and the paid
  thing is the signed app, because that's the work people can't do themselves.

## Where things live

```
padctl.js                 the daemon: HID decode, resolution, actions
lib/                      shortcuts reader, app detection, config builder, UI server
ui/index.html             the configurator
app/main.swift            the window that wraps it
scripts/build-app.sh      builds build/L1R1.app
scripts/init-config.js    writes a config that fits this machine
site/index.html           landing page
site/brand.html           brand sheet, with a live palette switcher
configs/g.json            my personal config; config.json itself is gitignored
```

Longer history is in `~/brain/logs/2026-08-08.md` and
`~/brain/decisions/2026-08-08-padctl-git-repo-and-sharing.md`.

## If the controller stops working

1. `tail ~/padctl/padctl.log`. A dropped pad now logs the reason.
2. `pgrep -fl openmicro` — it opens the pad exclusively and wins the race on any
   restart. It's uninstalled, but a stale shell can still resurrect things.
3. `launchctl kickstart -k gui/$(id -u)/com.g.padctl`
