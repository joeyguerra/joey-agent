import { Command } from '@devchitchat/chatopsjs'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'help',
    description: 'Show available commands.',
    handler:     async ({ robot: r }) => ({
      text: [
        '**Commands** (prefix all with `@<botname>`):\n',
        ...r.commands.list()
          .filter(c => c.id !== 'help.commands' && c.id !== 'commands.list')
          .map(c => `\`${c.id}\` — ${c.description ?? ''}`),
      ].join('\n'),
    }),
  }))
}
