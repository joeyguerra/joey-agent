import { Command }               from '@devchitchat/chatopsjs'
import { mesh, resolveRepo }    from '../../mesh.js'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'ci.status',
    description: 'Show recent CI pipeline runs for the active repo. Usage: ci.status [--repo <name>]',
    args: {
      repo: { type: 'string', required: false },
    },
    handler: async ({ args, envelope, storage }) => {
      const repo = await resolveRepo(args, storage, envelope.channel.id)
      if (!repo) return { text: 'Error: no active repo. Use `use <repo>` or pass `--repo <name>`.' }

      const data = await mesh.get(`/repos/${repo}/ci`)
      const runs = data.runs ?? data.pipelines ?? (Array.isArray(data) ? data : [])

      if (runs.length === 0) return { text: `No CI runs found for \`${repo}\`.` }

      const lines = runs.slice(0, 10).map(r => {
        const status  = r.status ?? r.state ?? '?'
        const branch  = r.branch ? ` (${r.branch})` : ''
        const trigger = r.trigger ?? r.event ?? ''
        const ts      = r.started_at ?? r.created_at ?? ''
        return `${status.padEnd(8)} ${r.pipeline ?? r.name ?? ''}${branch}  ${trigger}  ${ts}`.trimEnd()
      })

      return { text: `**CI runs for \`${repo}\`:**\n\`\`\`\n${lines.join('\n')}\n\`\`\`` }
    },
  }))
}
