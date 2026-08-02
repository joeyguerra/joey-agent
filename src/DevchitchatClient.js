import { EventEmitter } from 'node:events'

const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS     = 30_000

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

  send(channelId, text) {
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
        attachments:   [],
      },
    }))
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  #nextId() {
    return `bot_${Date.now()}_${(++this.#seq).toString(36)}`
  }

  #connect() {
    const ws = new WebSocket(this.config.wsUrl, { tls: this.config.tls })

    ws.onopen = () => {
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
        return
      }
      await this.#handleFrame(msg)
    }

    ws.onclose = () => {
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
      case 'hello_ack': {
        if (!msg.body?.session?.authenticated) {
          console.error('[devchitchat] authentication failed')
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
        if (b.user_id === this.#botUserId) return   // ignore own messages
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
    console.log(`[devchitchat] joining ${channels.length} channel(s)`)
    for (const ch of channels) {
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
