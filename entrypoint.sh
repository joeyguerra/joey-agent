#!/bin/bash
set -e

# Fix ownership of PVC-mounted directories
chown -R claude:claude /home/claude/.claude /workspace 2>/dev/null || true
# Allow root's git to operate on mesh's bare repos and fetch from the Mac mini peer
git config --global http.https://host.lima.internal:7979.sslVerify false
git config --global http.https://localhost:7979.sslVerify false

# Restore Claude config if missing (lives outside the PVC, lost on pod restart)
if [ ! -f /home/claude/.claude.json ]; then
  BACKUP=$(su -l claude -c "ls -t /home/claude/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1")
  if [ -n "$BACKUP" ]; then
    su -l claude -c "cp \"$BACKUP\" /home/claude/.claude.json"
  fi
fi

# Initialize mesh if first boot (runs as root — config lives in /root/.mesh/)
if [ ! -f /root/.mesh/mesh.toml ]; then
  mesh init
  sed -i 's/^name = .*/name = "joey-agent"/' /root/.mesh/mesh.toml
  mesh add-address joeyguerra host.lima.internal:7979
fi

# Always enforce runner disabled — this pod is not a CI runner.
# Done outside the first-boot guard so it applies even if the PVC already
# has a mesh.toml from a previous deployment with runner enabled.
sed -i 's/^enabled = true/enabled = false/' /root/.mesh/mesh.toml

# Write workspace-level CLAUDE.md so the agent always knows its environment.
# Overwritten on every start so changes here take effect after bun push.
cat > /workspace/CLAUDE.md << 'EOF'
# Agent environment

You are Claude Code running as a chat bot agent inside a Kubernetes pod on a
Mac mini. You receive prompts from humans over a chat app (devchitchat) and
respond in that channel. Each prompt is prefixed with [username]: so you can
tell users apart in group channels.

## Workspace

Your working directory is `/workspace`. Repos you work on live here as
subdirectories. Clone repos before working on them (see Mesh below).

## Mesh — peer-to-peer git + CI/CD

A program called **mesh** is running on this pod. Mesh is a p2p git daemon and
CI/CD system that syncs repos between peers (this pod, the Mac mini host, and
any other nodes on the network).

**Cloning a repo:**
```
git clone https://localhost:7979/<repo-name>.git
```
SSL verification is disabled for localhost:7979 — this is expected.

**Listing available repos** — use the HTTP API (mesh CLI runs as root and is not accessible):
```
curl -sk https://localhost:7979/status | grep -o '"name":"[^"]*"'
```

**CI/CD pipelines** are defined in a `.mesh/` folder at the root of each repo,
similar to `.github/workflows/`. Pipelines run automatically on push.

This pod does **not** execute CI jobs. The Mac mini host is the runner;
pipelines triggered by pushes from this pod will execute there.

**Checking pipeline status** — use the HTTP API:
```
curl -sk https://localhost:7979/repos/<repo>/ci
```

## Browser

You have a browser available via MCP tools. Use them to browse the web, fill
forms, click buttons, and read page content — just like a human user would.

Key tools:
- `browser_navigate` — go to a URL
- `browser_snapshot` — read the current page (accessibility tree + text)
- `browser_click` — click an element
- `browser_type` — type into a field
- `browser_take_screenshot` — capture the page as an image

The browser runs headless (no visible window). It starts automatically — no
setup needed.

## Key facts

- Do not try to run Docker or execute CI jobs directly — that happens on the host.
- When you push code, mesh will sync it to peers and the host runner will pick
  up any pipeline defined in `.mesh/`.
- Commit and push to trigger a pipeline. The host runner will build/deploy.
EOF
chown claude:claude /workspace/CLAUDE.md

# Start mesh daemon as root — config and bare repos stay inaccessible to claude
mesh start &

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
