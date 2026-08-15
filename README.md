# joey-agent

Claude Code coding agent running in a k3s pod (Lima VM) on a Mac mini. The agent receives chat messages from [devchitchat](https://devchitchat.com), runs Claude Code as a subprocess, and streams responses back to the channel.

## Architecture

```
devchitchat (cloud) ──WebSocket──► bot (Bun, claude user)
                                        │
                                        ▼
                               claude --print (claude user)
                                        │
                               /workspace/<repo> (PVC)
                                        │
                               git push https://localhost:7979/<repo>.git
                                        │
                                        ▼
                               mesh daemon (root) ──sync──► Mac mini mesh
```

- **Bot process** and **Claude Code** run as the `claude` user.
- **mesh** runs as root. Its config, bare repos, and credentials live under `/root/.mesh/`, inaccessible to the claude user.
- The claude user can clone and push via `https://localhost:7979` (git smart-HTTP) but cannot control the mesh daemon (CLI socket is root-only).

## Prerequisites

- [Lima](https://lima-vm.io/) with a k3s VM configured from `local-k8s/k3s-lima.yaml`
- `kubectl` configured with context `k3s-local`
- Docker Desktop (with colima socket at `~/.colima/default/docker.sock`)
- mesh running on your Mac mini (`mesh start`)
- An SSH key at `~/.ssh/id_ed25519_claude_agent`:
  ```sh
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_claude_agent -C "claude-agent"
  ```
- The Lima VM config must forward port 30797 so the Mac can reach the pod's mesh. Already set in `local-k8s/k3s-lima.yaml`. If you change it, restart Lima:
  ```sh
  limactl stop k3s && limactl start k3s
  ```

## First-time setup

### 1. Deploy

```sh
bun run push
```

Builds the image, loads it into k3s, applies the manifests, and waits for the pod to be ready.

### 2. Authenticate Claude

Run once after first deploy. Credentials persist on the PVC and survive pod restarts.

```sh
bun run login
```

Runs `claude auth login` inside the pod via SSH. Copy the printed URL, open it in your Mac browser, authenticate, then paste the code back at the prompt.

> **Note:** Claude credentials are stored at `/home/claude/.claude/` on the PVC, owned by the `claude` user. If you exec into the pod as root (e.g. via k9s), run `su -l claude` before running `claude`.

### 3. Connect mesh peers

On first boot the pod initializes mesh as root, sets its name to `joey-agent`, and registers your Mac mini as a peer at `host.lima.internal:7979`. You still need to complete the invite/join handshake to exchange public keys.

**On your Mac mini** — generate a one-time invite token:
```sh
mesh invite --addr 192.168.5.2:7979
```

**Inside the pod as root** (`bun run ssh` then `sudo -i`) — accept the token:
```sh
mesh join <token>
```

**On your Mac mini** — add the pod as a peer (reachable via Lima port forward):
```sh
mesh add-address joey-agent localhost:30797
```

Verify both sides are connected:
```sh
# On Mac mini
mesh peers
mesh status

# Inside the pod (as root)
mesh peers
mesh status
```

After pairing, repos pushed to either side replicate automatically.

## Daily use

```sh
bun run ssh      # SSH into the pod as the claude user
bun run login    # Re-authenticate Claude (if credentials expire)
bun run push     # Rebuild and redeploy after code changes
bun run teardown # Delete all k8s resources (PVCs are preserved)
```

## Uploading files

The agent can upload files to a channel by running a curl POST to `/api/uploads` and emitting an `[[attach:...]]` marker in its reply. The bot strips the marker and sends the file as a chat attachment. See the CLAUDE.md section inside the pod for the full upload workflow.

## Browser

The agent has a headless browser available via the `@playwright/mcp` MCP server, which starts automatically with each Claude turn. The agent can navigate URLs, click, type, read page content, and take screenshots — no user intervention needed.

Chromium is installed system-wide (`/usr/bin/chromium`). Playwright is configured to use it rather than downloading its own copy.

## Issues

Each repo has a mesh issues board at `https://localhost:7979/repos/<repo>/issues`.

Issue commands (`issues.list`, `issues.create`, `issues.close`, `issues.comment`) are planned but require mesh to expose JSON API endpoints. For now the agent can interact with issues directly via curl in Bash.

## Working with repos

Git repos live at `/workspace` inside the pod. The agent has built-in commands for common repo operations:

| Command | Description |
|---|---|
| `repos.list` | List repos available on the mesh node |
| `clone <repo>` | Clone a repo from mesh and set as active |
| `use <repo>` | Switch active repo (must already exist in `/workspace`) |
| `status` | Show active repo for this channel |

TLS verification for `localhost:7979` is pre-configured in the image for the claude user. The agent can also run git commands directly via Bash.

## Networking

Lima uses SLIRP (user-mode) networking so the pod's mesh is not directly reachable from the Mac mini by IP. Port 30797 is forwarded through Lima to `localhost:30797` on the Mac, configured in `local-k8s/k3s-lima.yaml`.

Inside the pod, the Mac mini is reachable at `host.lima.internal` (injected via `hostAliases` in the deployment, resolves to `192.168.5.2`).

## Persistent storage

| PVC | Mount | Contents |
|---|---|---|
| `joey-agent-claude-creds` | `/home/claude/.claude` | Claude auth, session history, channel-sessions index |
| `joey-agent-mesh-data` | `/root/.mesh` | mesh identity, config, bare repo mirrors, CI logs |
| `joey-agent-workspace` | `/workspace` | Git working copies and project files |

PVCs survive `bun run teardown` and `bun run push`. Delete them manually for a clean slate:
```sh
kubectl delete pvc joey-agent-claude-creds joey-agent-mesh-data joey-agent-workspace
```

## Ports

| NodePort | Container port | Description |
|---|---|---|
| `30022` | `2222` | SSH |
| `30797` | `7979` | mesh HTTP/git |

## Security model

- mesh runs as **root**. Its Unix control socket (`/root/.mesh/sock`, mode 0600) and data directory are inaccessible to the `claude` user. The agent cannot execute mesh CLI commands or modify mesh config.
- The mesh **HTTP service** (`localhost:7979`) is unauthenticated — any local user including the agent can read repo contents, CI run history, and CI logs via HTTP, and can trigger CI pipeline runs via POST. Mesh is designed for trusted networks; this is expected behaviour.
- The **bot token** and other runtime secrets are written to `/home/claude/app/.env` at startup and readable by the `claude` user (required for the bot process to start). The agent has access to this file.
- SSH root login is disabled. Password authentication is disabled; only `~/.ssh/id_ed25519_claude_agent` is accepted.

## Git workflow

Don't commit or push automatically. Let me review code changes first.
