import { Command }               from '@devchitchat/chatopsjs'
import { mesh, resolveRepo }    from '../../mesh.js'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'issues.list',
    description: 'List open issues for the active repo. Usage: issues.list [--repo <name>]',
    args: {
      repo: { type: 'string', required: false },
    },
    handler: async ({ args, envelope, storage }) => {
      const repo = await resolveRepo(args, storage, envelope.channel.id)
      if (!repo) return { text: 'Error: no active repo. Use `use <repo>` or pass `--repo <name>`.' }

      const data   = await mesh.get(`/repos/${repo}/issues`)
      const issues = Array.isArray(data) ? data : (data.issues ?? [])

      if (issues.length === 0) return { text: `No open issues for \`${repo}\`.` }

      const lines = issues.map(i => {
        const labels = i.labels?.length ? `  [${i.labels.join(', ')}]` : ''
        return `\`${i.id}\`  ${i.title}${labels}`
      })

      return { text: `**Open issues for \`${repo}\`:**\n${lines.join('\n')}` }
    },
  }))
}
