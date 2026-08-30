import { join } from 'node:path'
import { access } from 'node:fs/promises'

const BASE_PORT          = 4000
const MAX_LOGS           = 200
const DEFAULT_IDLE_MS    = 10 * 60 * 1000   // 10 minutes
const IDLE_CHECK_INTERVAL = 60 * 1000        // check every minute

export class PreviewManager {
  #previews      = new Map()   // repoName → { process, port, startedAt, lastRequestAt, logs }
  #nextPort      = BASE_PORT
  #publicHost
  #idleTimeoutMs
  #idleTimer     = null
  #onIdle        = null        // optional callback(repoName) when a preview is idle-stopped

  constructor({
    publicHost    = 'https://previews.joeyguerra.com',
    idleTimeoutMs = DEFAULT_IDLE_MS,
    onIdle        = null,
  } = {}) {
    this.#publicHost    = publicHost
    this.#idleTimeoutMs = idleTimeoutMs
    this.#onIdle        = onIdle
    this.#startIdleChecker()
  }

  async start(repoName, repoPath) {
    if (this.#previews.has(repoName)) {
      return { ok: false, error: 'Already running', url: this.urlFor(repoName) }
    }

    // bun install if node_modules is missing
    try {
      await access(join(repoPath, 'node_modules'))
    } catch {
      const install = Bun.spawn(['bun', 'install'], {
        cwd: repoPath,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await install.exited
      if (install.exitCode !== 0) {
        const err = await new Response(install.stderr).text()
        return { ok: false, error: `bun install failed: ${err.trim()}` }
      }
    }

    const port = this.#nextPort++
    const env  = {
      ...process.env,
      PORT:      String(port),
      BASE_PATH: `/${repoName}`,
      NODE_ENV:  'production',
    }

    const cmd  = await this.#detectStartCommand(repoPath)
    const logs = []
    const proc = Bun.spawn(cmd, { cwd: repoPath, env, stdout: 'pipe', stderr: 'pipe' })

    this.#collectLogs(proc.stdout, 'out', logs)
    this.#collectLogs(proc.stderr, 'err', logs)

    const now = new Date()
    this.#previews.set(repoName, { process: proc, port, startedAt: now, lastRequestAt: now, logs })

    // Give the process a moment to bind its port or fail fast
    await Bun.sleep(600)

    if (proc.exitCode !== null) {
      this.#previews.delete(repoName)
      const tail = logs.map(l => l.line).join('\n').trim()
      return { ok: false, error: `Process exited (code ${proc.exitCode})${tail ? ':\n' + tail : ''}` }
    }

    return { ok: true, url: this.urlFor(repoName), port }
  }

  stop(repoName) {
    const p = this.#previews.get(repoName)
    if (!p) return false
    p.process.kill()
    this.#previews.delete(repoName)
    return true
  }

  stopAll() {
    for (const [name] of this.#previews) this.stop(name)
  }

  /** Record a request so the idle timer resets. Call from the proxy on each forwarded request. */
  touch(repoName) {
    const p = this.#previews.get(repoName)
    if (p) p.lastRequestAt = new Date()
  }

  logs(repoName, n = 50) {
    const p = this.#previews.get(repoName)
    return p ? p.logs.slice(-n) : null
  }

  get(repoName) {
    return this.#previews.get(repoName) ?? null
  }

  list() {
    const idleMs = this.#idleTimeoutMs
    return [...this.#previews.entries()].map(([name, p]) => ({
      name,
      port:          p.port,
      startedAt:     p.startedAt,
      lastRequestAt: p.lastRequestAt,
      idleFor:       Date.now() - p.lastRequestAt.getTime(),
      idleTimeoutMs: idleMs,
      url:           this.urlFor(name),
    }))
  }

  urlFor(repoName) {
    return `${this.#publicHost}/${repoName}/`
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #startIdleChecker() {
    this.#idleTimer = setInterval(() => {
      const now     = Date.now()
      const timeout = this.#idleTimeoutMs
      for (const [name, p] of this.#previews) {
        if (now - p.lastRequestAt.getTime() > timeout) {
          console.log(`[preview] idle timeout — stopping "${name}"`)
          this.stop(name)
          this.#onIdle?.(name)
        }
      }
    }, IDLE_CHECK_INTERVAL)

    // Don't keep the process alive just for this timer
    this.#idleTimer.unref?.()
  }

  async #detectStartCommand(repoPath) {
    try {
      const pkg = JSON.parse(await Bun.file(join(repoPath, 'package.json')).text())
      if (pkg.scripts?.start) return ['bun', 'run', 'start']
    } catch {}

    for (const entry of ['Server.mjs', 'server.mjs', 'index.js', 'index.mjs']) {
      try {
        await access(join(repoPath, entry))
        return ['bun', entry]
      } catch {}
    }

    return ['bun', 'run', 'start']
  }

  #collectLogs(stream, label, logs) {
    ;(async () => {
      const reader  = stream.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          for (const line of decoder.decode(value).split('\n').filter(Boolean)) {
            logs.push({ t: new Date(), label, line })
            if (logs.length > MAX_LOGS) logs.shift()
          }
        }
      } catch {}
    })()
  }
}
