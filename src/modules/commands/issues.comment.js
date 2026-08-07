import { Command }               from '@devchitchat/chatopsjs'
import { mesh, resolveRepo }    from '../../mesh.js'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'issues.comment',
    description: 'Add a comment to an issue. Usage: issues.comment --id <issue-id> --body <text> [--repo <name>]',
    args: {
      id:   { type: 'string', required: true },
      body: { type: 'string', required: true },
      repo: { type: 'string', required: false },
    },
    handler: async ({ args, envelope, storage }) => {
      const repo = await resolveRepo(args, storage, envelope.channel.id)
      if (!repo) return { text: 'Error: no active repo. Use `use <repo>` or pass `--repo <name>`.' }

      await mesh.post(`/repos/${repo}/issues/${args.id}/comment`, { body: args.body })
      return { text: `Comment added to \`${args.id}\`.` }
    },
  }))
}
