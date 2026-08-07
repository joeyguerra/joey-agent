import { Command } from '@devchitchat/chatopsjs'
import config from '../../config.js'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'clone',
    description: `Clone a repo from mesh and set as active. Usage: clone <repo>`,
    handler:     async ({ envelope, storage }) => {
      const repo = envelope.text.trim().split(/\s+/)[1]
      if (!repo) return { text: 'Error: repo name required. Usage: `clone <repo>`' }

      const url  = `${config.meshUrl}/${repo}.git`
      const dest = `${config.workspace}/${repo}`

      const proc = Bun.spawn(['git', 'clone', url, dest], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await proc.exited

      if (proc.exitCode !== 0) {
        const errText = (await new Response(proc.stderr).text()).trim()
        return { text: `Clone failed: ${errText || `exit code ${proc.exitCode}`}` }
      }

      await storage.set(`repo:${envelope.channel.id}`, repo)
      return { text: `Cloned \`${repo}\` — active repo set.` }
    },
  }))
}
