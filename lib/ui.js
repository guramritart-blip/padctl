// The configurator, served by the daemon itself on loopback.
//
// Served from here rather than from a website on purpose. A page on https://
// talking to http://127.0.0.1 runs into mixed-content blocking, CORS, and
// Chrome's private-network rules, each breaking differently per browser. Same
// origin has none of those problems.
//
// It also means press-to-bind is free: the daemon already sees every press, so
// the page just listens.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PAGE = path.join(__dirname, '..', 'ui', 'index.html')
const clients = new Set()

let deps = null

function send(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) {
    try {
      res.write(frame)
    } catch {
      clients.delete(res)
    }
  }
}

// Called from the daemon on every raw button edge, before any binding is
// resolved. That's what press-to-bind needs: the control, not its meaning.
function press(id, pressed) {
  if (clients.size) send('press', { id, pressed })
}

// Called once a press has resolved to an action, so the page can show the same
// line the log shows.
function activity(line) {
  if (clients.size) send('activity', { line, at: Date.now() })
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

// A browser on another machine can't reach loopback, but a malicious page can
// try to make YOUR browser do it via a hostname that resolves to 127.0.0.1.
// Requiring a loopback Host closes that.
function localOnly(req) {
  const host = (req.headers.host ?? '').split(':')[0]
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

// Loopback is not a security boundary against the browser. Any page you visit
// can send a cross-origin request to 127.0.0.1, and a plain form POST needs no
// preflight, so "only I can reach it" is false the moment a tab is open.
//
// Three locks on anything that writes:
//   - PUT only. HTML forms can only send GET and POST, which kills form CSRF.
//   - Origin must be absent (a CLI) or exactly ours. Browsers always attach it
//     cross-origin, so a hostile page can't hide.
//   - application/json only, which forces a preflight we never answer.
function writeAllowed(req, port) {
  const origin = req.headers.origin
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    return 'this came from another site, so it was refused'
  }
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    return 'writes must be application/json'
  }
  return null
}

async function handle(req, res) {
  if (!localOnly(req)) return json(res, 403, { error: 'loopback only' })

  const url = new URL(req.url, 'http://127.0.0.1')

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const refused = writeAllowed(req, deps.port ?? 7757)
    if (refused) return json(res, 403, { error: refused })
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    let html
    try {
      html = fs.readFileSync(PAGE)
    } catch {
      return json(res, 500, { error: 'ui/index.html missing from the install' })
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(html)
  }

  // Installing as a desktop window needs these three. localhost counts as a
  // secure context, so it works with no certificate and no notarisation.
  const STATIC = {
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
    '/icon-192.png': ['icon-192.png', 'image/png'],
    '/icon-512.png': ['icon-512.png', 'image/png'],
  }
  if (STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname]
    try {
      const buf = fs.readFileSync(path.join(__dirname, '..', 'ui', file))
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      return res.end(buf)
    } catch {
      return json(res, 404, { error: `${file} missing from the install` })
    }
  }

  // Whether launchd will start it at login. Reported rather than guessed: the
  // plist on disk is the truth, not what we last wrote.
  if (url.pathname === '/api/login-item' && req.method === 'GET') {
    return json(res, 200, await deps.loginItem.read())
  }

  if (url.pathname === '/api/login-item' && req.method === 'PUT') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 10_000) req.destroy()
    })
    return req.on('end', async () => {
      let wanted
      try {
        wanted = JSON.parse(body)
      } catch {
        return json(res, 400, { error: 'expected JSON' })
      }
      try {
        const out = await deps.loginItem.write(Boolean(wanted.enabled))
        return json(res, 200, out)
      } catch (err) {
        return json(res, 500, { error: err.message })
      }
    })
  }

  if (url.pathname === '/api/state') {
    const { buildConfig } = require('./build-config')
    // Rebuilt rather than cached: apps get installed and shortcuts get changed
    // while the daemon is running, and a stale answer here is worse than slow.
    const fresh = await buildConfig().catch(() => null)
    // The file, not deps.getConfig(). The loader normalises to the keys it
    // understands, so serving that would round-trip every `_comment` and
    // `_actions` block straight out of the user's config on the next save.
    return json(res, 200, {
      config: readConfigFile() ?? deps.getConfig(),
      raw: safeRead(deps.configPath),
      detected: fresh?.detected ?? null,
      notes: fresh?.notes ?? [],
      shortcuts: fresh?.shortcuts ?? null,
      controls: deps.controls,
      active_profile: await (deps.profileFor?.().catch(() => null) ?? Promise.resolve(null)),
      actions: deps.actionTypes,
    })
  }

  if (url.pathname === '/api/suggest') {
    const { buildConfig } = require('./build-config')
    const built = await buildConfig().catch((err) => ({ error: err.message }))
    if (built.error) return json(res, 500, built)
    return json(res, 200, { config: built.config, notes: built.notes })
  }

  if (url.pathname === '/api/config' && req.method === 'PUT') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1_000_000) req.destroy()
    })
    return req.on('end', () => {
      let next
      try {
        next = JSON.parse(body)
      } catch (err) {
        return json(res, 400, { error: `That isn't valid JSON: ${err.message}` })
      }
      if (!next || typeof next !== 'object' || typeof next.bindings !== 'object') {
        return json(res, 400, { error: 'A config needs a `bindings` object.' })
      }
      // Documentation keys are for the human reading the file, so no client
      // gets to delete them by omission.
      const existing = readConfigFile()
      if (existing) {
        for (const [k, v] of Object.entries(existing)) {
          if (k.startsWith('_') && !(k in next)) next[k] = v
        }
      }
      try {
        // Written in place, not renamed: the daemon watches this exact path, and
        // swapping the file out from under it would leave the watcher on a
        // deleted inode and silently stop hot-reload.
        fs.writeFileSync(deps.configPath, JSON.stringify(next, null, 2) + '\n')
      } catch (err) {
        return json(res, 500, { error: err.message })
      }
      return json(res, 200, { ok: true })
    })
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    clients.add(res)
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        /* cleaned up on close */
      }
    }, 25000)
    req.on('close', () => {
      clearInterval(ping)
      clients.delete(res)
    })
    return undefined
  }

  return json(res, 404, { error: 'no such endpoint' })
}

function readConfigFile() {
  const raw = safeRead(deps.configPath)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null // mid-edit typo; the daemon keeps its last good copy anyway
  }
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

function start(options) {
  const port = options.port ?? 7757
  deps = { ...options, port }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        json(res, 500, { error: err.message })
      } catch {
        /* response already gone */
      }
    })
  })

  server.on('error', (err) => {
    options.log(`ui: not started (${err.code === 'EADDRINUSE' ? `port ${port} already in use` : err.message})`)
  })

  server.listen(port, '127.0.0.1', () => {
    options.log(`ui on http://127.0.0.1:${port}`)
  })

  return server
}

module.exports = { start, press, activity }
