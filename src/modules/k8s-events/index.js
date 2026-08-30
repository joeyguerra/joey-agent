// Watches for ContactFormSubmission CRD resources and posts a priority:now
// notification to the configured channel. Uses the pod's service account
// credentials to call the K8s API directly — no kubectl needed.
// After a successful notification the status subresource is PATCHed with
// delivered=true so restarts don't produce duplicate alerts.

const SA_ROOT   = '/var/run/secrets/kubernetes.io/serviceaccount'
const K8S_API   = 'https://kubernetes.default.svc'

const NAMESPACE    = process.env.K8S_EVENTS_NAMESPACE   ?? 'default'
const CHANNEL_NAME = process.env.K8S_EVENTS_CHANNEL     ?? 'fieldmappings'
const NOTIFY_USER  = process.env.K8S_EVENTS_NOTIFY_USER ?? 'joeyg'
const POLL_MS      = Number(process.env.K8S_EVENTS_POLL_MS ?? 10_000)

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
  console.log(`[k8s-events] polling ContactFormSubmission resources in ${NAMESPACE} every ${POLL_MS}ms`)

  while (true) {
    try {
      const [token, ca] = await Promise.all([
        Bun.file(`${SA_ROOT}/token`).text(),
        Bun.file(`${SA_ROOT}/ca.crt`).text(),
      ])

      const url = `${K8S_API}/apis/fieldmappings.com/v1/namespaces/${NAMESPACE}/contactformsubmissions`

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        tls: { ca },
      })

      if (!res.ok) {
        console.warn(`[k8s-events] API error ${res.status}: ${await res.text()}`)
      } else {
        const list = await res.json()
        for (const cfs of list.items ?? []) {
          const uid = cfs.metadata?.uid
          if (!uid || seen.has(uid)) continue
          // Already delivered in a previous run — skip without adding to seen
          // so we don't hold every historical UID in memory forever.
          if (cfs.status?.delivered === true) continue
          seen.add(uid)
          if (isRateLimited()) {
            console.warn(`[k8s-events] rate limit reached — dropping uid=${uid}`)
            continue
          }
          await notify(robot, cfs, token, ca)
        }
      }
    } catch (err) {
      console.warn('[k8s-events] poll error:', err.message)
    }

    await Bun.sleep(POLL_MS)
  }
}

/** Strip characters that could be interpreted as chat commands or mentions. */
function sanitize(str) {
  return str
    .replace(/@/g, '(at)')   // prevent @mention injection
    .replace(/\[\[/g, '[[')  // prevent [[cmd:...]] injection (zero-width between brackets)
    .slice(0, MAX_MESSAGE_LENGTH)
    .trim()
}

async function markDelivered(cfs, token, ca) {
  const { name, namespace } = cfs.metadata
  const patch = { status: { delivered: true, deliveredAt: new Date().toISOString() } }
  const res = await fetch(
    `${K8S_API}/apis/fieldmappings.com/v1/namespaces/${namespace}/contactformsubmissions/${name}/status`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/merge-patch+json' },
      body: JSON.stringify(patch),
      tls: { ca },
    }
  )
  if (!res.ok) {
    console.warn(`[k8s-events] failed to mark delivered uid=${cfs.metadata.uid}: ${res.status}`)
  }
}

async function notify(robot, cfs, token, ca) {
  const adapter = robot.adapters.get('devchitchat')
  if (!adapter) return

  const channel = adapter.findChannelByName(CHANNEL_NAME)
  if (!channel) {
    console.warn(`[k8s-events] channel '${CHANNEL_NAME}' not found — is the bot a member?`)
    return
  }

  const name    = sanitize(cfs.spec?.submitterName ?? '(unknown)')
  const email   = sanitize(cfs.spec?.email         ?? '(no email)')
  const message = sanitize(cfs.spec?.message        ?? '(no message)')
  const text    = `@${NOTIFY_USER} New contact form submission:\nFrom: ${name} (${email})\n---\n${message}`

  console.log(`[k8s-events] notifying #${CHANNEL_NAME}: ${text.slice(0, 120)}`)

  await adapter.send({ channel: { id: channel.channel_id } }, { text, priority: 'now' })
  await markDelivered(cfs, token, ca)
}
