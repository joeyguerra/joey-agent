import { join } from 'node:path'
import { homedir } from 'node:os'
import { realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import config from './config.js'

const SESSION_INDEX_PATH = join(homedir(), '.claude', 'channel-sessions.json')

function loadSessionIndex() {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(SESSION_INDEX_PATH, 'utf8'))))
  } catch {
    return new Map()
  }
}

function saveSessionIndex(sessions) {
  try {
    writeFileSync(SESSION_INDEX_PATH, JSON.stringify(Object.fromEntries(sessions)), 'utf8')
  } catch (err) {
    console.warn(`[claude] could not save session index: ${err.message}`)
  }
}

// Resolve symlinks at startup so we always have the real path.
const CLAUDE_BIN = (() => {
  try {
    const resolved = realpathSync(config.claudeBin)
    console.log(`[claude] CLAUDE_BIN resolved: ${config.claudeBin} → ${resolved}`)
    return resolved
  } catch (err) {
    console.warn(`[claude] could not resolve CLAUDE_BIN ${config.claudeBin}: ${err.message}`)
    return config.claudeBin
  }
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
  #sessions = loadSessionIndex()   // channelId → session_id string

  async *run(prompt, repo, channelId) {
    const cwd = repo ? join(config.workspace, repo) : config.workspace
    mkdirSync(cwd, { recursive: true })

    const sessionId = this.#sessions.get(channelId)
    console.log(`[claude] run — cwd=${cwd} sessionId=${sessionId ?? '(new)'} prompt=${JSON.stringify(prompt.slice(0, 80))}`)

    const claudeArgs = [
      CLAUDE_BIN,
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      ...(sessionId ? ['--resume', sessionId] : []),
      prompt,
    ]

    console.log(`[claude] spawn: ${claudeArgs.slice(0, 5).join(' ')} ...`)

    const proc = Bun.spawn(claudeArgs, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })
    console.log(`[claude] spawned pid=${proc.pid}`)

    // Stream stderr to console in real-time and collect for error reporting
    let stderrText = ''
    const stderrDone = (async () => {
      const errReader = proc.stderr.getReader()
      const errDecoder = new TextDecoder()
      while (true) {
        const { done, value } = await errReader.read()
        if (done) break
        const text = errDecoder.decode(value, { stream: true })
        stderrText += text
        if (text.trim()) console.error(`[claude stderr] ${text.trimEnd()}`)
      }
    })()

    const reader  = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let lineBuffer = ''

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

        console.log(`[claude] stream event type=${event.type}`)
        if (event.type === 'assistant') {
          const blockTypes = (event.message?.content ?? []).map(b => b.type).join(',')
          console.log(`[claude] assistant event — blocks: ${blockTypes}`)
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_use') {
              const status = toolStatusLine(block)
              console.log(`[claude] tool_use: ${block.name}`)
              if (status) yield status
            } else if (block.type === 'text' && block.text?.trim()) {
              // Yield text immediately as each assistant turn completes
              yield* chunked(block.text.trim())
            }
          }
        } else if (event.type === 'result') {
          console.log(`[claude] result event — subtype=${event.subtype} session_id=${event.session_id}`)
          // Persist the session ID for the next turn
          if (event.session_id) {
            this.#sessions.set(channelId, event.session_id)
            saveSessionIndex(this.#sessions)
          }

          if (event.subtype !== 'success') {
            yield `_(${event.subtype})_`
          }
        }
      }
    }

    await Promise.all([proc.exited, stderrDone])
    console.log(`[claude] process exited — exitCode=${proc.exitCode}`)

    if (proc.exitCode !== 0) {
      if (stderrText.trim()) yield `Error: ${stderrText.trim().slice(0, MAX_TURN_LEN)}`
    }
  }

  clearSession(channelId) {
    this.#sessions.delete(channelId)
    saveSessionIndex(this.#sessions)
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
