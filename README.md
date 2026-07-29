# joey-agent

Claude Code coding agent running in a k3s pod (Lima VM), accessible over SSH with mesh peer replication.

## Prerequisites

- [Lima](https://lima-vm.io/) with a k3s VM named `k3s`
- `kubectl` configured with context `k3s-local`
- Docker Desktop
- An SSH key at `~/.ssh/id_ed25519_claude_agent` (generate with `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_claude_agent -C "claude-agent"`)
- mesh running on your Mac Mini (`mesh start`)

## First-time setup

### 1. Deploy

```sh
make deploy
```

Builds the image, loads it into k3s, applies the manifests, and waits for the pod to be ready.

### 2. Authenticate Claude

Run once after first deploy. Credentials are persisted on a PVC and survive pod restarts.

```sh
make login
```

This runs `claude auth login` inside the pod. Copy the printed URL, open it in your browser, authenticate, then paste the code back at the prompt.

### 3. Connect mesh peers

The pod automatically initializes mesh and registers your Mac Mini as a peer address (`host.lima.internal:7979`) on first boot. You still need to complete the invite/join handshake to exchange public keys.

**On your Mac Mini:**
```sh
# Get the Mac's IP (MAC_IP) as seen from the Lima VM
limactl shell k3s -- getent hosts host.lima.internal

# Generate a one-time invite token
mesh invite --addr <MAC_IP>:7979
```

**Inside the pod** (`make ssh`):
```sh
mesh join <token>
```

Verify the peers are connected:
```sh
# In the pod
mesh peers
mesh status
```

**Add the pod as a peer on the Mac Mini:**
```sh
# The pod's mesh is exposed via NodePort 30797 on the Lima VM
limactl shell k3s -- hostname -I   # get Lima VM IP
mesh add-address joey-agent <LIMA_VM_IP>:30797
```

After pairing, repos pushed to either side replicate automatically.

## Daily use

```sh
make ssh      # SSH into the pod
make deploy   # Rebuild and redeploy (after code changes)
make teardown # Delete all k8s resources
```

## Working with repos

Git repos live at `/workspace` inside the pod. Add the pod's mesh as a remote and push:

```sh
# Clone from the Mac Mini's mesh (TLS verification is pre-configured in the image)
git clone https://localhost:7979/my-repo.git /workspace/my-repo
```

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
| `joey-agent-claude-creds` | `/root/.claude` | Claude auth, history, sessions |
| `joey-agent-mesh-data` | `/root/.mesh` | mesh identity, config, repo mirrors |
| `joey-agent-workspace` | `/workspace` | Git repos and project files |

## Ports

| NodePort | Target | Description |
|---|---|---|
| `30022` | `22` | SSH |
| `30797` | `7979` | mesh HTTP/git |
