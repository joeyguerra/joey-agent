import { Command } from '@devchitchat/chatopsjs'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'help',
    description: 'Show available commands.',
    handler:     async ({ robot: r }) => {
      const handle = r.adapters.get('devchitchat')?.botHandle ?? 'bot'
      const lines  = r.commands.list()
        .filter(c => c.id !== 'help.commands' && c.id !== 'commands.list')
        .map(c => `\`${c.id}\` — ${c.description ?? ''}`)
      return {
        text: [`**Commands** (prefix all with \`@${handle}\`):\n`, ...lines].join('\n'),
      }
    },
  }))
}
