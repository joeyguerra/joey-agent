// Watches for DiscoveryCallRequest CRD resources and posts a priority:now
// notification to the configured channel. Uses the pod's service account
// credentials to call the K8s API directly — no kubectl needed.
// After a successful notification the status subresource is PATCHed with
// delivered=true so restarts don't produce duplicate alerts.

const SA_ROOT = '/var/run/secrets/kubernetes.io/serviceaccount'
const K8S_API = 'https://kubernetes.default.svc'

const NAMESPACE    = process.env.K8S_EVENTS_NAMESPACE        ?? 'default'
const CHANNEL_NAME = process.env.JOEYGUERRA_EVENTS_CHANNEL   ?? 'joeyguerra'
const NOTIFY_USER  = process.env.JOEYGUERRA_EVENTS_NOTIFY_USER ?? 'joeyg'
const POLL_MS      = Number(process.env.JOEYGUERRA_EVENTS_POLL_MS ?? 10_000)

const MAX_NOTES_LENGTH = 500
const RATE_LIMIT_MAX   = 5
const RATE_LIMIT_WINDOW = 60 * 60 * 1_000   // 1 hour

const notifyTimestamps = []

function isRateLimited() {
  const now    = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW
  while (notifyTimestamps.length > 0 && notifyTimestamps[0] < cutoff) notifyTimestamps.shift()
  if (notifyTimestamps.length >= RATE_LIMIT_MAX) return true
  notifyTimestamps.push(now)
  return false
}

export default function(robot) {
  setTimeout(() => {
    poll(robot).catch(err => console.error('[joeyguerra-events] fatal:', err.message))
  }, 10_000)
}

async function poll(robot) {
  const seen = new Set()
  console.log(`[joeyguerra-events] polling DiscoveryCallRequest resources in ${NAMESPACE} every ${POLL_MS}ms`)

  while (true) {
    try {
      const [token, ca] = await Promise.all([
        Bun.file(`${SA_ROOT}/token`).text(),
        Bun.file(`${SA_ROOT}/ca.crt`).text(),
      ])

      const url = `${K8S_API}/apis/joeyguerra.com/v1/namespaces/${NAMESPACE}/discoverycallrequests`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        tls: { ca },
      })

      if (!res.ok) {
        console.warn(`[joeyguerra-events] API error ${res.status}: ${await res.text()}`)
      } else {
        const list = await res.json()
        for (const dcr of list.items ?? []) {
          const uid = dcr.metadata?.uid
          if (!uid || seen.has(uid)) continue
          if (dcr.status?.delivered === true) continue
          seen.add(uid)
          if (isRateLimited()) {
            console.warn(`[joeyguerra-events] rate limit reached — dropping uid=${uid}`)
            continue
          }
          await notify(robot, dcr, token, ca)
        }
      }
    } catch (err) {
      console.warn('[joeyguerra-events] poll error:', err.message)
    }

    await Bun.sleep(POLL_MS)
  }
}

function sanitize(str) {
  return str
    .replace(/@/g, '(at)')
    .replace(/\[\[/g, '[[')
    .slice(0, MAX_NOTES_LENGTH)
    .trim()
}

async function markDelivered(dcr, token, ca) {
  const { name, namespace } = dcr.metadata
  const patch = { status: { delivered: true, deliveredAt: new Date().toISOString() } }
  const res = await fetch(
    `${K8S_API}/apis/joeyguerra.com/v1/namespaces/${namespace}/discoverycallrequests/${name}/status`,
    {
      method:  'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/merge-patch+json' },
      body:    JSON.stringify(patch),
      tls:     { ca },
    }
  )
  if (!res.ok) {
    console.warn(`[joeyguerra-events] failed to mark delivered uid=${dcr.metadata.uid}: ${res.status}`)
  }
}

async function notify(robot, dcr, token, ca) {
  const adapter = robot.adapters.get('devchitchat')
  if (!adapter) return

  const channel = adapter.findChannelByName(CHANNEL_NAME)
  if (!channel) {
    console.warn(`[joeyguerra-events] channel '${CHANNEL_NAME}' not found — is the bot a member?`)
    return
  }

  const name    = sanitize(dcr.spec?.name          ?? '(unknown)')
  const email   = sanitize(dcr.spec?.email         ?? '(no email)')
  const company = dcr.spec?.company ? ` — ${sanitize(dcr.spec.company)}` : ''
  const date    = sanitize(dcr.spec?.preferredDate ?? '?')
  const time    = sanitize(dcr.spec?.preferredTime ?? '?')
  const tz      = sanitize(dcr.spec?.timezone      ?? '?')
  const notes   = dcr.spec?.notes ? `\n---\n${sanitize(dcr.spec.notes)}` : ''

  const text = `@${NOTIFY_USER} New discovery call request:\nFrom: ${name}${company} (${email})\nPreferred: ${date} at ${time} ${tz}${notes}`

  console.log(`[joeyguerra-events] notifying #${CHANNEL_NAME}: ${text.slice(0, 120)}`)

  await adapter.send({ channel: { id: channel.channel_id } }, { text, priority: 'now' })
  await markDelivered(dcr, token, ca)
}
