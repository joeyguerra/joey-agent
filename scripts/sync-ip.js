#!/usr/bin/env bun
// Resolves the Mac mini's IP as seen from inside the Lima VM and writes it to values.local.yaml.
// Usage: bun sync-ip

import { readFileSync, writeFileSync } from 'node:fs'

const result = Bun.spawnSync(['limactl', 'shell', 'k3s', '--', 'getent', 'hosts', 'host.lima.internal'], {
  stdout: 'pipe',
  stderr: 'pipe',
})

if (result.exitCode !== 0) {
  console.error('Failed to resolve host.lima.internal via limactl:')
  console.error(result.stderr.toString())
  process.exit(1)
}

const line = result.stdout.toString().trim()
const ip   = line.split(/\s+/)[0]

if (!ip) {
  console.error('Could not parse IP from limactl output:', line)
  process.exit(1)
}

const valuesPath = new URL('../values.local.yaml', import.meta.url).pathname
const content = `vars:\n  hostAliasIp: "${ip}"\n`
writeFileSync(valuesPath, content, 'utf8')
console.log(`Updated values.local.yaml — hostAliasIp: ${ip}`)
