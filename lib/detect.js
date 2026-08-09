// What's actually on this machine.
//
// The point is to never bind a button to something that isn't installed. An
// unbound button is honest; a bound button that silently does nothing is a bug
// report. So anything app-specific gets offered only when we can see the app.

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const APP_DIRS = [
  '/Applications',
  '/System/Applications',
  path.join(process.env.HOME ?? '', 'Applications'),
]

// Ordered by preference. First one found wins as the default terminal, since
// `keys` and `text` need to know which app counts as "the terminal".
const TERMINALS = [
  { name: 'Warp', app: 'Warp.app', bundle: 'dev.warp.Warp-Stable' },
  { name: 'Ghostty', app: 'Ghostty.app', bundle: 'com.mitchellh.ghostty' },
  { name: 'iTerm', app: 'iTerm.app', bundle: 'com.googlecode.iterm2' },
  { name: 'WezTerm', app: 'WezTerm.app', bundle: 'com.github.wez.wezterm' },
  { name: 'Kitty', app: 'kitty.app', bundle: 'net.kovidgoyal.kitty' },
  { name: 'Terminal', app: 'Utilities/Terminal.app', bundle: 'com.apple.Terminal' },
]

// Push-to-talk dictation apps. All of them toggle on a keyboard shortcut, so we
// can only offer the button once we know which one is here.
const DICTATION = [
  { name: 'Spokenly', app: 'Spokenly.app' },
  { name: 'superwhisper', app: 'superwhisper.app' },
  { name: 'MacWhisper', app: 'MacWhisper.app' },
  { name: 'Wispr Flow', app: 'Wispr Flow.app' },
]

function findApp(relative) {
  for (const dir of APP_DIRS) {
    if (!dir) continue
    const full = path.join(dir, relative)
    if (fs.existsSync(full)) return full
  }
  return null
}

function onPath(cmd) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', `command -v ${cmd}`], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null)
    })
  })
}

async function detect() {
  const terminals = TERMINALS.filter((t) => findApp(t.app))
  const dictation = DICTATION.filter((d) => findApp(d.app))
  const herdr = await onPath('herdr')

  return {
    // null when we found nothing, which is fine: everything falls back to
    // system-wide bindings that work in any app.
    terminal: terminals[0] ?? null,
    terminals,
    dictation: dictation[0] ?? null,
    herdr: herdr ? { path: herdr } : null,
  }
}

module.exports = { detect, TERMINALS, DICTATION }
