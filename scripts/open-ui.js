#!/usr/bin/env node
// Opens the configurator, which the running daemon serves.

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const CONFIG = path.join(__dirname, '..', 'config.json')

let port = 7757
try {
  port = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).ui?.port ?? 7757
} catch {
  // no config yet, or mid-edit: the default is right often enough
}

const url = `http://127.0.0.1:${port}`

// A closed daemon means nothing is serving, and "the page didn't load" is a
// worse message than saying so plainly.
const req = require('node:http').get(url, { timeout: 1500 }, () => {
  execFile('open', [url])
  console.log(`Opened ${url}`)
})
req.on('error', () => {
  console.error(`Nothing is serving ${url}. Is padctl running?`)
  console.error(`  launchctl kickstart -k gui/$(id -u)/com.g.padctl`)
  process.exit(1)
})
req.on('timeout', () => req.destroy())
