#!/usr/bin/env node
// Writes a config.json that fits THIS machine, and says what it left out.
//
//   node scripts/init-config.js            # only if there isn't one already
//   node scripts/init-config.js --force    # overwrite, keeping a .bak

const fs = require('node:fs')
const path = require('node:path')
const { buildConfig } = require('../lib/build-config')

const CONFIG_PATH = path.join(__dirname, '..', 'config.json')
const force = process.argv.includes('--force')

async function main() {
  if (fs.existsSync(CONFIG_PATH) && !force) {
    console.log('config.json already exists, leaving it alone. Pass --force to rebuild it.')
    return
  }

  const { config, notes, detected } = await buildConfig()

  if (fs.existsSync(CONFIG_PATH)) {
    const backup = `${CONFIG_PATH}.bak`
    fs.copyFileSync(CONFIG_PATH, backup)
    console.log(`Kept your old one at ${path.basename(backup)}`)
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')

  const found = [
    detected.terminal && `terminal: ${detected.terminal.name}`,
    detected.herdr && 'herdr: yes',
    detected.dictation && `dictation: ${detected.dictation.name}`,
  ].filter(Boolean)

  console.log(`\nWrote config.json for this machine.`)
  if (found.length) console.log(`  ${found.join('   ')}`)
  console.log(
    `  ${Object.keys(config.bindings).length} bindings, ` +
      `${Object.keys(config.l1_bindings).length} on the L1 layer`,
  )

  if (notes.length) {
    console.log('\nLeft unbound:')
    for (const n of notes) console.log(`  ${n.what}: ${n.why}`)
  }
}

main().catch((err) => {
  console.error(`Could not build a config: ${err.message}`)
  process.exit(1)
})
