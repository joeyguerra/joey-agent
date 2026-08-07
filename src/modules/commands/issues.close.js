import { Command }               from '@devchitchat/chatopsjs'
import { mesh, resolveRepo }    from '../../mesh.js'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'issues.close',
    description: 'Close an issue. Usage: issues.close --id <issue-id> [--repo <name>]',
    args: {
      id:   { type: 'string', required: true },
      repo: { type: 'string', required: false },
    },
    handler: async ({ args, envelope, storage }) => {
      const repo = await resolveRepo(args, storage, envelope.channel.id)
      if (!repo) return { text: 'Error: no active repo. Use `use <repo>` or pass `--repo <name>`.' }

      await mesh.post(`/repos/${repo}/issues/${args.id}/status`, { status: 'closed' })
      return { text: `Issue \`${args.id}\` closed.` }
    },
  }))

  robot.commands.register(new Command({
    id:          'issues.reopen',
    description: 'Reopen a closed issue. Usage: issues.reopen --id <issue-id> [--repo <name>]',
    args: {
      id:   { type: 'string', required: true },
      repo: { type: 'string', required: false },
    },
    handler: async ({ args, envelope, storage }) => {
      const repo = await resolveRepo(args, storage, envelope.channel.id)
      if (!repo) return { text: 'Error: no active repo. Use `use <repo>` or pass `--repo <name>`.' }

      await mesh.post(`/repos/${repo}/issues/${args.id}/status`, { status: 'open' })
      return { text: `Issue \`${args.id}\` reopened.` }
    },
  }))
}
