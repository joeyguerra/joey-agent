import { Command } from '@devchitchat/chatopsjs'
import { mesh }    from '../../mesh.js'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'repos.list',
    description: 'List repos available on the mesh node.',
    handler:     async () => {
      const data  = await mesh.get('/status')
      const repos = data.repos ?? []
      if (repos.length === 0) return { text: 'No repos found on mesh.' }
      return { text: repos.map(r => `\`${r.name}\``).join('\n') }
    },
  }))
}
