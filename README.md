# joey-agent

Claude Code coding agent running as a non-root user in a k3s pod (Lima VM), accessible over SSH with mesh peer replication.

## Prerequisites

- [Lima](https://lima-vm.io/) with a k3s VM configured from `local-k8s/k3s-lima.yaml`
- `kubectl` configured with context `k3s-local`
- Docker Desktop
- mesh running on your Mac Mini (`mesh start`)
- An SSH key at `~/.ssh/id_ed25519_claude_agent`:
  ```sh
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_claude_agent -C "claude-agent"
  ```
- The Lima VM config must forward port 30797 so the Mac can reach the pod's mesh. This is already set in `local-k8s/k3s-lima.yaml`. If you change the config, restart Lima to apply it:
  ```sh
  limactl stop k3s && limactl start k3s
  ```

## First-time setup

### 1. Deploy

```sh
make deploy
```

Builds the image, loads it into k3s, applies the manifests, and waits for the pod to be ready.

### 2. Authenticate Claude

Run once after first deploy. Credentials are persisted on the PVC and survive pod restarts.

```sh
make login
```

This runs `claude auth login` inside the pod via a login shell. Copy the printed URL, open it in your Mac browser, authenticate, then paste the code back at the `Paste code here if prompted >` prompt.

> **Note:** `claude login` does not work in headless/SSH environments because it uses `https://platform.claude.com/oauth/code/callback` as the redirect URI, which the OAuth server rejects. `claude auth login` uses a code-paste flow that works over SSH.

> **Note:** Claude credentials are stored at `/home/claude/.claude/` on the PVC, owned by the `claude` user. If you exec into the pod as root (e.g. via k9s), run `su -l claude` before running `claude`.

### 3. Connect mesh peers

On first boot the pod initializes mesh, sets its name to `joey-agent`, and registers your Mac Mini as a peer address at `host.lima.internal:7979` (Lima's alias for the Mac host, which resolves to `192.168.5.2` from inside the VM). You still need to complete the invite/join handshake to exchange public keys.

**On your Mac Mini** — generate a one-time invite token:
```sh
mesh invite --addr 192.168.5.2:7979
```

**Inside the pod** (`make ssh`) — accept the token:
```sh
mesh join <token>
```

**On your Mac Mini** — add the pod as a peer (reachable via Lima port forward):
```sh
mesh add-address joey-agent localhost:30797
```

Verify both sides are connected:
```sh
# On Mac Mini
mesh peers
mesh status

# Inside the pod
mesh peers
mesh status
```

After pairing, repos pushed to either side replicate automatically.

## Daily use

```sh
make ssh      # SSH into the pod as the claude user
make login    # Re-authenticate Claude (if credentials expire)
make deploy   # Rebuild and redeploy after image changes
make teardown # Delete all k8s resources (PVCs are preserved)
```

## Working with repos

Git repos live at `/workspace` inside the pod. TLS verification for `localhost:7979` is pre-configured in the image.

```sh
# Clone a repo from the Mac Mini's mesh node
git clone https://localhost:7979/my-repo.git /workspace/my-repo

# Or push an existing repo into mesh from inside the pod
cd /workspace/my-repo
git remote add mesh https://localhost:7979/my-repo.git
git push mesh main
```

## Networking

The pod's mesh is not directly reachable from the Mac Mini via the Lima VM's IP because Lima uses SLIRP (user-mode) networking. Port 30797 is forwarded through Lima to `localhost:30797` on the Mac, configured in `local-k8s/k3s-lima.yaml`.

Inside the pod, the Mac Mini is reachable at `host.lima.internal` (injected via `hostAliases` in the deployment, resolves to `192.168.5.2`).

## Configuration

Defaults can be overridden at the `make` command line:

| Variable | Default | Description |
|---|---|---|
| `LIMA_INSTANCE` | `k3s` | Lima VM name |
| `KUBE_CONTEXT` | `k3s-local` | kubectl context |
| `KUBE_NAMESPACE` | `default` | Kubernetes namespace |

Example:
```sh
make deploy LIMA_INSTANCE=my-vm KUBE_NAMESPACE=agents
```

## Persistent storage

| PVC | Mount | Contents |
|---|---|---|
| `joey-agent-claude-creds` | `/home/claude/.claude` | Claude auth, history, sessions |
| `joey-agent-mesh-data` | `/home/claude/.mesh` | mesh identity, config, repo mirrors |
| `joey-agent-workspace` | `/workspace` | Git repos and project files |

PVCs survive `make teardown` and `make deploy`. Delete them manually if you need a clean slate:
```sh
kubectl delete pvc joey-agent-claude-creds joey-agent-mesh-data joey-agent-workspace
```

## Ports

| NodePort | Container port | Description |
|---|---|---|
| `30022` | `2222` | SSH (non-root, no special capabilities needed) |
| `30797` | `7979` | mesh HTTP/git |

## Security notes

- The pod runs as the `claude` user (non-root). sshd starts as root to bind port 2222 and handle auth, then drops to `claude` for all sessions.
- Root login via SSH is disabled (`PermitRootLogin no`).
- Password authentication is disabled; only the key at `~/.ssh/id_ed25519_claude_agent` is accepted.
- The cluster hosts production services via Cloudflare tunnel — do not relax these settings.

# Git workflow

Don't git commit or push automatically. Let me review code changes and push myself.