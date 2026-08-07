import { Command } from '@devchitchat/chatopsjs'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'use',
    description: 'Set active repo for this channel. Usage: use <repo>',
    handler:     async ({ envelope, storage }) => {
      const repo = envelope.text.trim().split(/\s+/)[1]
      if (!repo) return { text: 'Error: repo name required. Usage: `use <repo>`' }
      await storage.set(`repo:${envelope.channel.id}`, repo)
      return { text: `Active repo: \`${repo}\`` }
    },
  }))
}
