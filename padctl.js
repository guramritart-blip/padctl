#!/usr/bin/env node
// padctl — DualSense -> shell actions. No openmicro, no ControllerKeys.
//
// Why this exists: openmicro can only write bytes into a Claude PTY, and
// ControllerKeys can only forge keystrokes. Neither can run a command, which is
// what Spokenly (spokenly:// URL) and herdr workspace-back both need.
// Every action here dispatches to a shell, so both are reachable.
//
// HID is decoded inline rather than via dualsense-ts: that library silently
// dropped circle and square on this pad over Bluetooth, while the raw report
// showed both bits cleanly (circle 0x40, square 0x10 in byte 9). Offsets below
// are the standard DualSense layout, verified against a live capture.

const { execFile, exec, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const HID = require('node-hid')
const ui = require('./lib/ui')

const VENDOR_ID = 0x054c
const PRODUCT_ID = 0x0ce6
const CONFIG_PATH = path.join(__dirname, 'config.json')
const DEBUG = process.argv.includes('--debug')
// --dry logs what each press *would* do without firing it. Use it to verify a
// mapping before letting destructive bindings (/clear, ctrl+c) run for real.
const DRY = process.argv.includes('--dry')

function log(msg) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`
  console.log(line)
  ui.activity(line) // no-op until the configurator is open
}

// ---------------------------------------------------------------- config

let config = { bindings: {}, l1_bindings: {}, mouse: null }

function loadConfig() {
  try {
    const next = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    config = {
      bindings: next.bindings ?? {},
      l1_bindings: next.l1_bindings ?? {},
      desktop_bindings: next.desktop_bindings ?? {},
      terminal_bundle: next.terminal_bundle ?? 'dev.warp.Warp-Stable',
      mouse: next.mouse ?? null,
      scroll: next.scroll ?? null,
      chords: next.chords ?? {},
      ui: next.ui ?? {},
      behaviour: next.behaviour ?? {},
    }
    const n = Object.keys(config.bindings).length + Object.keys(config.l1_bindings).length
    log(`config loaded (${n} bindings)`)
  } catch (err) {
    // Keep the last good config in memory rather than dying on a typo.
    log(`config INVALID, keeping previous: ${err.message}`)
  }
}

let reloadTimer = null
fs.watch(CONFIG_PATH, () => {
  // Editors write then rename, firing twice. Debounce.
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(loadConfig, 120)
})

// ---------------------------------------------------------------- herdr

function herdr(args) {
  return new Promise((resolve) => {
    execFile('herdr', args, { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        resolve(JSON.parse(stdout).result)
      } catch {
        resolve(null)
      }
    })
  })
}

// The pane the user is looking at, which is where keys/text should land.
// Cached briefly so a burst of presses doesn't spawn a herdr call each time.
let paneCache = { id: null, at: 0 }
async function focusedPane() {
  if (paneCache.id && Date.now() - paneCache.at < 500) return paneCache.id
  const res = await herdr(['pane', 'list'])
  const pane = res?.panes?.find((p) => p.focused)
  if (pane) paneCache = { id: pane.pane_id, at: Date.now() }
  return pane?.pane_id ?? null
}

async function switchWorkspace(dir) {
  const res = await herdr(['workspace', 'list'])
  const list = res?.workspaces
  if (!list?.length) return log('workspace: herdr returned nothing')

  // `number` is display order; `focused` marks the current one.
  const sorted = [...list].sort((a, b) => a.number - b.number)
  const cur = sorted.findIndex((w) => w.focused)
  if (cur === -1) return log('workspace: none focused')

  const step = dir === 'prev' ? -1 : 1
  const next = sorted[(cur + step + sorted.length) % sorted.length]
  await herdr(['workspace', 'focus', next.workspace_id])
  log(`workspace -> ${next.number}. ${next.label}`)
}

// ---------------------------------------------------------------- actions

// macOS virtual key codes, for the `hotkey` action. A raw number also works.
const KEY_CODES = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  right_option: 61,
  // Digits and letters are not in ASCII order in the ANSI layout, hence the
  // scattered codes. Full a-z here so any cmd+<letter> works without a code edit.
  0: 29, 1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 25,
  a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38, k: 40, l: 37, m: 46,
  n: 45, o: 31, p: 35, q: 12, r: 15, s: 1, t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
}

// Key repeat. `"repeat": true` on an action makes holding the button fire it
// again on a delay, the way a held keyboard key behaves. Worth it for anything
// you'd naturally hold down: arrows, backspace, escape.
const REPEAT_DELAY_MS = 400
const REPEAT_MS = 60
const activeRepeats = new Map()

function stopRepeat(id) {
  const r = activeRepeats.get(id)
  if (!r) return
  clearTimeout(r.timeout)
  clearInterval(r.interval)
  activeRepeats.delete(id)
}

function stopAllRepeats() {
  for (const id of [...activeRepeats.keys()]) stopRepeat(id)
}

function startRepeat(action, control, id) {
  stopRepeat(id)
  const entry = {}
  entry.timeout = setTimeout(() => {
    entry.interval = setInterval(() => {
      // The release path clears this, but a dropped release (pad disconnect,
      // config reload mid-press) would otherwise repeat forever.
      if (!buttonState[id]) return stopRepeat(id)
      runOnce(action, control, id)
    }, action.repeat_ms ?? REPEAT_MS)
  }, action.repeat_delay_ms ?? REPEAT_DELAY_MS)
  activeRepeats.set(id, entry)
}

// `control` is the decorated label used for logging ("south [desktop:com.foo]").
// `id` is the raw control name, which is what release-tracking has to key on,
// since by the time the button comes up the layer or frontmost app may differ.
async function run(action, control, id = control) {
  await runOnce(action, control, id)

  // `hold` already has press/release semantics of its own, and a chord id is not
  // a real button so there'd be nothing to watch for release.
  if (action?.repeat && action.type !== 'hold' && !DRY && buttonState[id]) {
    startRepeat(action, control, id)
  }
}

async function runOnce(action, control, id = control) {
  if (!action) return
  if (DRY) return log(`${control} -> [dry] ${JSON.stringify(action)}`)

  switch (action.type) {
    case 'exec':
      exec(action.cmd, (err) => {
        if (err) log(`exec failed (${control}): ${err.message}`)
      })
      log(`${control} -> exec ${action.cmd}`)
      break

    case 'keys': {
      const pane = await focusedPane()
      if (!pane) return log(`${control} -> keys: no focused pane`)
      await herdr(['pane', 'send-keys', pane, ...action.keys])
      log(`${control} -> keys ${action.keys.join(' ')} @ ${pane}`)
      break
    }

    case 'text': {
      const pane = await focusedPane()
      if (!pane) return log(`${control} -> text: no focused pane`)
      await herdr(['pane', 'send-text', pane, action.text])
      if (action.submit !== false) await herdr(['pane', 'send-keys', pane, 'enter'])
      log(`${control} -> text "${action.text.slice(0, 40)}"`)
      break
    }

    case 'workspace':
      await switchWorkspace(action.dir)
      break

    // Unlike `keys` (which targets a herdr pane, so Claude Code only), this
    // posts a real system-wide keypress and works in any app.
    case 'hotkey': {
      const code = typeof action.key === 'number' ? action.key : KEY_CODES[action.key]
      if (code === undefined) return log(`${control} -> hotkey: unknown key "${action.key}"`)
      const mods = (action.modifiers ?? []).map((m) => `${m} down`).join(', ')
      const using = mods ? ` using {${mods}}` : ''
      exec(
        `osascript -e 'tell application "System Events" to key code ${code}${using}'`,
        (err) => {
          if (err) log(`hotkey failed (${control}): ${err.message}`)
        }
      )
      log(`${control} -> hotkey ${action.key}${mods ? ` (${mods})` : ''}`)
      break
    }

    case 'click':
      mouseSend(`c ${action.button ?? 'left'}`)
      log(`${control} -> click ${action.button ?? 'left'}`)
      break

    // Press now, release when the physical button comes up. A quick tap is
    // therefore an ordinary click; keeping it down turns stick movement into a
    // drag. Strictly better than `click` for any button you'd point with.
    case 'hold': {
      const button = action.button ?? 'left'
      // Resolving the binding is async (frontmost-app lookup), so a fast tap can
      // be fully released before we get here. Pressing down now would strand the
      // button, since the release already came and went. Emit a click instead.
      if (!buttonState[id]) {
        mouseSend(`c ${button}`)
        log(`${control} -> click ${button} (tap)`)
        break
      }
      activeHolds.set(id, button)
      mouseSend(`d ${button}`)
      log(`${control} -> hold ${button}`)
      break
    }

    default:
      log(`${control} -> unknown action type "${action.type}"`)
  }
}

// ---------------------------------------------------------------- mouse

// A resident Swift helper takes deltas on stdin. Spawning a process per frame
// would stutter; this stays open and streams.
const HELPER_PATH = path.join(__dirname, 'mousehelper')
let helper = null

function mouseHelper() {
  if (helper) return helper
  if (!fs.existsSync(HELPER_PATH)) return null
  try {
    helper = spawn(HELPER_PATH, { stdio: ['pipe', 'ignore', 'ignore'] })
    helper.on('exit', () => {
      helper = null // respawned lazily on next use
    })
    helper.stdin.on('error', () => {})
  } catch (err) {
    log(`mouse helper failed: ${err.message}`)
    helper = null
  }
  return helper
}

function mouseSend(line) {
  const h = mouseHelper()
  if (h?.stdin.writable) h.stdin.write(line + '\n')
}

// Squaring the deflection gives fine control near centre and speed at the edge.
// Shared by pointer movement and scrolling, which differ only in the command
// they emit and which way Y points.
function stickVector(cfg, defaultStick) {
  if (!cfg || DRY || l1Held) return null // L1 held = stick is doing flick bindings
  const s = sticks[cfg.stick ?? defaultStick]
  if (!s) return null

  const dead = cfg.deadzone ?? 0.15
  const mag = Math.hypot(s.x, s.y)
  if (mag < dead) return null

  const scale = ((mag - dead) / (1 - dead)) ** 2 * (cfg.speed ?? 22)
  return { x: (s.x / mag) * scale, y: (s.y / mag) * scale }
}

function pump() {
  if (!device) return // nothing to read from, so nothing to move
  const m = stickVector(config.mouse, 'lstick')
  if (m) mouseSend(`m ${m.x.toFixed(2)} ${(-m.y).toFixed(2)}`) // screen Y grows downward

  const sc = stickVector(config.scroll, 'rstick')
  if (sc) {
    const dir = config.scroll?.invert ? -1 : 1
    mouseSend(`s ${(-sc.x * dir).toFixed(0)} ${(sc.y * dir).toFixed(0)}`)
  }
}

setInterval(pump, 16) // ~60Hz

let l1Held = false

// Which app is in front decides whether a press means "Claude Code" or
// "desktop". Cached briefly so a burst of presses doesn't re-shell each time.
let frontCache = { id: null, at: 0 }
function frontmostBundle() {
  return new Promise((resolve) => {
    if (frontCache.id && Date.now() - frontCache.at < 250) return resolve(frontCache.id)
    exec(
      'lsappinfo info -only bundleid "$(lsappinfo front)"',
      { timeout: 1500 },
      (err, stdout) => {
        if (err) return resolve(null)
        const m = stdout.match(/"CFBundleIdentifier"="([^"]+)"/)
        frontCache = { id: m?.[1] ?? null, at: Date.now() }
        resolve(frontCache.id)
      }
    )
  })
}

// Chords ("l2+r2"). A button that takes part in a chord has its solo action held
// back briefly, so pressing the pair doesn't also fire each half. Buttons not in
// any chord are unaffected and stay instant.
//
// Two guards, both learned the hard way. The presses must land within CHORD_MS of
// each other, so holding one button and using the other later is NOT a chord. And
// once a pair looks complete, both must stay down for CHORD_HOLD_MS before it runs,
// so a fumbled roll doesn't fire something destructive.
const CHORD_MS = 140
const CHORD_HOLD_MS = 250
const pendingSolo = new Map()
const pressedAt = {}

// control id -> mouse button currently held down by a `hold` action. Keyed by the
// button that started it, so the release doesn't care whether the layer or the
// frontmost app changed while it was down.
const activeHolds = new Map()

async function releaseButton(id) {
  stopRepeat(id)

  // A chord participant tapped and let go before its window expired: resolve the
  // solo action now rather than dropping it.
  const pending = pendingSolo.get(id)
  if (pending) {
    clearTimeout(pending)
    pendingSolo.delete(id)
    await fireSolo(id)
  }

  const button = activeHolds.get(id)
  if (button) {
    activeHolds.delete(id)
    mouseSend(`u ${button}`)
    log(`${id} -> release ${button}`)
  }

  // A hold started by a chord is keyed by the chord string ("l2+r2"), since no
  // single button owns it. Letting go of either half has to lift it.
  for (const [key, held] of activeHolds) {
    if (key.includes('+') && key.split('+').includes(id)) {
      activeHolds.delete(key)
      mouseSend(`u ${held}`)
      log(`${key} -> release ${held}`)
    }
  }
}

function releaseAllHolds() {
  for (const [id, button] of activeHolds) {
    mouseSend(`u ${button}`)
    log(`${id} -> release ${button} (reset)`)
  }
  activeHolds.clear()
}

function chordKeys() {
  return Object.keys(config.chords ?? {})
}

async function fire(id) {
  const chords = chordKeys()
  const involved = chords.filter((k) => k.split('+').includes(id))

  if (involved.length) {
    const now = Date.now()
    const complete = involved.find((k) =>
      k.split('+').every((p) => buttonState[p] && now - (pressedAt[p] ?? 0) <= CHORD_MS)
    )
    if (complete) {
      const parts = complete.split('+')
      // Cancel the half-pressed solo actions this chord swallowed.
      for (const p of parts) {
        clearTimeout(pendingSolo.get(p))
        pendingSolo.delete(p)
      }
      await new Promise((r) => setTimeout(r, CHORD_HOLD_MS))
      if (!parts.every((p) => buttonState[p])) {
        log(`${complete} released early, ignored`)
        return
      }
      return run(config.chords[complete], complete)
    }
    clearTimeout(pendingSolo.get(id))
    pendingSolo.set(
      id,
      setTimeout(() => {
        pendingSolo.delete(id)
        fireSolo(id)
      }, CHORD_MS)
    )
    return
  }

  return fireSolo(id)
}

async function fireSolo(id) {
  if (id === 'l1') return // L1 is the layer modifier, never an action itself

  // L1 layer wins outright, so the modifier behaves the same everywhere.
  if (l1Held) {
    if (DEBUG) log(`PRESS ${id} (L1 held)`)
    return run(config.l1_bindings[id], `L1+${id}`, id)
  }

  const desktop = config.desktop_bindings ?? {}
  let table = config.bindings
  let label = id
  if (Object.keys(desktop).length) {
    const front = await frontmostBundle()
    const terminal = config.terminal_bundle ?? 'dev.warp.Warp-Stable'
    label = `${id} [front=${front ?? 'UNKNOWN'}]`
    if (front && front !== terminal && desktop[id]) {
      table = desktop
      label = `${id} [desktop:${front}]`
    }
  }

  if (DEBUG) log(`PRESS ${label}`)
  run(table[id], label, id)
}

// ---------------------------------------------------------------- decoding

// Report 0x31 is Bluetooth full mode, 0x01 with a long buffer is USB. They share
// one layout, Bluetooth just shifted one byte later. Short 0x01 is the reduced
// Bluetooth report the pad sends before it is put into full mode.
function offsets(buf) {
  const id = buf[0]
  if (id === 0x31 && buf.length >= 40) return { lx: 2, buttons: 9, trig: 6 }
  if (id === 0x01 && buf.length >= 40) return { lx: 1, buttons: 8, trig: 5 }
  if (id === 0x01) return { lx: 1, buttons: 5, trig: 8 }
  return null
}

const FACE = { north: 8, east: 4, south: 2, west: 1 }
const MISC = { l1: 1, r1: 2, l2: 4, r2: 8, view: 16, menu: 32, l3: 64, r3: 128 }
const LAST = { touchpad: 2 }

function dpadNames(hat) {
  return {
    dpad_up: hat < 2 || hat === 7,
    dpad_down: hat > 2 && hat < 6,
    dpad_left: hat > 4 && hat < 8,
    dpad_right: hat > 0 && hat < 4,
  }
}

const buttonState = {}

function setButton(id, pressed) {
  if (buttonState[id] === pressed) return
  buttonState[id] = pressed
  if (id === 'l1') l1Held = pressed
  ui.press(id, pressed)
  if (pressed) {
    pressedAt[id] = Date.now()
    fire(id)
  } else {
    releaseButton(id)
  }
}

// Stick flicks: fire once past THRESHOLD, rearm only after falling under REARM.
const THRESHOLD = 0.6
const REARM = 0.3
const sticks = {
  lstick: { armed: true, x: 0, y: 0 },
  rstick: { armed: true, x: 0, y: 0 },
}

function updateStick(prefix) {
  // A stick driving the pointer or scrolling shouldn't also fire flick bindings,
  // but holding L1 turns it back into a normal stick so the L1 layer stays
  // reachable.
  if (!l1Held) {
    if (config.mouse && (config.mouse.stick ?? 'lstick') === prefix) return
    if (config.scroll && (config.scroll.stick ?? 'rstick') === prefix) return
  }

  const s = sticks[prefix]
  const mag = Math.max(Math.abs(s.x), Math.abs(s.y))
  if (mag < REARM) {
    s.armed = true
    return
  }
  if (!s.armed || mag < THRESHOLD) return
  s.armed = false

  const dir =
    Math.abs(s.x) > Math.abs(s.y) ? (s.x > 0 ? 'right' : 'left') : s.y > 0 ? 'up' : 'down'
  fire(`${prefix}_${dir}`)
}

// Raw axis bytes are 0..255 centred at 128. Y is inverted so up reads positive.
const axis = (v) => (v - 128) / 128

// Touchpad swipes. The pad reports finger position (1920x1080), so a swipe is a
// contact-down, travel, contact-up. Fired on release as swipe_left/right/up/down.
const SWIPE_X = 400
const SWIPE_Y = 250
let touch = { down: false, x0: 0, y0: 0 }

// Double swipes ("swipe_up_x2"). A swipe only waits to see whether a second one
// is coming if a double is actually bound for that direction, so directions
// without one stay instant.
const DOUBLE_MS = 450
const pendingSwipe = new Map()

function isBound(id) {
  return Boolean(
    config.bindings?.[id] ?? config.desktop_bindings?.[id] ?? config.l1_bindings?.[id],
  )
}

function fireSwipe(name) {
  const twice = `${name}_x2`
  if (!isBound(twice)) return fire(name)

  const pending = pendingSwipe.get(name)
  if (pending) {
    clearTimeout(pending)
    pendingSwipe.delete(name)
    return fire(twice)
  }
  pendingSwipe.set(
    name,
    setTimeout(() => {
      pendingSwipe.delete(name)
      fire(name)
    }, DOUBLE_MS),
  )
}

function handleTouch(contact, x, y) {
  if (contact && !touch.down) {
    touch = { down: true, x0: x, y0: y }
    return
  }
  if (contact || !touch.down) return

  touch.down = false
  const dx = x - touch.x0
  const dy = y - touch.y0
  if (Math.abs(dx) > Math.abs(dy)) {
    if (Math.abs(dx) >= SWIPE_X) fireSwipe(dx > 0 ? 'swipe_right' : 'swipe_left')
  } else if (Math.abs(dy) >= SWIPE_Y) {
    fireSwipe(dy > 0 ? 'swipe_down' : 'swipe_up')
  }
}

function handleReport(buf) {
  const o = offsets(buf)
  if (!o) return

  const bd = buf[o.buttons]
  const face = bd >> 4
  for (const [id, bit] of Object.entries(FACE)) setButton(id, (face & bit) > 0)

  const dp = dpadNames(bd & 0b1111)
  for (const [id, down] of Object.entries(dp)) setButton(id, down)

  const misc = buf[o.buttons + 1]
  for (const [id, bit] of Object.entries(MISC)) setButton(id, (misc & bit) > 0)

  const last = buf[o.buttons + 2]
  for (const [id, bit] of Object.entries(LAST)) setButton(id, (last & bit) > 0)

  // Touch block sits a fixed 25 bytes past the button byte, so this one offset
  // covers both the USB and Bluetooth layouts.
  const tb = o.buttons + 25
  if (buf.length > tb + 3) {
    handleTouch(
      (buf[tb] & 0x80) === 0,
      ((buf[tb + 2] & 0x0f) << 8) | buf[tb + 1],
      (buf[tb + 3] << 4) | (buf[tb + 2] >> 4)
    )
  }

  sticks.lstick.x = axis(buf[o.lx])
  sticks.lstick.y = -axis(buf[o.lx + 1])
  sticks.rstick.x = axis(buf[o.lx + 2])
  sticks.rstick.y = -axis(buf[o.lx + 3])
  updateStick('lstick')
  updateStick('rstick')
}

// ---------------------------------------------------------------- connection

let device = null

function connect() {
  if (device) return
  const found = HID.devices(VENDOR_ID, PRODUCT_ID).find((d) => d.path)
  if (!found) return

  try {
    device = new HID.HID(found.path)
  } catch (err) {
    // Most often another process holds it: node-hid opens exclusively.
    log(`open failed: ${err.message.split('\n')[0]}`)
    device = null
    return
  }

  // Over Bluetooth the pad defaults to a short report: buttons only, no touch
  // and no motion. Reading the calibration feature report (0x05) switches it to
  // the full 0x31 report. Without this, swipes are invisible while every button
  // still works, which makes the problem look like bad offsets.
  try {
    device.getFeatureReport(0x05, 41)
  } catch (err) {
    log(`full-mode request failed, touch may be unavailable: ${err.message.split('\n')[0]}`)
  }

  log('controller connected')
  if (config.behaviour?.on_connect) run(config.behaviour.on_connect, 'on connect')
  device.on('data', handleReport)
  device.on('error', () => {
    log('controller disconnected')
    try {
      device.close()
    } catch {}
    device = null
    for (const k of Object.keys(buttonState)) delete buttonState[k]
    l1Held = false
    releaseAllHolds() // a pad that dies mid-drag must not leave the mouse stuck down
    stopAllRepeats()
    log('controller disconnected')
    if (config.behaviour?.on_disconnect) run(config.behaviour.on_disconnect, 'on disconnect')
  })
}

setInterval(connect, 2000)

// Accessibility is granted per exact binary path. padctl runs a frozen copy of
// node at ~/padctl/bin/node precisely so a `brew upgrade node` can't move it out
// from under the grant. This probe turns the silent-failure case (hotkeys dead,
// buttons fine) into an obvious line in the log.
function checkPermissions() {
  exec(
    `osascript -e 'tell application "System Events" to name of first process whose frontmost is true'`,
    { timeout: 5000 },
    (err) => {
      if (!err) return log('accessibility OK')
      log('!'.repeat(60))
      log('ACCESSIBILITY DENIED — buttons will work but hotkeys will NOT.')
      log(`Grant this exact binary in System Settings > Privacy > Accessibility:`)
      log(`  ${process.execPath}`)
      log('!'.repeat(60))
    }
  )
}

// launchd restarts, a manual kill and a crash-loop all land mid-drag sooner or
// later. Nothing else would ever lift the button, and a mouse stuck down system
// wide is the worst failure this program can cause, so exit through here.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopAllRepeats()
    releaseAllHolds()
    // The helper needs a tick to flush the up event before we take it down.
    setTimeout(() => process.exit(0), 60)
  })
}

loadConfig()
setTimeout(checkPermissions, 3000)

// The configurator. Loopback only, and off if `"ui": {"enabled": false}`.
const CONTROLS = [
  'south', 'east', 'west', 'north',
  'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
  'l1', 'r1', 'l2', 'r2', 'l3', 'r3', 'menu', 'view', 'touchpad',
  'lstick_up', 'lstick_down', 'lstick_left', 'lstick_right',
  'rstick_up', 'rstick_down', 'rstick_left', 'rstick_right',
  'swipe_left', 'swipe_right', 'swipe_up', 'swipe_down',
  'swipe_left_x2', 'swipe_right_x2', 'swipe_up_x2', 'swipe_down_x2',
]

if (config.ui?.enabled !== false && !DRY) {
  ui.start({
    port: config.ui?.port,
    configPath: CONFIG_PATH,
    getConfig: () => config,
    controls: CONTROLS,
    actionTypes: ['hotkey', 'click', 'hold', 'exec', 'keys', 'text', 'workspace'],
    loginItem: require('./lib/login-item'),
    log,
  })
}
log(
  `padctl running${DEBUG ? ' (debug)' : ''}${DRY ? ' (DRY RUN, nothing fires)' : ''}. ` +
    `Edit config.json to rebind, saves apply live.`
)
connect()
