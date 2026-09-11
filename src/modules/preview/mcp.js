/**
 * MCP HTTP+SSE server.
 *
 * Delegates all tool calls to the chatops command registry — no duplicated
 * business logic here. Adding or changing a command automatically updates
 * the MCP tool surface without touching this file.
 *
 * Transport: HTTP + Server-Sent Events (MCP spec 2024-11-05)
 *   GET  /sse      — establish SSE stream; server sends an `endpoint` event
 *   POST /messages — receive JSON-RPC requests; responses go via SSE
 */

// ── Tools config ──────────────────────────────────────────────────────────────
// Maps MCP tool name → { commandId, inputSchema, buildText(args) }
//
// commandId   — the chatops Command id to dispatch to
// inputSchema — MCP JSON Schema for the tool's arguments
// buildText   — builds the envelope.text string the command handler will parse

const TOOLS_CONFIG = {
  repos_list: {
    commandId:   'repos.list',
    inputSchema: { type: 'object', properties: {} },
    buildText:   () => 'repos.list',
  },
  repo_clone: {
    commandId:   'clone',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name to clone (e.g. "my-app")' },
      },
      required: ['repo'],
    },
    buildText: ({ repo }) => `clone ${repo}`,
  },
  preview_fork: {
    commandId:   'preview.fork',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the new repo (e.g. "my-app")' },
      },
      required: ['name'],
    },
    buildText: ({ name }) => `preview.fork ${name}`,
  },
  preview_start: {
    commandId:   'preview.start',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Workspace repo name (directory under /workspace)' },
      },
      required: ['repo'],
    },
    buildText: ({ repo }) => `preview.start ${repo}`,
  },
  preview_stop: {
    commandId:   'preview.stop',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Workspace repo name' },
      },
      required: ['repo'],
    },
    buildText: ({ repo }) => `preview.stop ${repo}`,
  },
  preview_list: {
    commandId:   'preview.list',
    inputSchema: { type: 'object', properties: {} },
    buildText:   () => 'preview.list',
  },
  preview_logs: {
    commandId:   'preview.logs',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Workspace repo name' },
      },
      required: ['repo'],
    },
    buildText: ({ repo }) => `preview.logs ${repo}`,
  },
}

// ── Session registry ──────────────────────────────────────────────────────────

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

  controller.enqueue(
    encoder.encode(`event: endpoint\ndata: http://localhost:8080/_mcp/messages?sessionId=${sessionId}\n\n`)
  )

  return stream
}

// ── Shared storage for MCP tool calls ─────────────────────────────────────────
// Handlers that fall back to per-channel storage (e.g. `repo:${channelId}`) will
// key off 'mcp' as the channel id. Explicit args always take precedence.

const storage = (() => {
  const state = new Map()
  return {
    async get(key) { return state.get(key) },
    async set(key, value) { state.set(key, value) },
  }
})()

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function ok(text)  { return { content: [{ type: 'text', text: String(text) }] } }
function err(msg)  { return { content: [{ type: 'text', text: msg }], isError: true } }

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────

async function handleRpc(req, robot) {
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

    case 'tools/list': {
      const tools = Object.entries(TOOLS_CONFIG).flatMap(([name, cfg]) => {
        const resolved = robot.commands.resolve(cfg.commandId)
        if (!resolved) return []
        return [{
          name,
          description: resolved.command.description,
          inputSchema: cfg.inputSchema,
        }]
      })
      result = { tools }
      break
    }

    case 'tools/call': {
      const toolName = params?.name
      const args     = params?.arguments ?? {}
      const cfg      = TOOLS_CONFIG[toolName]

      if (!cfg) {
        result = err(`Unknown tool: ${toolName}`)
        break
      }

      const resolved = robot.commands.resolve(cfg.commandId)
      if (!resolved) {
        result = err(`Command not registered: ${cfg.commandId}`)
        break
      }

      const envelope = {
        text:    cfg.buildText(args),
        channel: { id: 'mcp' },
        actor:   { id: 'mcp', permissions: [] },
        meta:    {},
      }

      try {
        const response = await resolved.command.handler({ envelope, storage, robot })
        result = ok(response?.text ?? JSON.stringify(response))
      } catch (e) {
        result = err(e.message)
      }
      break
    }

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

// ── Route handler (mounted by the proxy server) ───────────────────────────────
// Handles GET /_mcp/sse and POST /_mcp/messages.
// Returns a Response for MCP requests, null for everything else.

export function handleMcpFetch(req, robot) {
  const url = new URL(req.url)

  if (req.method === 'GET' && url.pathname === '/_mcp/sse') {
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

  if (req.method === 'POST' && url.pathname === '/_mcp/messages') {
    return handleRpc(req, robot)
  }

  return null
}
