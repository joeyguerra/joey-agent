// Run with: bun test-spawn.js
// Tests whether Bun.spawn can find and execute binaries.

import { realpathSync } from 'node:fs'

const CLAUDE_BIN_RAW = process.env.CLAUDE_BIN ?? 'claude'
const CLAUDE_BIN = (() => {
  try { return realpathSync(CLAUDE_BIN_RAW) } catch { return CLAUDE_BIN_RAW }
})()

console.log('--- environment ---')
console.log('CLAUDE_BIN (raw):     ', CLAUDE_BIN_RAW)
console.log('CLAUDE_BIN (resolved):', CLAUDE_BIN)
console.log('PATH:', process.env.PATH)
console.log()

async function spawnTest(label, args, opts = {}) {
  console.log(`[test] ${label}`)
  console.log('       args:', JSON.stringify(args))
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', ...opts })
    await proc.exited
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    console.log('       exit:', proc.exitCode)
    if (out.trim()) console.log('       stdout:', out.trim().slice(0, 200))
    if (err.trim()) console.log('       stderr:', err.trim().slice(0, 200))
    console.log('       ✓ ok')
  } catch (e) {
    console.log('       ✗ error:', e.message)
  }
  console.log()
}

// 1. Can Bun.spawn find /bin/echo by absolute path?
await spawnTest('absolute path /bin/echo', ['/bin/echo', 'hello from echo'])

// 2. Can Bun.spawn find sh by relative name?
await spawnTest('relative name: sh', ['sh', '-c', 'echo hello from sh'])

// 3. Can Bun.spawn find sh by absolute path?
await spawnTest('absolute path /bin/sh', ['/bin/sh', '-c', 'echo hello from /bin/sh'])

// 4. Does the claude binary exist and is executable?
await spawnTest('claude --version via absolute path', [CLAUDE_BIN, '--version'])

// 5. claude via /bin/sh wrapper
await spawnTest('claude via /bin/sh wrapper', [
  '/bin/sh', '-c', '"$_CLAUDE" --version', 'test',
], { env: { ...process.env, _CLAUDE: CLAUDE_BIN } })

// 6. claude --print via absolute path (matches what ClaudeAgent.js does)
await spawnTest('claude --print via absolute path', [
  CLAUDE_BIN,
  '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
  'say hi in one word',
])

// 7. same but with a non-existent cwd — this is the likely root cause of earlier ENOENT
await spawnTest('claude with non-existent cwd (expect ENOENT)', [
  CLAUDE_BIN, '--version',
], { cwd: '/workspace' })
