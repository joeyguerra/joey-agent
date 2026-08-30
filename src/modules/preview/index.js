import { Command }        from '@devchitchat/chatopsjs'
import { access }         from 'node:fs/promises'
import { PreviewManager } from './PreviewManager.js'
import config             from '../../config.js'

const PUBLIC_HOST = process.env.PREVIEW_HOST ?? 'https://previews.joeyguerra.com'
const IDLE_TIMEOUT_MS = Number(process.env.PREVIEW_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000)
const TEMPLATE_REPO = 'hello-world-index97'

const manager = new PreviewManager({
  publicHost:    PUBLIC_HOST,
  idleTimeoutMs: IDLE_TIMEOUT_MS,
  onIdle: (name) => console.log(`[preview] auto-stopped idle preview "${name}"`),
})

// ── Management dashboard ──────────────────────────────────────────────────────

function formatIdle(ms) {
  if (ms < 60_000)   return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

function dashboardHtml(previews, idleTimeoutMs) {
  const idleMin = Math.round(idleTimeoutMs / 60_000)

  const rows = previews.length === 0
    ? `<tr><td colspan="4" class="empty">No previews running.</td></tr>`
    : previews.map(p => {
        const pctIdle = Math.min(100, Math.round(p.idleFor / idleTimeoutMs * 100))
        return `
        <tr>
          <td><a href="${p.url}" target="_blank">${p.name}</a></td>
          <td>:${p.port}</td>
          <td>${p.startedAt.toISOString().slice(0, 19).replace('T', ' ')} UTC</td>
          <td>
            <div class="idle-bar" title="${formatIdle(p.idleFor)} — times out after ${idleMin}m idle">
              <div class="idle-fill" style="width:${pctIdle}%"></div>
              <span>${formatIdle(p.idleFor)}</span>
            </div>
          </td>
        </tr>`
      }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="30">
  <title>Previews</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #0d1117; color: #e6edf3; }
    h1 { font-size: 1.25rem; margin: 0 0 0.25rem; color: #f0f6fc; }
    .subtitle { font-size: 0.8rem; color: #8b949e; margin: 0 0 1.5rem; }
    table { border-collapse: collapse; width: 100%; }
    th { text-align: left; padding: 0.5rem 1rem; border-bottom: 1px solid #21262d; color: #8b949e; font-weight: normal; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 0.6rem 1rem; border-bottom: 1px solid #21262d; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { color: #484f58; }
    .idle-bar { position: relative; background: #21262d; border-radius: 3px; height: 18px; min-width: 120px; display: flex; align-items: center; overflow: hidden; }
    .idle-fill { position: absolute; left: 0; top: 0; height: 100%; background: #388bfd44; transition: width 1s; }
    .idle-bar span { position: relative; font-size: 0.75rem; padding: 0 0.4rem; color: #8b949e; }
  </style>
</head>
<body>
  <h1>Previews</h1>
  <p class="subtitle">Auto-refreshes every 30s &nbsp;·&nbsp; Idle timeout: ${idleMin} min</p>
  <table>
    <thead><tr><th>Repo</th><th>Port</th><th>Started</th><th>Last request</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`
}

// ── HTTP reverse proxy on :8080 ───────────────────────────────────────────────

const proxyServer = Bun.serve({
  port: 8080,

  async fetch(req, server) {
    const url   = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const repo  = parts[0]

    // Root → management dashboard
    if (!repo) {
      return new Response(dashboardHtml(manager.list(), IDLE_TIMEOUT_MS), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    const preview = manager.get(repo)
    if (!preview) {
      const running = manager.list().map(p => p.name).join(', ') || 'none'
      return new Response(`No preview running for "${repo}".\nRunning: ${running}\n`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    // Reset idle timer on every request
    manager.touch(repo)

    // WebSocket upgrade — bridge to the app's WS server
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const upgraded = server.upgrade(req, {
        data: { port: preview.port, path: url.pathname },
      })
      if (upgraded) return
      return new Response('WebSocket upgrade failed', { status: 500 })
    }

    // Strip /<repo> prefix and forward
    const strippedPath = '/' + parts.slice(1).join('/')
    const target       = `http://localhost:${preview.port}${strippedPath}${url.search}`

    try {
      const res     = await fetch(target, {
        method:   req.method,
        headers:  req.headers,
        body:     req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
        redirect: 'manual',
      })
      const headers = new Headers(res.headers)

      // Rewrite Location header — add the repo prefix back so browser follows correctly
      const location = headers.get('location')
      if (location?.startsWith('/')) headers.set('location', `/${repo}${location}`)

      return new Response(res.body, { status: res.status, headers })
    } catch (err) {
      return new Response(`Proxy error: ${err.message}\n`, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
  },

  websocket: {
    open(ws) {
      const { port, path } = ws.data
      const target = new WebSocket(`ws://localhost:${port}${path}`)
      ws.data.target = target
      target.onmessage = (e) => { try { ws.send(e.data) } catch {} }
      target.onerror   = ()  => ws.close()
      target.onclose   = ()  => ws.close()
    },
    message(ws, msg) { ws.data.target?.send(msg) },
    close(ws)        { ws.data.target?.close() },
  },
})

console.log(`[preview] proxy listening on :${proxyServer.port} (idle timeout: ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m)`)

// ── Chatops commands ──────────────────────────────────────────────────────────

export default function(robot) {
  robot.commands.register(new Command({
    id:          'preview.fork',
    description: `Fork ${TEMPLATE_REPO} as a new workspace repo. Usage: preview.fork <new-name>`,
    handler:     async ({ envelope, storage }) => {
      const args    = envelope.text.trim().split(/\s+/)
      const newName = args[1]
      if (!newName) return { text: `Error: new repo name required. Usage: \`preview.fork <new-name>\`` }

      const dest = `${config.workspace}/${newName}`

      // Refuse if destination already exists
      try {
        await access(dest)
        return { text: `Error: \`${dest}\` already exists.` }
      } catch {}

      const meshUrl = config.meshUrl

      // 1. Clone the template
      const clone = Bun.spawn(
        ['git', 'clone', `${meshUrl}/${TEMPLATE_REPO}.git`, dest],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      await clone.exited
      if (clone.exitCode !== 0) {
        const err = await new Response(clone.stderr).text()
        return { text: `Clone failed: ${err.trim() || `exit ${clone.exitCode}`}` }
      }

      // 2. Detach from template history and start fresh.
      // No mesh push — pushing is only needed when deploying in its own pod.
      // The remote is pre-configured so `git push` works when the time comes.
      const steps = [
        ['rm', '-rf', `${dest}/.git`],
        ['git', '-C', dest, 'init'],
        ['git', '-C', dest, 'add', '.'],
        ['git', '-C', dest,
          '-c', 'user.name=joey-agent',
          '-c', 'user.email=agent@joeyguerra.com',
          'commit', '-m', `Initial commit (forked from ${TEMPLATE_REPO})`],
        ['git', '-C', dest, 'remote', 'add', 'origin', `${meshUrl}/${newName}`],
      ]

      for (const cmd of steps) {
        const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
        await proc.exited
        if (proc.exitCode !== 0) {
          const err = await new Response(proc.stderr).text()
          return { text: `Failed at \`${cmd[0]} ${cmd[1]}\`: ${err.trim() || `exit ${proc.exitCode}`}` }
        }
      }

      // 3. Set as active repo for this channel
      await storage.set(`repo:${envelope.channel.id}`, newName)

      return { text: `Forked \`${TEMPLATE_REPO}\` → \`/workspace/${newName}\`. Active repo set.\nStart a preview: \`preview.start\`` }
    },
  }))

  robot.commands.register(new Command({
    id:          'preview.start',
    description: `Start a preview for a workspace repo. Usage: preview.start [repo]`,
    handler:     async ({ envelope, storage }) => {
      const args = envelope.text.trim().split(/\s+/)
      const repo = args[1] ?? await storage.get(`repo:${envelope.channel.id}`)
      if (!repo) return { text: 'Error: repo name required (or set active repo with `use <repo>`).' }

      const repoPath = `${config.workspace}/${repo}`
      const result   = await manager.start(repo, repoPath)
      if (!result.ok) return { text: `Failed to start \`${repo}\`: ${result.error}` }
      return { text: `Preview running: ${result.url}` }
    },
  }))

  robot.commands.register(new Command({
    id:          'preview.stop',
    description: `Stop a running preview. Usage: preview.stop [repo]`,
    handler:     async ({ envelope, storage }) => {
      const args = envelope.text.trim().split(/\s+/)
      const repo = args[1] ?? await storage.get(`repo:${envelope.channel.id}`)
      if (!repo) return { text: 'Error: repo name required.' }

      const stopped = manager.stop(repo)
      return { text: stopped ? `Stopped \`${repo}\`.` : `No preview running for \`${repo}\`.` }
    },
  }))

  robot.commands.register(new Command({
    id:          'preview.list',
    description: `List all running previews.`,
    handler:     async () => {
      const previews = manager.list()
      if (previews.length === 0) return { text: 'No previews running.' }
      const idleMin = Math.round(IDLE_TIMEOUT_MS / 60_000)
      return {
        text: previews
          .map(p => `\`${p.name}\` — ${p.url} _(idle ${formatIdle(p.idleFor)} / ${idleMin}m timeout)_`)
          .join('\n'),
      }
    },
  }))

  robot.commands.register(new Command({
    id:          'preview.logs',
    description: `Show recent stdout/stderr from a preview. Usage: preview.logs [repo]`,
    handler:     async ({ envelope, storage }) => {
      const args    = envelope.text.trim().split(/\s+/)
      const repo    = args[1] ?? await storage.get(`repo:${envelope.channel.id}`)
      if (!repo) return { text: 'Error: repo name required.' }

      const entries = manager.logs(repo)
      if (!entries)        return { text: `No preview running for \`${repo}\`.` }
      if (!entries.length) return { text: 'No logs yet.' }
      return { text: '```\n' + entries.map(e => e.line).join('\n') + '\n```' }
    },
  }))
}
