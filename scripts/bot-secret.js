#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'

const ns      = process.env.KUBE_NAMESPACE             ?? 'default'
const context = process.env.KUBE_CONTEXT               ?? 'k3s-local'
const wsUrl   = process.env.DEVCHITCHAT_WS_URL         ?? ''
const token   = process.env.DEVCHITCHAT_BOT_TOKEN      ?? ''
const tls     = process.env.DEVCHITCHAT_TLS_REJECT_UNAUTH ?? 'false'

if (!wsUrl || !token) {
  console.error('Usage: DEVCHITCHAT_WS_URL=... DEVCHITCHAT_BOT_TOKEN=... bun bot-secret')
  process.exit(1)
}

spawnSync('kubectl', ['config', 'use-context', context], { stdio: 'inherit' })

const yaml = `
apiVersion: v1
kind: Secret
metadata:
  name: joey-agent-bot
  namespace: ${ns}
type: Opaque
stringData:
  DEVCHITCHAT_WS_URL: "${wsUrl}"
  DEVCHITCHAT_BOT_TOKEN: "${token}"
  DEVCHITCHAT_TLS_REJECT_UNAUTH: "${tls}"
`.trim()

const apply = spawnSync('kubectl', ['apply', '-f', '-'], {
  input: yaml,
  stdio: ['pipe', 'inherit', 'inherit'],
  encoding: 'utf8',
})

process.exit(apply.status ?? 0)
