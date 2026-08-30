import { Adapter } from '@devchitchat/chatopsjs'
import config from '../config.js'

const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS     = 30_000

let _seq = 0
function nextFrameId() {
  return `bot_${Date.now()}_${(++_seq).toString(36)}`
}

/** Convert ws(s):// → http(s):// and strip /ws suffix */
function httpBase(wsUrl) {
  return wsUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws$/, '')
}

/** devchitchat msg.event body → chatopsjs envelope (returns null for own messages) */
function normalize(body, botUserId) {
  if (body.user_id === botUserId) return null
  return {
    adapter:     'devchitchat',
    text:        body.text ?? '',
    actor:       { id: body.user_id, displayName: body.user_display_name, permissions: [] },
    channel:     { id: body.channel_id },
    meta:        { messageId: body.msg_id, occurred_at: body.ts },
    attachments: body.attachments ?? [],
  }
}


export class DevchitchatAdapter extends Adapter {
  #ws           = null
  #botUserId    = null
  #botHandle    = null
  #backoffMs    = BACKOFF_INITIAL_MS
  #reconnecting = false
  #pending      = new Map()   // frame id → resolve fn
  #channels     = new Map()   // channel_id → { channel_id, name, topic, ... }

  constructor(robot) {
    super(robot, 'devchitchat')
  }

  get botHandle() { return this.#botHandle }

  /** Return stored channel metadata for a given channel ID, or null if unknown. */
  getChannel(channelId) { return this.#channels.get(channelId) ?? null }

  /** Find a channel by name, or null if not found. */
  findChannelByName(name) {
    for (const ch of this.#channels.values()) {
      if (ch.name === name) return ch
    }
    return null
  }

  async start() {
    this.#connect()
  }

  /** Send a message to a channel. message = { text, attachments? } */
  async send(envelope, message) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return null
    const id = nextFrameId()
    const frame = {
      v:    1,
      id,
      ts:   Date.now(),
      t:    'msg.send',
      body: {
        channel_id:    envelope.channel.id,
        text:          message.text ?? '',
        client_msg_id: `cmsg_${id}`,
        priority:      message.priority ?? 'normal',
        attachments:   message.attachments ?? [],
        ...(message.parent_msg_id ? { parent_msg_id: message.parent_msg_id } : {}),
      },
    }
    this.#ws.send(JSON.stringify(frame))
    const ack = await this.#waitForReply(id)
    return ack?.body ?? null
  }

  /** Edit a previously sent message in-place. */
  async edit(channelId, msgId, text) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return
    const id = nextFrameId()
    this.#ws.send(JSON.stringify({
      v:    1,
      id,
      ts:   Date.now(),
      t:    'msg.edit',
      body: { channel_id: channelId, msg_id: msgId, text },
    }))
  }

  async reply(envelope, message) {
    return this.send(envelope, message)
  }

  /**
   * Download a file from the chat server by attachment URL.
   * The URL may be path-only (e.g. /uploads/up_abc/photo.png) or absolute.
   * Returns a Buffer of the file contents.
   */
  async download(url) {
    const base    = httpBase(config.wsUrl)
    const fullUrl = url.startsWith('http') ? url : `${base}${url}`
    const res     = await fetch(fullUrl, {
      headers: { Authorization: `Bearer ${config.botToken}` },
      ...(config.tls?.rejectUnauthorized === false
        ? { tls: { rejectUnauthorized: false } }
        : {}),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Download failed (${res.status}): ${text}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }

  /**
   * Upload a file buffer to the chat server.
   * Returns { upload_id, url, filename, mime_type, size_bytes }.
   */
  async upload(channelId, filename, mimeType, buffer) {
    const base = httpBase(config.wsUrl)
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimeType }), filename)
    form.append('channel_id', channelId)

    const res = await fetch(`${base}/api/uploads`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${config.botToken}` },
      body:    form,
      ...(config.tls?.rejectUnauthorized === false
        ? { tls: { rejectUnauthorized: false } }
        : {}),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Upload failed (${res.status}): ${text}`)
    }

    const data = await res.json()
    return {
      upload_id:  data.upload_id,
      url:        data.url,
      filename:   data.original_name ?? filename,
      mime_type:  data.mime_type     ?? mimeType,
      size_bytes: data.size_bytes    ?? buffer.byteLength,
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  #connect() {
    console.log(`[devchitchat] connecting to ${config.wsUrl}`)
    const ws = new WebSocket(config.wsUrl, { tls: config.tls })

    ws.onopen = () => {
      console.log('[devchitchat] open — sending hello')
      this.#ws        = ws
      this.#backoffMs = BACKOFF_INITIAL_MS
      this.#sendFrame(ws, 'hello', { resume: { bot_token: config.botToken } })
    }

    ws.onmessage = async (event) => {
      let msg
      try {
        const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
        msg = JSON.parse(raw)
      } catch {
        console.error('[devchitchat] failed to parse frame:', event.data)
        return
      }
      await this.#handleFrame(msg)
    }

    ws.onclose = (event) => {
      console.log(`[devchitchat] closed: code=${event.code}`)
      this.#ws = null
      this.#scheduleReconnect()
    }

    ws.onerror = (err) => {
      this.robot.log('adapter.error', { adapter: this.name, error: String(err) })
    }
  }

  #scheduleReconnect() {
    if (this.#reconnecting) return
    this.#reconnecting = true
    const delay = this.#backoffMs
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS)
    console.log(`[devchitchat] reconnecting in ${delay}ms`)
    setTimeout(() => {
      this.#reconnecting = false
      this.#connect()
    }, delay)
  }

  async #handleFrame(msg) {
    if (msg.reply_to) {
      const resolve = this.#pending.get(msg.reply_to)
      if (resolve) {
        this.#pending.delete(msg.reply_to)
        resolve(msg)
      }
    }

    switch (msg.t) {
      case 'error': {
        console.error('[devchitchat] server error:', JSON.stringify(msg.body))
        break
      }

      case 'hello_ack': {
        if (!msg.body?.session?.authenticated) {
          this.robot.log('adapter.auth_failed', { adapter: this.name })
          console.error('[devchitchat] authentication failed:', JSON.stringify(msg.body))
          return
        }
        this.#backoffMs  = BACKOFF_INITIAL_MS
        this.#botUserId  = msg.body.session.user?.user_id ?? null
        this.#botHandle  = msg.body.session.user?.handle  ?? null
        this.robot.log('adapter.authenticated', { adapter: this.name, handle: this.#botHandle })
        console.log(`[devchitchat] authenticated as @${this.#botHandle}`)
        await this.#joinAllChannels()
        break
      }

      case 'channel.updated': {
        const ch = msg.body?.channel
        if (ch?.channel_id && this.#channels.has(ch.channel_id)) {
          this.#channels.set(ch.channel_id, { ...this.#channels.get(ch.channel_id), ...ch })
          this.robot.log('adapter.channel_updated', { adapter: this.name, channelId: ch.channel_id, topic: ch.topic })
        }
        break
      }

      case 'bot.channels_updated': {
        console.log('[devchitchat] channel permissions updated — rejoining channels')
        await this.#joinAllChannels()
        break
      }

      case 'msg.event': {
        const envelope = normalize(msg.body, this.#botUserId)
        if (!envelope) return
        this.robot.log('adapter.message', { adapter: this.name, channelId: envelope.channel.id, actorId: envelope.actor.id })
        await this.robot.listen(envelope)
        break
      }
    }
  }

  async #joinAllChannels() {
    const id     = this.#sendFrame(this.#ws, 'channel.list', {})
    const result = await this.#waitForReply(id)
    const channels = result?.body?.channels ?? []
    console.log(`[devchitchat] joining ${channels.length} channel(s)`)
    this.#channels.clear()
    for (const ch of channels) {
      this.#channels.set(ch.channel_id, ch)
      this.#sendFrame(this.#ws, 'channel.join', { channel_id: ch.channel_id })
    }
  }

  #sendFrame(ws, type, body) {
    const id = nextFrameId()
    ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), t: type, body }))
    return id
  }

  #waitForReply(id, timeoutMs = 5_000) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.#pending.delete(id); resolve(null) }, timeoutMs)
      this.#pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    })
  }
}
