// Composes a first-run config that fits THIS machine.
//
// Two rules:
//   1. Anything the system owns (screenshot, spaces, Mission Control) is bound to
//      the user's real shortcut, read from their settings, never to ours.
//   2. Anything an app owns (agent prompts, dictation) is bound only if we can
//      see that app. Otherwise the control is left out, and `notes` says why, so
//      the UI can show an honest "unbound, here's the reason" instead of a
//      button that quietly does nothing.

const { readSystemShortcuts } = require('./system-shortcuts')
const { detect } = require('./detect')

const hotkey = (key, modifiers = []) => ({ type: 'hotkey', key, modifiers })

const PROMPTS = {
  lstick_up: 'Review this diff. Flag what is actually broken, cite file:line. Skip the nitpicks.',
  lstick_down:
    'Something is broken. Ask me what is failing and what I already tried, then find the root cause before touching anything.',
  dpad_left: 'Clean this up without changing behaviour. Simpler, not cleverer.',
  dpad_right: 'Write tests for what I just changed. Cover the edge cases that would actually bite.',
}

async function buildConfig(opts = {}) {
  const shortcuts = opts.shortcuts ?? (await readSystemShortcuts())
  const found = opts.detected ?? (await detect())
  const notes = []

  const sys = (name) => {
    const s = shortcuts[name]
    if (!s) return null
    if (s.source === 'disabled') {
      notes.push({ what: name, why: `"${s.label}" is switched off in System Settings, so nothing to bind.` })
      return null
    }
    return { ...s.action }
  }

  // ------------------------------------------------------------ system-wide
  // Works in any app, needs nothing installed. This is the whole config on a
  // machine with no terminal integration.
  const desktop = {
    south: { type: 'hold', button: 'left' },
    east: { ...hotkey('escape'), repeat: true },
    west: { ...hotkey('backspace'), repeat: true },
    dpad_up: { ...hotkey('up'), repeat: true },
    dpad_down: { ...hotkey('down'), repeat: true },
    dpad_left: { ...hotkey('left'), repeat: true },
    dpad_right: { ...hotkey('right'), repeat: true },
    r1: { type: 'click', button: 'left' },
    r2: hotkey('enter'),
    l3: hotkey('backspace', ['option']),
    touchpad: { type: 'click', button: 'left' },
  }

  const spaceLeft = sys('space_left')
  const spaceRight = sys('space_right')
  if (spaceLeft) desktop.swipe_left = spaceLeft
  if (spaceRight) desktop.swipe_right = spaceRight

  const mission = sys('mission_control')
  if (mission) desktop.swipe_up_x2 = { _note: 'Mission Control, read from your settings.', ...mission }

  // ------------------------------------------------------------ layer
  const l1 = {
    south: hotkey('v', ['command']),
    east: hotkey('c', ['command']),
    // Opening your own settings from the pad, which is the point of the thing.
    menu: { _note: 'Opens the configurator.', type: 'exec', cmd: 'open http://127.0.0.1:7757' },
  }
  if (spaceLeft) l1.lstick_left = { ...spaceLeft }
  if (spaceRight) l1.lstick_right = { ...spaceRight }

  if (found.dictation?.name === 'Spokenly') {
    // Spokenly's own toggle is a bare right-Option, so faking that key gives
    // start AND stop from one button. Other dictation apps use shortcuts we
    // can't know, so they get offered in the UI instead of guessed at here.
    desktop.north = {
      _note: "Fakes a bare right-Option, which is Spokenly's toggle, so one button starts and stops.",
      type: 'exec',
      cmd: `osascript -e 'tell application "System Events" to key code 61'`,
    }
    l1.north = { type: 'exec', cmd: `open -a ${JSON.stringify(found.dictation.name)}` }
  } else if (found.dictation) {
    notes.push({
      what: 'north',
      why: `Found ${found.dictation.name}, but its toggle shortcut isn't something we can read. Record it in the configurator and this button will work.`,
    })
  } else {
    notes.push({ what: 'north', why: 'No dictation app found, so this button is free.' })
  }

  // ------------------------------------------------------------ terminal side
  const config = {
    _comment:
      'Written for this machine on first run: system shortcuts read from your own settings, app bindings only where the app was found. Edit and save; padctl reloads live. A typo keeps the last good config instead of crashing.',
    bindings: {},
    l1_bindings: l1,
    mouse: { stick: 'lstick', speed: 22, deadzone: 0.15 },
    scroll: { stick: 'rstick', speed: 40, deadzone: 0.15, invert: false },
    terminal_bundle: found.terminal?.bundle ?? 'dev.warp.Warp-Stable',
    desktop_bindings: {},
    chords: {},
  }

  if (found.herdr && found.terminal) {
    // With herdr we can target the focused pane directly, which is the only way
    // to reach a coding agent rather than whatever happens to have focus.
    config.bindings = {
      ...desktop,
      east: { type: 'keys', keys: ['esc'], repeat: true },
      west: { type: 'keys', keys: ['backspace'], repeat: true },
      dpad_up: { type: 'keys', keys: ['up'], repeat: true },
      dpad_down: { type: 'keys', keys: ['down'], repeat: true },
      dpad_left: { type: 'keys', keys: ['left'], repeat: true },
      dpad_right: { type: 'keys', keys: ['right'], repeat: true },
      r2: { type: 'keys', keys: ['enter'] },
      l3: { type: 'keys', keys: ['ctrl+w'] },
      r3: { type: 'keys', keys: ['esc', 'esc'] },
      l2: { type: 'workspace', dir: 'next' },
      view: { type: 'exec', cmd: 'herdr pane focus --direction left' },
      menu: { type: 'exec', cmd: 'herdr pane focus --direction right' },
    }
    config.desktop_bindings = desktop
    config.l1_bindings = {
      ...l1,
      west: { type: 'text', text: '/clear' },
      r1: { type: 'text', text: '/compact' },
      l2: { type: 'workspace', dir: 'prev' },
      r2: { type: 'workspace', dir: 'next' },
      dpad_up: { type: 'text', text: 'keep going' },
      ...Object.fromEntries(
        Object.entries(PROMPTS).map(([k, text]) => [k, { type: 'text', text }]),
      ),
    }
  } else {
    config.bindings = desktop
    config.desktop_bindings = {}
    if (!found.herdr) {
      notes.push({
        what: 'agent bindings',
        why: 'herdr not found, so there is no way to target a terminal pane. Everything here is system-wide instead.',
      })
    }
    if (!found.terminal) {
      notes.push({ what: 'terminal_bundle', why: 'No known terminal app found; guessed a default.' })
    }
  }

  const shot = sys('screenshot_clipboard')
  if (shot) {
    config.chords['l2+r2'] = {
      _note: 'Screenshot to clipboard, read from your settings. Safe to chord: a stray one costs nothing.',
      ...shot,
    }
  }

  return { config, notes, detected: found, shortcuts }
}

module.exports = { buildConfig }
