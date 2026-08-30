// Watches for ContactFormSubmission K8s Events and posts a priority:now
// notification to the configured channel. Uses the pod's service account
// credentials to call the K8s API directly — no kubectl needed.

const SA_ROOT   = '/var/run/secrets/kubernetes.io/serviceaccount'
const K8S_API   = 'https://kubernetes.default.svc'

const NAMESPACE    = process.env.K8S_EVENTS_NAMESPACE   ?? 'default'
const CHANNEL_NAME = process.env.K8S_EVENTS_CHANNEL     ?? 'fieldmappings'
const NOTIFY_USER  = process.env.K8S_EVENTS_NOTIFY_USER ?? 'joeyg'
const POLL_MS      = Number(process.env.K8S_EVENTS_POLL_MS ?? 10_000)
const START_TIME   = new Date().toISOString()

const MAX_MESSAGE_LENGTH = 500                    // chars shown in the chat notification
const RATE_LIMIT_MAX     = 5                      // max notifications per window
const RATE_LIMIT_WINDOW  = 60 * 60 * 1_000       // 1 hour in ms

// Sliding-window rate limiter: tracks timestamps of recent notifications.
const notifyTimestamps = []

function isRateLimited() {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW
  // Drop timestamps outside the window.
  while (notifyTimestamps.length > 0 && notifyTimestamps[0] < cutoff) notifyTimestamps.shift()
  if (notifyTimestamps.length >= RATE_LIMIT_MAX) return true
  notifyTimestamps.push(now)
  return false
}

export default function(robot) {
  // Give the adapter time to connect and join channels before we start sending.
  setTimeout(() => {
    poll(robot).catch(err => console.error('[k8s-events] fatal:', err.message))
  }, 10_000)
}

async function poll(robot) {
  const seen = new Set()
  console.log(`[k8s-events] polling ContactFormSubmission events in ${NAMESPACE} every ${POLL_MS}ms`)

  while (true) {
    try {
      const [token, ca] = await Promise.all([
        Bun.file(`${SA_ROOT}/token`).text(),
        Bun.file(`${SA_ROOT}/ca.crt`).text(),
      ])

      const url = `${K8S_API}/api/v1/namespaces/${NAMESPACE}/events` +
        `?fieldSelector=reason%3DContactFormSubmission`

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        tls: { ca },
      })

      if (!res.ok) {
        console.warn(`[k8s-events] API error ${res.status}: ${await res.text()}`)
      } else {
        const list = await res.json()
        for (const event of list.items ?? []) {
          const uid = event.metadata?.uid
          if (!uid || seen.has(uid)) continue
          seen.add(uid)
          // Skip events that existed before this module started.
          if ((event.metadata?.creationTimestamp ?? '') < START_TIME) continue
          if (!isTrustedEvent(event)) {
            console.warn(`[k8s-events] dropping untrusted event uid=${uid}`)
            continue
          }
          if (isRateLimited()) {
            console.warn(`[k8s-events] rate limit reached — dropping event uid=${uid}`)
            continue
          }
          await notify(robot, event)
        }
      }
    } catch (err) {
      console.warn('[k8s-events] poll error:', err.message)
    }

    await Bun.sleep(POLL_MS)
  }
}

const SOURCE_COMPONENT = process.env.K8S_EVENTS_SOURCE_COMPONENT ?? ''

/** Verify the event originated from the expected source before acting on it. */
function isTrustedEvent(event) {
  if (!SOURCE_COMPONENT) {
    console.warn('[k8s-events] K8S_EVENTS_SOURCE_COMPONENT is not set — dropping all events')
    return false
  }
  return event.source?.component === SOURCE_COMPONENT
}

/** Strip characters that could be interpreted as chat commands or mentions. */
function sanitize(str) {
  return str
    .replace(/@/g, '(at)')   // prevent @mention injection
    .replace(/\[\[/g, '[[')  // prevent [[cmd:...]] injection (zero-width between brackets)
    .slice(0, MAX_MESSAGE_LENGTH)
    .trim()
}

async function notify(robot, k8sEvent) {
  const adapter = robot.adapters.get('devchitchat')
  if (!adapter) return

  const channel = adapter.findChannelByName(CHANNEL_NAME)
  if (!channel) {
    console.warn(`[k8s-events] channel '${CHANNEL_NAME}' not found — is the bot a member?`)
    return
  }

  const details = sanitize(k8sEvent.message ?? '(no details)')
  const text    = `@${NOTIFY_USER} New contact form submission:\n${details}`

  console.log(`[k8s-events] notifying #${CHANNEL_NAME}: ${text.slice(0, 120)}`)

  await adapter.send({ channel: { id: channel.channel_id } }, { text, priority: 'now' })
}
