import { Command } from '@devchitchat/chatopsjs'
import { mesh }    from '../../mesh.js'

export default function(robot) {
  robot.commands.register(new Command({
    id:          'repos.list',
    description: 'List repos available on the mesh node.',
    handler:     async () => {
      // /status is an HTML page. Repo names appear as top-level links:
      //   <a href="/repos/<name>">name</a>
      // The pattern stops at '/' so deeper paths like /repos/<name>/ci/...
      // are not matched.
      const data  = await mesh.get('/status')
      const html  = data._raw ?? ''
      const names = [...new Set(
        [...html.matchAll(/href="\/repos\/([^"\/]+)"/g)].map(m => m[1])
      )]

      if (names.length === 0) return { text: 'No repos found on mesh.' }
      return { text: names.map(n => `\`${n}\``).join('\n') }
    },
  }))
}
