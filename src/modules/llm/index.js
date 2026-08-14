import { ClaudeAgent }        from './ClaudeAgent.js'
import { unlink }             from 'node:fs/promises'

const agent = new ClaudeAgent()

// Per-channel Promise queues — serializes Claude runs so concurrent messages
// in the same channel never collide on --resume <session_id>.
const queues = new Map()
function enqueue(channelId, fn) {
  const prior = queues.get(channelId) ?? Promise.resolve()
  const next  = prior.then(fn)
  queues.set(channelId, next.catch(() => {}))   // prevent unhandled rejection stalling the chain
  return next
}

/**
 * Parse [[attach:upload_id|url|filename|mime_type]] markers from Claude output.
 * The agent emits these after uploading a file so the framework can send the
 * attachment alongside the text without an extra API round-trip.
 */
function parseAttachments(raw) {
  const attachments = []
  const text = raw.replace(/\[\[attach:([^\]]+)\]\]/g, (_, inner) => {
    const [upload_id, url, filename, mime_type] = inner.split('|')
    if (upload_id) attachments.push({ upload_id, url: url ?? '', filename: filename ?? '', mime_type: mime_type ?? '' })
    return ''
  }).trim()
  return { text, attachments }
}

const MIME_TO_EXT = {
  'image/jpeg':    'jpg',
  'image/png':     'png',
  'image/gif':     'gif',
  'image/webp':    'webp',
  'application/pdf': 'pdf',
}

/**
 * Download supported attachments (images + PDFs) from the chat server to /tmp
 * and return their local paths. Claude accesses them via its Read tool.
 * Caller is responsible for deleting the files when done.
 */
async function downloadAttachments(adapter, attachments) {
  const paths = []
  for (const att of attachments) {
    const supported = att.mime_type?.startsWith('image/') || att.mime_type === 'application/pdf'
    if (!supported) continue
    const ext  = MIME_TO_EXT[att.mime_type] ?? 'bin'
    const path = `/tmp/${att.upload_id}.${ext}`
    try {
      const buf = await adapter.download(att.url)
      await Bun.write(path, buf)
      paths.push(path)
    } catch (err) {
      console.warn(`[llm] failed to download attachment ${att.upload_id}: ${err.message}`)
    }
  }
  return paths
}

function buildSystemPrompt(robot, { channelName, channelTopic } = {}) {
  const commands = robot.commands.list()
    .filter(c => c.id !== 'help.commands' && c.id !== 'commands.list')
    .map(c => `  ${c.id}${c.description ? ` — ${c.description}` : ''}`)
    .join('\n')

  const channelLine = channelName  ? `\nChannel: #${channelName}` : ''
  const topicLine   = channelTopic ? `\nTopic: ${channelTopic}`   : ''

  return `\
You are a coding agent in a devchitchat channel. You have access to chatops \
commands that you can invoke by including them verbatim in your reply — the \
bot will execute them and send the result back to the channel.
${channelLine}${topicLine}

Available commands (prefix with @<botname> when invoking):
${commands}
  new session — Clear conversation history for this channel.

To attach a file or screenshot to a message, upload it via curl then append \
a marker on its own line:
  [[attach:upload_id|url|filename|mime_type]]

The bot strips the marker and sends the file as a chat attachment alongside \
your text. You can include multiple markers for multiple files.`
}

export default function(robot) {
  // After use/clone runs, clear the Claude session so the new repo gets fresh
  // context. Runs as middleware inside robot.receive(), which the LLM listener
  // calls when it dispatches to a known command.
  robot.use(async (context, next) => {
    await next()
    if (['use', 'clone'].includes(context.command?.id)) {
      agent.clearSession(context.envelope.channel.id)
    }
  })

  // Single catch-all listener — mirrors the chatops-bot LLM module pattern.
  robot.listeners.register(/.+/, async ({ envelope, storage }) => {
    const adapter = robot.adapters.get(envelope.adapter)
    const handle  = adapter?.botHandle
    if (!handle) return

    // Only respond to @mentions
    const mention = `@${handle}`
    if (!envelope.text.trim().toLowerCase().startsWith(mention.toLowerCase())) return

    const input = envelope.text.trim().slice(mention.length).trim()
    if (!input) return

    const channelId = envelope.channel.id

    // "new session" — clear conversation history without invoking Claude
    if (/^new session$/i.test(input)) {
      agent.clearSession(channelId)
      await adapter.send(envelope, { text: 'Session cleared.' })
      return
    }

    // Strip the @mention so command resolution sees only the command name + args.
    const strippedEnvelope = {
      ...envelope,
      text:    input,
      adapter: null,   // suppress robot.receive()'s internal auto-send
      actor:   { ...envelope.actor, permissions: [] },
      meta:    { ...envelope.meta, sourceAdapter: envelope.adapter },
    }

    // ── Known command shortcut ────────────────────────────────────────────────
    // If the first token resolves to a registered command, execute it via the
    // framework pipeline (validation, middleware, etc.) and send the result
    // ourselves. Bypasses the agentic loop entirely for structured commands.
    const firstToken = input.trim().split(/\s+/)[0]
    const resolved   = robot.commands.resolve(firstToken)
    if (resolved) {
      const result = await robot.receive(strippedEnvelope)
      const response = result.response ?? { text: result.error?.code ?? 'error' }
      await adapter.send(envelope, response)
      return
    }

    // ── Agentic loop ──────────────────────────────────────────────────────────
    // Attribute the message to the sender so Claude can tell users apart.
    const attributed = `[${envelope.actor?.displayName ?? 'unknown'}]: ${input}`
    const repo       = await storage.get(`repo:${channelId}`)

    // Rebuild the system prompt on every call so it stays current with
    // registered commands, active repo, and channel context.
    const channel      = adapter.getChannel(channelId)
    const systemPrompt = buildSystemPrompt(robot, {
      channelName:  channel?.name,
      channelTopic: channel?.topic,
    })

    // Snapshot attachments now — envelope may be mutated by the time the queue runs.
    const incomingAttachments = envelope.attachments ?? []

    // Stream chunks inside the per-channel queue so concurrent messages
    // in the same channel are processed sequentially.
    enqueue(channelId, async () => {
      // Download inside the queue so files exist for the full duration of the
      // Claude run and don't accumulate while waiting behind other requests.
      const attachmentPaths = await downloadAttachments(adapter, incomingAttachments)
      try {
        for await (const chunk of agent.run(attributed, repo, channelId, systemPrompt, attachmentPaths)) {
          const { text, attachments } = parseAttachments(chunk)
          if (text || attachments.length > 0) {
            await adapter.send(envelope, { text, attachments })
          }
        }
      } catch (err) {
        console.error('[llm] claude error:', err)
        await adapter.send(envelope, { text: `Error: ${err.message}` })
      } finally {
        // Clean up temp files regardless of success or failure.
        await Promise.allSettled(attachmentPaths.map(p => unlink(p)))
      }
    })

    // Return null — we've already kicked off streaming; no auto-send needed.
    return null
  })
}
