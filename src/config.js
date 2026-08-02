// Bun auto-loads .env from the working directory.
// In the pod, entrypoint.sh writes the k8s env vars to ~/app/.env before starting.
export default {
  wsUrl:     process.env.DEVCHITCHAT_WS_URL    ?? 'ws://localhost:3000/ws',
  botToken:  process.env.DEVCHITCHAT_BOT_TOKEN ?? '',
  tls: {
    rejectUnauthorized: process.env.DEVCHITCHAT_TLS_REJECT_UNAUTH !== 'false',
  },
  workspace: process.env.WORKSPACE   ?? '/workspace',
  meshUrl:   process.env.MESH_URL    ?? 'https://localhost:7979',
  claudeBin: process.env.CLAUDE_BIN  ?? 'claude',
}
