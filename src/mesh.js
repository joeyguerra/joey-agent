/**
 * Thin wrapper around the mesh HTTP API at https://localhost:7979.
 * TLS verification is always disabled for this endpoint by design.
 */
import config from './config.js'

const TLS = { rejectUnauthorized: false }

async function request(method, path, fields) {
  const url = `${config.meshUrl}${path}`
  const options = { method, tls: TLS }

  if (fields) {
    options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
    options.body    = new URLSearchParams(fields).toString()
  }

  const res  = await fetch(url, options)
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`mesh ${method} ${path} → ${res.status}: ${text.trim()}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    // Return raw text wrapped so callers can still inspect it
    return { _raw: text }
  }
}

export const mesh = {
  get:  (path)         => request('GET',  path),
  post: (path, fields) => request('POST', path, fields),
}

/** Resolve the repo to use: prefer explicit arg, fall back to per-channel storage. */
export async function resolveRepo(args, storage, channelId) {
  return args.repo ?? await storage.get(`repo:${channelId}`) ?? null
}
