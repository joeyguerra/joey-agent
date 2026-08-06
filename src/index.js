import { DevchitchatClient } from './DevchitchatClient.js'
import { ClaudeAgent }        from './ClaudeAgent.js'
import config                 from './config.js'

const client = new DevchitchatClient(config)
const agent  = new ClaudeAgent()

// Per-channel state: { repo: string|null, queue: Promise }
// queue is a Promise chain — each new request appends to it so messages in the
// same channel are processed sequentially with no concurrent --resume collisions.
const channels = new Map()

function state(channelId) {
  if (!channels.has(channelId)) channels.set(channelId, { repo: null, queue: Promise.resolve() })
  return channels.get(channelId)
}

client.on('ready', ({ handle }) => {
  console.log(`[bot] ready — mention me as @${handle}`)
})

client.on('message', async ({ channelId, text, displayName }) => {
  const trimmed = text.trim()

  // Only respond to @mentions
  const prefix = `@${client.botHandle}`
  console.log(`[bot] message in channel=${channelId} botHandle=${client.botHandle} prefix=${JSON.stringify(prefix)} text=${JSON.stringify(trimmed.slice(0, 100))}`)
  if (!trimmed.startsWith(prefix)) {
    console.log('[bot] ignoring — does not start with prefix')
    return
  }

  const input = trimmed.slice(prefix.length).trim()
  console.log(`[bot] parsed input=${JSON.stringify(input)}`)
  if (!input) return

  const ch = state(channelId)

  // ── Built-in commands ──────────────────────────────────────────────────────

  // use <repo>  — set active repo for this channel
  if (/^use\s+\S+$/.test(input)) {
    ch.repo = input.slice(4).trim()
    agent.clearSession(channelId)     // new repo = fresh context
    client.send(channelId, `Active repo: \`${ch.repo}\``)
    return
  }

  // clone <repo>  — git clone from mesh then set as active
  if (/^clone\s+\S+$/.test(input)) {
    const repo = input.slice(6).trim()
    client.send(channelId, `Cloning \`${repo}\`…`)
    try {
      await gitClone(repo)
      ch.repo = repo
      agent.clearSession(channelId)   // new repo = fresh context
      client.send(channelId, `Cloned \`${repo}\` → active repo set.`)
    } catch (err) {
      client.send(channelId, `Clone failed: ${err.message}`)
    }
    return
  }

  // new session  — clear conversation history for this channel
  if (/^new session$/i.test(input)) {
    agent.clearSession(channelId)
    client.send(channelId, 'Session cleared.')
    return
  }

  // status  — show active repo
  if (/^status$/i.test(input)) {
    client.send(channelId, ch.repo ? `Active repo: \`${ch.repo}\`` : 'No repo active.')
    return
  }

  // help
  if (/^help$/i.test(input)) {
    const handle = client.botHandle
    client.send(channelId, [
      `**${handle} commands** (prefix all with \`@${handle}\`)`,
      `\`clone <repo>\` — git clone \`${config.meshUrl}/<repo>.git\` and set as active`,
      `\`use <repo>\` — switch active repo (must already exist in ${config.workspace})`,
      '`status` — show active repo',
      '`new session` — clear conversation history for this channel',
      '`help` — this message',
      '',
      'Everything else is forwarded to Claude Code. Set an active repo for file work, or just chat without one.',
    ].join('\n'))
    return
  }

  // ── Forward to Claude Code ─────────────────────────────────────────────────

  // Attribute the message to the sender so Claude can tell users apart in
  // group channels. Format matches common chat-to-LLM conventions.
  const attributed = `[${displayName ?? 'unknown'}]: ${input}`

  // Append to the per-channel queue so concurrent messages serialize —
  // only one claude --resume process touches a given session at a time.
  console.log(`[bot] queuing for claude — repo=${ch.repo ?? '(none)'} channelId=${channelId} sender=${displayName}`)
  ch.queue = ch.queue.then(async () => {
    try {
      for await (const chunk of agent.run(attributed, ch.repo, channelId)) {
        const { text, attachments } = parseAttachments(chunk)
        console.log(`[bot] sending chunk (${text.length} chars, ${attachments.length} attachment(s))`)
        if (text || attachments.length > 0) client.send(channelId, text, attachments)
      }
    } catch (err) {
      console.error('[bot] claude error:', err)
      client.send(channelId, `Error: ${err.message}`)
    } finally {
      console.log(`[bot] done — channel=${channelId}`)
    }
  })
})

/**
 * Parse [[attach:upload_id|url|filename|mime_type]] markers from Claude's output.
 * The agent emits these after uploading a file via curl so index.js can pass
 * the attachment metadata to client.send() without an extra API round-trip.
 *
 * Returns { text, attachments } where text has the markers stripped and
 * attachments is an array of { upload_id, url, filename, mime_type } objects.
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

async function gitClone(repo) {
  const url  = `${config.meshUrl}/${repo}.git`
  const dest = `${config.workspace}/${repo}`
  const proc = Bun.spawn(['git', 'clone', url, dest], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    const errText = await new Response(proc.stderr).text()
    throw new Error(errText.trim() || `exit code ${proc.exitCode}`)
  }
}

client.connect()
console.log('[bot] connecting to devchitchat…')
