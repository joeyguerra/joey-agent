#!/bin/bash
set -e

# Fix ownership of PVC-mounted directories (may be root-owned from a previous setup)
chown -R claude:claude /home/claude/.claude /home/claude/.mesh /workspace 2>/dev/null || true

# Restore Claude config if missing (lives outside the PVC, lost on pod restart)
if [ ! -f /home/claude/.claude.json ]; then
  BACKUP=$(su -l claude -c "ls -t /home/claude/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1")
  if [ -n "$BACKUP" ]; then
    su -l claude -c "cp \"$BACKUP\" /home/claude/.claude.json"
  fi
fi

# Initialize mesh if first boot
if [ ! -f /home/claude/.mesh/mesh.toml ]; then
  su -l claude -c "mesh init"
  su -l claude -c "sed -i 's/^name = .*/name = \"joey-agent\"/' /home/claude/.mesh/mesh.toml"
  su -l claude -c "sed -i 's/^enabled = true/enabled = false/' /home/claude/.mesh/mesh.toml"
  su -l claude -c "mesh add-address joeyguerra host.lima.internal:7979"
fi

# Start mesh daemon as claude
su -l claude -c "mesh start" &

# Write k8s-injected env vars into the app's .env so Bun picks them up
# (su -l starts a fresh login shell that doesn't inherit the container env)
{
  echo "DEVCHITCHAT_WS_URL=${DEVCHITCHAT_WS_URL:-ws://localhost:3000/ws}"
  echo "DEVCHITCHAT_BOT_TOKEN=${DEVCHITCHAT_BOT_TOKEN:-}"
  echo "DEVCHITCHAT_TLS_REJECT_UNAUTH=${DEVCHITCHAT_TLS_REJECT_UNAUTH:-false}"
  echo "CLAUDE_BIN=/home/claude/.bun/bin/claude"
} > /home/claude/app/.env
chown claude:claude /home/claude/app/.env

# Start the devchitchat bot as claude
su -l claude -c "cd ~/app && bun src/index.js" &

# Start SSH daemon as root (required to bind and switch users)
exec /usr/sbin/sshd -D -e
