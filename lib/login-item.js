// "Start at login", which on macOS means the LaunchAgent's RunAtLoad key.
//
// The plist on disk is the source of truth, never a setting we remember, since
// the user can edit or remove it behind our back.
//
// The subtlety, learned by breaking it: launchd reads the plist when it loads
// the agent at login, so changing RunAtLoad only needs the FILE to change. The
// obvious-looking `bootout` then `bootstrap` to "apply" it is actively wrong,
// because bootstrapping a job whose RunAtLoad is false loads it without
// starting it. The daemon dies on the spot and the controller goes dead, which
// is a bizarre thing to happen when you changed a preference about next week.
//
// So: turning it off only rewrites the file, and what's running stays running.
// Turning it on rewrites the file and makes sure it's actually up right now,
// since someone reaching for that switch expects it working immediately.

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const LABEL = 'com.g.padctl'
const PLIST = path.join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${LABEL}.plist`)

function read() {
  let xml
  try {
    xml = fs.readFileSync(PLIST, 'utf8')
  } catch {
    return { installed: false, enabled: false, running: false, path: PLIST }
  }
  const m = xml.match(/<key>RunAtLoad<\/key>\s*<(true|false)\s*\/>/)
  return { installed: true, enabled: m ? m[1] === 'true' : false, path: PLIST }
}

function sh(cmd) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', cmd], { timeout: 8000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || stderr || '').trim() }),
    )
  })
}

async function write(enabled) {
  const current = read()
  if (!current.installed) {
    throw new Error(`No LaunchAgent at ${PLIST}. Run install.sh to create one.`)
  }
  if (current.enabled === enabled) return { ...current, enabled, changed: false }

  const xml = fs.readFileSync(PLIST, 'utf8')
  const next = xml.replace(/(<key>RunAtLoad<\/key>\s*<)(?:true|false)(\s*\/>)/, `$1${enabled}$2`)
  if (next === xml) throw new Error('Could not find RunAtLoad in the LaunchAgent.')
  fs.writeFileSync(PLIST, next)

  const uid = process.getuid()
  if (enabled) {
    // Load it if it isn't loaded, then make sure it's actually running. Both are
    // no-ops when it's already up, which is the common case.
    await sh(`launchctl bootstrap gui/${uid} ${JSON.stringify(PLIST)} 2>/dev/null; ` +
             `launchctl kickstart gui/${uid}/${LABEL} 2>/dev/null`)
  }

  return { ...current, enabled, changed: true }
}

module.exports = { read: async () => read(), write, PLIST, LABEL }
