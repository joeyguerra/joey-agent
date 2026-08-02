import { join } from 'node:path'
import { realpathSync, mkdirSync } from 'node:fs'
import config from './config.js'

// Resolve symlinks at startup so we always have the real path.
const CLAUDE_BIN = (() => {
  try { return realpathSync(config.claudeBin) } catch { return config.claudeBin }
})()

const MAX_TURN_LEN = 1_900   // stay under typical chat message size limits

/**
 * Drives claude CLI via --print --output-format stream-json.
 * Yields chat-safe text chunks as Claude works.
 *
 * Session IDs are stored per-repo so each subsequent turn in the same channel
 * resumes with full LLM context (--resume <session_id>). Call clearSession()
 * to start fresh.
 */
export class ClaudeAgent {
  #sessions = new Map()   // channelId → session_id string

  async *run(prompt, repo, channelId) {
    const cwd = repo ? join(config.workspace, repo) : config.workspace
    mkdirSync(cwd, { recursive: true })

    const sessionId = this.#sessions.get(channelId)

    const claudeArgs = [
      CLAUDE_BIN,
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      ...(sessionId ? ['--resume', sessionId] : []),
      prompt,
    ]

    const proc = Bun.spawn(claudeArgs, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })

    const reader  = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let lineBuffer = ''
    const textParts = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lineBuffer += decoder.decode(value, { stream: true })

      const lines = lineBuffer.split('\n')
      lineBuffer  = lines.pop()   // hold back the incomplete trailing line

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let event
        try { event = JSON.parse(trimmed) } catch { continue }

        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_use') {
              const status = toolStatusLine(block)
              if (status) yield status
            } else if (block.type === 'text' && block.text?.trim()) {
              textParts.push(block.text.trim())
            }
          }
        } else if (event.type === 'result') {
          // Persist the session ID for the next turn
          if (event.session_id) this.#sessions.set(channelId, event.session_id)

          if (textParts.length > 0) {
            yield* chunked(textParts.join('\n\n'))
            textParts.length = 0
          }
          if (event.subtype !== 'success') {
            yield `_(${event.subtype})_`
          }
        }
      }
    }

    // Flush any remaining text
    if (textParts.length > 0) {
      yield* chunked(textParts.join('\n\n'))
    }

    await proc.exited

    if (proc.exitCode !== 0) {
      const errText = await new Response(proc.stderr).text()
      if (errText.trim()) yield `Error: ${errText.trim().slice(0, MAX_TURN_LEN)}`
    }
  }

  clearSession(channelId) {
    this.#sessions.delete(channelId)
  }
}

function toolStatusLine({ name, input }) {
  switch (name) {
    case 'Read':       return `📖 \`${input.file_path}\``
    case 'Write':      return `✏️  \`${input.file_path}\``
    case 'Edit':       return `✏️  \`${input.file_path}\``
    case 'MultiEdit':  return `✏️  \`${input.file_path}\``
    case 'Bash':       return `🔧 \`${String(input.command ?? '').slice(0, 80)}\``
    case 'Glob':       return `🔍 glob \`${input.pattern}\``
    case 'Grep':       return `🔍 grep \`${input.pattern}\``
    case 'WebFetch':   return `🌐 \`${input.url}\``
    case 'WebSearch':  return `🌐 search \`${input.query}\``
    case 'TodoWrite':  return `📋 updating plan`
    default:           return null
  }
}

function* chunked(text) {
  if (text.length <= MAX_TURN_LEN) {
    yield text
    return
  }
  for (let i = 0; i < text.length; i += MAX_TURN_LEN) {
    yield text.slice(i, i + MAX_TURN_LEN)
  }
}
