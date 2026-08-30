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
          await notify(robot, event)
        }
      }
    } catch (err) {
      console.warn('[k8s-events] poll error:', err.message)
    }

    await Bun.sleep(POLL_MS)
  }
}

async function notify(robot, k8sEvent) {
  const adapter = robot.adapters.get('devchitchat')
  if (!adapter) return

  const channel = adapter.findChannelByName(CHANNEL_NAME)
  if (!channel) {
    console.warn(`[k8s-events] channel '${CHANNEL_NAME}' not found — is the bot a member?`)
    return
  }

  const details = k8sEvent.message ?? '(no details)'
  const text    = `@${NOTIFY_USER} New contact form submission:\n${details}`

  console.log(`[k8s-events] notifying #${CHANNEL_NAME}: ${text.slice(0, 120)}`)

  await adapter.send({ channel: { id: channel.channel_id } }, { text, priority: 'now' })
}
