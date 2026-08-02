#!/usr/bin/env bun
/**
 * Test client — connects to devchitchat as a second bot and sends a message
 * to the main agent bot, then prints any responses it gets back.
 *
 * Usage:
 *   DEVCHITCHAT_WS_URL=ws://... DEVCHITCHAT_BOT_TOKEN=<tester-token> \
 *     bun scripts/test-chat.js "@b07 hello"
 *
 * Or load from .env:
 *   bun scripts/test-chat.js "@b07 what is 2+2?"
 *
 * The script will:
 *   1. Connect and authenticate
 *   2. Join all channels
 *   3. Send the message to the first general-ish channel (or TARGET_CHANNEL if set)
 *   4. Print any msg.event frames it receives for TIMEOUT_MS, then exit
 */

const wsUrl      = process.env.DEVCHITCHAT_WS_URL         ?? 'ws://localhost:3000/ws'
const botToken   = process.env.DEVCHITCHAT_BOT_TOKEN       ?? ''
const tls        = process.env.DEVCHITCHAT_TLS_REJECT_UNAUTH !== 'false'
const targetChan = process.env.TARGET_CHANNEL              ?? null
const timeoutMs  = Number(process.env.TIMEOUT_MS          ?? 60_000)

const message = process.argv[2]
if (!message) {
  console.error('Usage: bun scripts/test-chat.js "<message>"')
  process.exit(1)
}
if (!botToken) {
  console.error('DEVCHITCHAT_BOT_TOKEN is required')
  process.exit(1)
}

let seq = 0
const nextId = () => `tester_${Date.now()}_${(++seq).toString(36)}`
const pending = new Map()

function sendFrame(ws, type, body) {
  const id = nextId()
  ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), t: type, body }))
  return id
}

function waitForReply(id, timeoutMs = 5_000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null) }, timeoutMs)
    pending.set(id, msg => { clearTimeout(timer); resolve(msg) })
  })
}

console.log(`[tester] connecting to ${wsUrl}`)
const ws = new WebSocket(wsUrl, { tls: { rejectUnauthorized: tls } })

let myUserId = null
let sentMessage = false

ws.onopen = () => {
  console.log('[tester] connected — authenticating')
  sendFrame(ws, 'hello', { resume: { bot_token: botToken } })
}

ws.onmessage = async event => {
  let msg
  try {
    const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
    msg = JSON.parse(raw)
  } catch {
    return
  }

  if (msg.reply_to) {
    const resolve = pending.get(msg.reply_to)
    if (resolve) { pending.delete(msg.reply_to); resolve(msg) }
  }

  switch (msg.t) {
    case 'hello_ack': {
      if (!msg.body?.session?.authenticated) {
        console.error('[tester] authentication failed:', JSON.stringify(msg.body))
        process.exit(1)
      }
      myUserId = msg.body.session.user?.user_id ?? null
      const handle = msg.body.session.user?.handle ?? '?'
      console.log(`[tester] authenticated as @${handle} (${myUserId})`)

      // List channels
      const listId = sendFrame(ws, 'channel.list', {})
      const result = await waitForReply(listId)
      const channels = result?.body?.channels ?? []
      console.log(`[tester] ${channels.length} channels available:`, channels.map(c => c.name ?? c.channel_id).join(', '))

      // Pick channel
      let channel = channels.find(c => c.channel_id === targetChan)
        ?? channels.find(c => /general/i.test(c.name ?? ''))
        ?? channels[0]

      if (!channel) {
        console.error('[tester] no channels found')
        process.exit(1)
      }
      console.log(`[tester] joining channel: ${channel.name ?? channel.channel_id}`)
      sendFrame(ws, 'channel.join', { channel_id: channel.channel_id })

      // Small delay to let join complete, then send message
      await new Promise(r => setTimeout(r, 500))
      console.log(`[tester] sending: ${message}`)
      ws.send(JSON.stringify({
        v:    1,
        id:   nextId(),
        ts:   Date.now(),
        t:    'msg.send',
        body: {
          channel_id:    channel.channel_id,
          text:          message,
          client_msg_id: `tester_${Date.now()}`,
          priority:      'normal',
          attachments:   [],
        },
      }))
      sentMessage = true

      // Exit after timeout
      setTimeout(() => {
        console.log('[tester] timeout — exiting')
        process.exit(0)
      }, timeoutMs)
      break
    }

    case 'msg.event': {
      const b = msg.body
      if (b.user_id === myUserId) break  // ignore own echo
      console.log(`[tester] response from @${b.user_display_name ?? b.user_id}: ${b.text ?? ''}`)
      break
    }

    case 'error': {
      console.error('[tester] server error:', JSON.stringify(msg.body))
      break
    }
  }
}

ws.onclose = event => {
  console.log(`[tester] disconnected: code=${event.code} reason=${event.reason}`)
  if (!sentMessage) process.exit(1)
}

ws.onerror = err => {
  console.error('[tester] ws error:', err)
}
