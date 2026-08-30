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

function buildSystemPrompt(robot, { channelId, channelName, channelTopic, handle } = {}) {
  const commands = robot.commands.list()
    .filter(c => c.id !== 'help.commands' && c.id !== 'commands.list')
    .map(c => `  ${c.id}${c.description ? ` — ${c.description}` : ''}`)
    .join('\n')

  const channelLine = channelName  ? `\nChannel: #${channelName} (id: ${channelId})` : (channelId ? `\nChannel id: ${channelId}` : '')
  const topicLine   = channelTopic ? `\nTopic: ${channelTopic}`                       : ''

  return `\
You are a coding agent in a devchitchat channel. You have access to chatops \
commands that you can invoke by embedding \`[[cmd:@${handle ?? '<botname>'} <command> <args>]]\` \
verbatim in your reply — the bot executes them inline and replaces the marker \
with the result.
${channelLine}${topicLine}

Available commands:
${commands}
  new session — Clear conversation history for this channel.

Bun is installed and preferred for temporary scripts over Python. Use Python \
only if Bun cannot accomplish the task.

A headless browser is available via Playwright MCP tools (browser_navigate, \
browser_snapshot, browser_click, browser_type, browser_take_screenshot). \
Chromium is installed at /usr/bin/chromium — no setup needed.

Mesh CI is available at https://host.lima.internal:7979 (self-signed cert — always use curl -k).
To list pipeline runs for a repo (JSON):
  curl -k https://host.lima.internal:7979/mesh/ci/<repo>/runs
Each run has: run_id, status (passed/failed/running/pending), jobs, sha, ref, started_at.
To read the build log for a completed run (HTML — parse the <pre class="log-viewer"> block):
  curl -k https://host.lima.internal:7979/repos/<repo>/ci/<run_id>
No auth token is required for mesh routes.

Attachment URLs (e.g. /uploads/<id>/<filename>) are permanent for the life \
of the conversation — re-download them with curl in later turns if you need \
to reference a file the user uploaded earlier. Always include the bot token: \
curl -H "Authorization: Bearer $DEVCHITCHAT_BOT_TOKEN" https://host.lima.internal:7979/uploads/...

To attach a file or screenshot to a message, upload it via curl then append \
a marker on its own line:
  [[attach:upload_id|url|filename|mime_type]]

The bot strips the marker and sends the file as a chat attachment alongside \
your text. You can include multiple markers for multiple files.`
}

/**
 * Split `text` around [[cmd:@handle ...]] markers and stream each segment and
 * command result as a thread reply to `thinkingMsgId`.
 *
 * Text segments are posted immediately. Commands show a `_running …_` reply
 * that is then edited in-place with the result.
 */
async function streamChunkAsReplies(robot, adapter, envelope, text, handle, thinkingMsgId) {
  const channelId = envelope.channel.id

  async function reply(msg) {
    return adapter.send(
      { ...envelope, channel: { id: channelId } },
      { ...msg, parent_msg_id: thinkingMsgId }
    )
  }

  if (!handle) {
    await reply({ text })
    return
  }

  const cmdRe   = new RegExp(`\\[\\[cmd:@${escapeRegex(handle)}\\s+(\\S[^\\]]+)\\]\\]`, 'gi')
  const matches = [...text.matchAll(cmdRe)]

  if (matches.length === 0) {
    await reply({ text })
    return
  }

  let lastIdx = 0
  for (const match of matches) {
    const before = text.slice(lastIdx, match.index).trim()
    if (before) await reply({ text: before })

    const commandText = match[1].trim()
    const firstToken  = commandText.split(/\s+/)[0]

    // Post running indicator and capture its msg_id so we can edit it.
    const runningReply = await reply({ text: `_running \`${firstToken}\`…_` })
    const runningMsgId = runningReply?.msg_id ?? null

    let cmdResultText
    if (!robot.commands.resolve(firstToken)) {
      cmdResultText = `_(unknown command: ${firstToken})_`
    } else {
      const strippedEnvelope = {
        ...envelope,
        text:    commandText,
        adapter: null,
        actor:   { ...envelope.actor, permissions: [] },
        meta:    { ...envelope.meta, sourceAdapter: envelope.adapter },
      }
      try {
        const cmdResult  = await robot.receive(strippedEnvelope)
        const response   = cmdResult.response ?? { text: cmdResult.error?.code ?? 'error' }
        cmdResultText    = response.text ?? ''
        console.log(`[llm] executed embedded command '${commandText}'`)
      } catch (err) {
        console.warn(`[llm] embedded command '${commandText}' failed: ${err.message}`)
        cmdResultText = `_(command failed: ${err.message})_`
      }
    }

    if (runningMsgId) await adapter.edit(channelId, runningMsgId, cmdResultText)

    lastIdx = match.index + match[0].length
  }

  const after = text.slice(lastIdx).trim()
  if (after) await reply({ text: after })
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    const firstToken = input.trim().split(/\s+/)[0]
    const resolved   = robot.commands.resolve(firstToken)
    if (resolved) {
      const result   = await robot.receive(strippedEnvelope)
      const response = result.response ?? { text: result.error?.code ?? 'error' }
      await adapter.send(envelope, response)
      return
    }

    // ── Agentic loop ──────────────────────────────────────────────────────────
    const attributed = `[${envelope.actor?.displayName ?? 'unknown'}]: ${input}`
    const repo       = await storage.get(`repo:${channelId}`)

    const channel      = adapter.getChannel(channelId)
    const systemPrompt = buildSystemPrompt(robot, {
      channelId,
      channelName:  channel?.name,
      channelTopic: channel?.topic,
      handle,
    })

    const incomingAttachments = envelope.attachments ?? []

    // Post a thinking indicator immediately so the user knows we're working.
    const sentMsg      = await adapter.send(envelope, { text: '_thinking…_' })
    const thinkingMsgId = sentMsg?.msg_id ?? null

    enqueue(channelId, async () => {
      const attachmentPaths    = await downloadAttachments(adapter, incomingAttachments)
      let   hasReplied         = false
      const pendingAttachments = []

      async function threadReply(msg) {
        hasReplied = true
        return adapter.send(
          { ...envelope, channel: { id: channelId } },
          { ...msg, parent_msg_id: thinkingMsgId }
        )
      }

      try {
        let hangingPrefix = ''

        for await (const chunk of agent.run(attributed, repo, channelId, systemPrompt, attachmentPaths)) {
          const { text: rawText, attachments } = parseAttachments(chunk)
          if (attachments.length > 0) pendingAttachments.push(...attachments)
          if (!rawText) continue

          const text     = hangingPrefix + rawText
          hangingPrefix  = ''

          // Hold back any trailing unclosed [[cmd: opener so it isn't posted as raw text.
          const openIdx = text.lastIndexOf('[[cmd:')
          if (openIdx !== -1 && !text.includes(']]', openIdx)) {
            const safe = text.slice(0, openIdx).trim()
            if (safe) {
              await streamChunkAsReplies(robot, adapter, envelope, safe, handle, thinkingMsgId)
              hasReplied = true
            }
            hangingPrefix = text.slice(openIdx)
          } else {
            await streamChunkAsReplies(robot, adapter, envelope, text, handle, thinkingMsgId)
            hasReplied = true
          }
        }

        // Flush anything left (malformed/incomplete command at end of stream).
        if (hangingPrefix.trim()) {
          await threadReply({ text: hangingPrefix.trim() })
        }

        // Pure tool-use run with no text output — mark the thinking message done.
        if (!hasReplied && thinkingMsgId) await adapter.edit(channelId, thinkingMsgId, '_(done)_')

      } catch (err) {
        console.error('[llm] claude error:', err)
        await threadReply({ text: `Error: ${err.message}` })
      } finally {
        await Promise.allSettled(attachmentPaths.map(p => unlink(p)))
        for (const att of pendingAttachments) {
          await threadReply({ text: '', attachments: [att] })
        }
      }
    })

    return null
  })
}
