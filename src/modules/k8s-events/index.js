// Watches for ContactFormSubmission K8s Events from the fieldmappings namespace
// and posts a priority:now notification to the configured channel.

const NAMESPACE    = process.env.K8S_EVENTS_NAMESPACE    ?? 'default'
const CHANNEL_NAME = process.env.K8S_EVENTS_CHANNEL      ?? 'fieldmappings'
const NOTIFY_USER  = process.env.K8S_EVENTS_NOTIFY_USER  ?? 'joeyg'
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
      const proc = Bun.spawnSync(
        ['kubectl', 'get', 'events',
          '-n', NAMESPACE,
          '--field-selector', 'reason=ContactFormSubmission',
          '--sort-by=.metadata.creationTimestamp',
          '-o', 'json'],
        { stdout: 'pipe', stderr: 'pipe' },
      )

      if (proc.exitCode !== 0) {
        console.warn(`[k8s-events] kubectl error: ${proc.stderr.toString().trim()}`)
      } else {
        const list = JSON.parse(proc.stdout.toString())
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
