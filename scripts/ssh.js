#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'

const ns        = process.env.KUBE_NAMESPACE ?? 'default'
const context   = process.env.KUBE_CONTEXT   ?? 'k3s-local'
const sshKey    = process.env.SSH_KEY        ?? `${process.env.HOME}/.ssh/id_ed25519_claude_agent`

spawnSync('ssh-keygen', ['-R', '[localhost]:2222'], { stdio: 'ignore' })
spawnSync('pkill', ['-f', 'port-forward.*joey-agent.*2222'], { stdio: 'ignore' })

spawnSync('kubectl', ['config', 'use-context', context], { stdio: 'inherit' })

const pf = Bun.spawn(['kubectl', 'port-forward', 'deployment/joey-agent', '2222:2222', '-n', ns], {
  stdout: 'ignore', stderr: 'ignore',
})

await Bun.sleep(1000)

spawnSync('ssh', ['-i', sshKey, '-p', '2222', '-o', 'StrictHostKeyChecking=no', 'claude@localhost'], {
  stdio: 'inherit',
})

pf.kill()
