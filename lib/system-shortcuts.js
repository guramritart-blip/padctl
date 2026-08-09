// Reads the user's ACTUAL macOS shortcuts instead of assuming ours.
//
// Screenshot, Mission Control and space-switching are all remappable, and plenty
// of people have moved them. Binding a controller chord to whatever we happen to
// use would silently do nothing on their machine, which reads as a broken app.
//
// macOS keeps them in com.apple.symbolichotkeys, keyed by a numeric id:
//
//   { "31": { "enabled": true, "value": { "parameters": [50, 19, 1179648] } } }
//              ^ off entirely            ^ ascii  ^ keycode  ^ modifier mask
//
// An id missing from the file means "still the factory default", so the defaults
// have to live here too. An entry with `enabled: false` means the user turned it
// off, and we must not bind it at all.

const { execFile } = require('node:child_process')

const MOD_BITS = [
  [1 << 17, 'shift'],
  [1 << 18, 'control'],
  [1 << 19, 'option'],
  [1 << 20, 'command'],
]

// Only the ids we can actually make use of. `defaults` is what macOS ships with,
// used when the id is absent from the plist.
const HOTKEYS = {
  screenshot_clipboard: {
    id: 31,
    label: 'Copy selected area to clipboard',
    defaults: { key: 21, modifiers: ['control', 'command', 'shift'] },
  },
  screenshot_file: {
    id: 30,
    label: 'Save selected area to a file',
    defaults: { key: 21, modifiers: ['command', 'shift'] },
  },
  screenshot_options: {
    id: 184,
    label: 'Screenshot and recording options',
    defaults: { key: 23, modifiers: ['command', 'shift'] },
  },
  mission_control: {
    id: 32,
    label: 'Mission Control',
    defaults: { key: 126, modifiers: ['control'] },
  },
  space_left: {
    id: 79,
    label: 'Move one space left',
    defaults: { key: 123, modifiers: ['control'] },
  },
  space_right: {
    id: 81,
    label: 'Move one space right',
    defaults: { key: 124, modifiers: ['control'] },
  },
}

function decodeModifiers(mask) {
  return MOD_BITS.filter(([bit]) => (mask & bit) === bit).map(([, name]) => name)
}

function readPlist() {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', 'defaults export com.apple.symbolichotkeys - | plutil -convert json -o - -'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve({})
        try {
          resolve(JSON.parse(stdout).AppleSymbolicHotKeys ?? {})
        } catch {
          resolve({})
        }
      },
    )
  })
}

/**
 * Resolve every hotkey we care about to a padctl `hotkey` action, or to null
 * when the user has switched it off.
 *
 * Returns { name: { action, source, label } } where source is one of
 * "user" (read from their settings), "default" (absent, so factory), or
 * "disabled" (explicitly off, do not bind).
 */
async function readSystemShortcuts() {
  const plist = await readPlist()
  const out = {}

  for (const [name, spec] of Object.entries(HOTKEYS)) {
    const entry = plist[String(spec.id)]

    if (entry && entry.enabled === false) {
      out[name] = { action: null, source: 'disabled', label: spec.label }
      continue
    }

    const params = entry?.value?.parameters
    // A present entry with no parameters (just `enabled: true`) is still on the
    // factory binding; macOS only writes parameters once you change one.
    if (Array.isArray(params) && params.length >= 3 && Number.isInteger(params[1])) {
      out[name] = {
        action: { type: 'hotkey', key: params[1], modifiers: decodeModifiers(params[2]) },
        source: 'user',
        label: spec.label,
      }
      continue
    }

    out[name] = {
      action: { type: 'hotkey', key: spec.defaults.key, modifiers: [...spec.defaults.modifiers] },
      source: 'default',
      label: spec.label,
    }
  }

  return out
}

module.exports = { readSystemShortcuts, decodeModifiers, HOTKEYS }
