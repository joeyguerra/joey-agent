import { Robot }                from '@devchitchat/chatopsjs'
import { DevchitchatAdapter }  from './adapters/DevchitchatAdapter.js'

const robot   = await Robot.create({
  directory: './modules',
  baseUrl:   import.meta.url,
})

const adapter = new DevchitchatAdapter(robot)
robot.adapters.add(adapter)

await adapter.start()
console.log('[bot] connecting to devchitchat…')
