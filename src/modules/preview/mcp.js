/**
 * MCP HTTP+SSE server for preview tools.
 *
 * Transport: HTTP + Server-Sent Events (MCP spec 2024-11-05)
 *   GET  /sse           — establish SSE stream; server sends an `endpoint` event
 *   POST /messages      — receive JSON-RPC requests; responses go via SSE
 *
 * Tools exposed:
 *   preview_fork   — fork hello-world-index97 into a new workspace repo
 *   preview_start  — start a preview for a workspace repo
 *   preview_stop   — stop a running preview
 *   preview_list   — list running previews
 *   preview_logs   — tail recent stdout/stderr from a preview
 */

import { access } from 'node:fs/promises'
import { mesh }   from '../../mesh.js'
import config     from '../../config.js'

const TEMPLATE_REPO = 'hello-world-index97'

// ── Session registry ──────────────────────────────────────────────────────────
// Each SSE connection gets a session. Requests posted to /messages are routed
// to the right session by sessionId query param.

const sessions = new Map()   // sessionId → { send(obj), close() }
const encoder  = new TextEncoder()

function createSession(sessionId) {
  let controller
  const stream = new ReadableStream({
    start(c) { controller = c },
    cancel()  { sessions.delete(sessionId) },
  })

  sessions.set(sessionId, {
    send:  (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)),
    close: ()    => { try { controller.close() } catch {} sessions.delete(sessionId) },
  })

  // Send the endpoint event so the client knows where to POST
  controller.enqueue(
    encoder.encode(`event: endpoint\ndata: http://localhost:8081/messages?sessionId=${sessionId}\n\n`)
  )

  return stream
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name:        'repos_list',
    description: 'List repos available on the mesh node.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'repo_clone',
    description: 'Clone a repo from mesh into /workspace. Use this before working on a repo that is not yet local.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name to clone (e.g. "my-app")' },
      },
      required: ['repo'],
    },
  },
  {
    name:        'preview_fork',
    description: `Fork the ${TEMPLATE_REPO} template into a new workspace repo. ` +
                 `No mesh push needed — use this to start a new web project locally. ` +
                 `The repo name becomes the URL slug under previews.joeyguerra.com.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the new repo (e.g. "my-app")' },
      },
      required: ['name'],
    },
  },
  {
    name:        'preview_start',
    description: `Install dependencies (if needed) and start a preview server for a workspace repo. ` +
                 `Returns the public URL.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Workspace repo name (directory under /workspace)' },
      },
      required: ['repo'],
    },
  },
  {
    name:        'preview_stop',
    description: 'Stop a running preview.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Workspace repo name' },
      },
      required: ['repo'],
    },
  },
  {
    name:        'preview_list',
    description: 'List all currently running previews with their public URLs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'preview_logs',
    description: 'Return recent stdout/stderr lines from a running preview.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:  { type: 'string',  description: 'Workspace repo name' },
        lines: { type: 'number',  description: 'Number of lines to return (default 50)' },
      },
      required: ['repo'],
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function callTool(name, args, manager) {
  switch (name) {

    case 'repos_list': {
      const data  = await mesh.get('/status')
      const html  = data._raw ?? ''
      const repos = [...new Set(
        [...html.matchAll(/href="\/repos\/([^"\/]+)"/g)].map(m => m[1])
      )]
      return ok({ repos })
    }

    case 'repo_clone': {
      const { repo } = args
      if (!repo) return err('repo is required')
      const dest = `${config.workspace}/${repo}`
      try { await access(dest); return err(`/workspace/${repo} already exists`) } catch {}
      const proc = Bun.spawn(
        ['git', 'clone', `${config.meshUrl}/${repo}.git`, dest],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      await proc.exited
      if (proc.exitCode !== 0) {
        const msg = (await new Response(proc.stderr).text()).trim()
        return err(`git clone failed: ${msg || `exit ${proc.exitCode}`}`)
      }
      return ok({ repo, path: dest })
    }

    case 'preview_fork': {
      const { name: newName } = args
      if (!newName) return err('name is required')

      const dest = `${config.workspace}/${newName}`
      try { await access(dest); return err(`/workspace/${newName} already exists`) } catch {}

      const meshUrl = config.meshUrl

      const clone = Bun.spawn(
        ['git', 'clone', `${meshUrl}/${TEMPLATE_REPO}.git`, dest],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      await clone.exited
      if (clone.exitCode !== 0) {
        const msg = (await new Response(clone.stderr).text()).trim()
        return err(`git clone failed: ${msg || `exit ${clone.exitCode}`}`)
      }

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
          const msg = (await new Response(proc.stderr).text()).trim()
          return err(`${cmd.slice(0, 3).join(' ')} failed: ${msg || `exit ${proc.exitCode}`}`)
        }
      }

      return ok({ repo: newName, path: dest, message: `Forked ${TEMPLATE_REPO} → /workspace/${newName}. Run preview_start to preview it.` })
    }

    case 'preview_start': {
      const { repo } = args
      if (!repo) return err('repo is required')
      const result = await manager.start(repo, `${config.workspace}/${repo}`)
      if (!result.ok) return err(result.error)
      return ok({ repo, url: result.url, port: result.port })
    }

    case 'preview_stop': {
      const { repo } = args
      if (!repo) return err('repo is required')
      const stopped = manager.stop(repo)
      return ok({ repo, stopped })
    }

    case 'preview_list': {
      const previews = manager.list().map(p => ({
        repo:      p.name,
        url:       p.url,
        port:      p.port,
        startedAt: p.startedAt.toISOString(),
        idleFor:   Math.round(p.idleFor / 1000) + 's',
      }))
      return ok({ previews })
    }

    case 'preview_logs': {
      const { repo, lines = 50 } = args
      if (!repo) return err('repo is required')
      const entries = manager.logs(repo, lines)
      if (!entries) return err(`No preview running for "${repo}"`)
      return ok({ repo, logs: entries.map(e => e.line) })
    }

    default:
      return err(`Unknown tool: ${name}`)
  }
}

function ok(data)    { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } }
function err(msg)    { return { content: [{ type: 'text', text: msg }], isError: true } }

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────

async function handleRpc(req, manager) {
  const sessionId = new URL(req.url).searchParams.get('sessionId')
  const session   = sessions.get(sessionId)
  if (!session) return new Response('Unknown session', { status: 404 })

  const { id, method, params } = await req.json()

  // Notifications have no id — acknowledge but don't respond via SSE
  if (id === undefined) return new Response(null, { status: 202 })

  let result
  switch (method) {
    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {} },
        serverInfo:      { name: 'joey-agent', version: '1.0.0' },
      }
      break

    case 'tools/list':
      result = { tools: TOOLS }
      break

    case 'tools/call':
      result = await callTool(params?.name, params?.arguments ?? {}, manager)
      break

    case 'ping':
      result = {}
      break

    default:
      session.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      return new Response(null, { status: 202 })
  }

  session.send({ jsonrpc: '2.0', id, result })
  return new Response(null, { status: 202 })
}

// ── Server ────────────────────────────────────────────────────────────────────

export function startMcpServer(manager, port = 8081) {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)

      if (req.method === 'GET' && url.pathname === '/sse') {
        const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2)}`
        const stream    = createSession(sessionId)
        return new Response(stream, {
          headers: {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
          },
        })
      }

      if (req.method === 'POST' && url.pathname === '/messages') {
        return handleRpc(req, manager)
      }

      return new Response('Not found', { status: 404 })
    },
  })

  console.log(`[preview] MCP server listening on :${server.port}`)
  return server
}
