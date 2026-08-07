import { Command } from '@devchitchat/chatopsjs'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'status',
    description: 'Show active repo for this channel.',
    handler:     async ({ envelope, storage }) => {
      const repo = await storage.get(`repo:${envelope.channel.id}`)
      return { text: repo ? `Active repo: \`${repo}\`` : 'No repo active.' }
    },
  }))
}
