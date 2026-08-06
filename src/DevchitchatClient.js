import { EventEmitter } from 'node:events'

const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS     = 30_000

// Derive the HTTP base URL from the WebSocket URL
// e.g. wss://devchitchat.com/ws → https://devchitchat.com
function httpBaseUrl(wsUrl) {
  return wsUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws$/, '')
}

/**
 * Minimal WebSocket client for devchitchat.
 *
 * Events:
 *   'message' → { channelId, text, userId, displayName, msgId, ts, attachments }
 *   'ready'   → { userId, handle }  (emitted after successful hello_ack)
 */
export class DevchitchatClient extends EventEmitter {
  #ws         = null
  #botUserId  = null
  #botHandle  = null
  #backoffMs  = BACKOFF_INITIAL_MS
  #pending    = new Map()   // frame id → resolve fn
  #seq        = 0

  constructor(config) {
    super()
    this.config = config
  }

  get botHandle() { return this.#botHandle }

  connect() {
    this.#connect()
  }

  send(channelId, text, attachments = []) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return
    const id = this.#nextId()
    this.#ws.send(JSON.stringify({
      v:    1,
      id,
      ts:   Date.now(),
      t:    'msg.send',
      body: {
        channel_id:    channelId,
        text,
        client_msg_id: `cmsg_${id}`,
        priority:      'normal',
        attachments,
      },
    }))
  }

  /**
   * Upload a file to the channel and return the attachment object.
   * Pass the result directly to send() as part of the attachments array.
   *
   * @param {string} channelId
   * @param {string} filename    - original filename e.g. "screenshot.png"
   * @param {string} mimeType   - e.g. "image/png"
   * @param {Buffer|Uint8Array} buffer
   * @returns {Promise<{upload_id, url, filename, mime_type, size_bytes}>}
   */
  async upload(channelId, filename, mimeType, buffer) {
    const base = httpBaseUrl(this.config.wsUrl)
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimeType }), filename)
    form.append('channel_id', channelId)

    const res = await fetch(`${base}/api/uploads`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${this.config.botToken}` },
      body:    form,
      ...(this.config.tls?.rejectUnauthorized === false
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

  // ── Internals ────────────────────────────────────────────────────────────────

  #nextId() {
    return `bot_${Date.now()}_${(++this.#seq).toString(36)}`
  }

  #connect() {
    console.log(`[devchitchat] connecting to ${this.config.wsUrl}`)
    const ws = new WebSocket(this.config.wsUrl, { tls: this.config.tls })

    ws.onopen = () => {
      console.log('[devchitchat] ws open — sending hello')
      this.#ws = ws
      this.#backoffMs = BACKOFF_INITIAL_MS
      this.#sendFrame(ws, 'hello', { resume: { bot_token: this.config.botToken } })
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
      console.log(`[devchitchat] frame received: t=${msg.t}`)
      await this.#handleFrame(msg)
    }

    ws.onclose = (event) => {
      console.log(`[devchitchat] ws closed: code=${event.code} reason=${event.reason}`)
      this.#ws = null
      this.#scheduleReconnect()
    }

    ws.onerror = (err) => {
      console.error('[devchitchat] ws error:', err)
    }
  }

  #scheduleReconnect() {
    const delay = this.#backoffMs
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS)
    console.log(`[devchitchat] reconnecting in ${delay}ms`)
    setTimeout(() => this.#connect(), delay)
  }

  async #handleFrame(msg) {
    // resolve pending request/response pairs
    if (msg.reply_to) {
      const resolve = this.#pending.get(msg.reply_to)
      if (resolve) {
        this.#pending.delete(msg.reply_to)
        resolve(msg)
      }
    }

    switch (msg.t) {
      case 'error': {
        console.error('[devchitchat] server error frame:', JSON.stringify(msg.body))
        break
      }

      case 'hello_ack': {
        console.log('[devchitchat] hello_ack received, authenticated=', msg.body?.session?.authenticated)
        if (!msg.body?.session?.authenticated) {
          console.error('[devchitchat] authentication failed — full body:', JSON.stringify(msg.body))
          return
        }
        this.#botUserId = msg.body.session.user?.user_id ?? null
        this.#botHandle = msg.body.session.user?.handle   ?? null
        console.log(`[devchitchat] authenticated as @${this.#botHandle} (${this.#botUserId})`)
        this.emit('ready', { userId: this.#botUserId, handle: this.#botHandle })
        await this.#joinAllChannels()
        break
      }

      case 'msg.event': {
        const b = msg.body
        console.log(`[devchitchat] msg.event from user_id=${b.user_id} in channel=${b.channel_id} text=${JSON.stringify((b.text ?? '').slice(0, 80))}`)
        if (b.user_id === this.#botUserId) {
          console.log('[devchitchat] ignoring own message')
          return
        }
        this.emit('message', {
          channelId:   b.channel_id,
          text:        b.text ?? '',
          userId:      b.user_id,
          displayName: b.user_display_name,
          msgId:       b.msg_id,
          ts:          b.ts,
          attachments: b.attachments ?? [],
        })
        break
      }
    }
  }

  async #joinAllChannels() {
    const id     = this.#sendFrame(this.#ws, 'channel.list', {})
    const result = await this.#waitForReply(id)
    const channels = result?.body?.channels ?? []
    console.log(`[devchitchat] joining ${channels.length} channel(s):`, channels.map(c => `${c.name ?? c.channel_id}`).join(', '))
    for (const ch of channels) {
      console.log(`[devchitchat] joining channel ${ch.channel_id} (${ch.name ?? 'unnamed'})`)
      this.#sendFrame(this.#ws, 'channel.join', { channel_id: ch.channel_id })
    }
  }

  #sendFrame(ws, type, body) {
    const id = this.#nextId()
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
