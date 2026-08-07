import { Command }               from '@devchitchat/chatopsjs'
import { mesh, resolveRepo }    from '../../mesh.js'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'issues.create',
    description: 'Create an issue on the active repo. Usage: issues.create --title <title> [--body <body>] [--labels <label,...>] [--repo <name>]',
    args: {
      title:  { type: 'string', required: true },
      body:   { type: 'string', required: false },
      labels: { type: 'string', required: false },
      repo:   { type: 'string', required: false },
    },
    handler: async ({ args, envelope, storage }) => {
      const repo = await resolveRepo(args, storage, envelope.channel.id)
      if (!repo) return { text: 'Error: no active repo. Use `use <repo>` or pass `--repo <name>`.' }

      const fields = { title: args.title }
      if (args.body)   fields.body   = args.body
      if (args.labels) fields.labels = args.labels

      const data = await mesh.post(`/repos/${repo}/issues`, fields)
      const id   = data.id ?? data.issue_id ?? '?'
      return { text: `Issue created: \`${id}\` — ${args.title}` }
    },
  }))
}
