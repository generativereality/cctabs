import { timingSafeEqual } from 'crypto'

/**
 * Who may call the plugin's HTTP API.
 *
 * The API can open a tab running any command, type into any tab and read any tab's
 * scrollback — it acts with the user's full rights. Listening on loopback keeps other
 * machines out, but not other things on this one: any local process, and any web page the
 * user has open (a "simple" cross-origin POST needs no preflight, and DNS rebinding can make
 * a page look same-origin). So every request has to prove it came from the cctabs CLI:
 *
 * - **No `Origin` header.** Browsers send one on every cross-origin request and on every
 *   POST; the CLI (curl, Node fetch) never does.
 * - **A loopback `Host`.** Defeats DNS rebinding, where the page's own hostname resolves
 *   to 127.0.0.1.
 * - **The control token**, a random secret the plugin writes to a file only this OS user
 *   can read (see `control-token.ts`). Without it, another local user's process or a
 *   sandboxed app can reach the port but cannot use it.
 * - **A JSON body is labelled JSON**, so a `text/plain` form post is not parsed as one.
 *
 * `/api/health` answers without the token — it reveals only the version and capabilities,
 * and it is how a CLI finds out whether this plugin wants a token at all.
 *
 * Pure (no Angular, no Tabby imports) so the CLI's test suite can exercise it directly.
 */

export interface GuardRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
}

export interface GuardRefusal {
  status: number
  error: string
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function header (req: GuardRequest, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function hostname (hostHeader: string): string {
  // `[::1]:3300` → `[::1]`; `127.0.0.1:3300` → `127.0.0.1`.
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(hostHeader)
  if (bracketed) return bracketed[1].toLowerCase()
  return hostHeader.replace(/:\d+$/, '').toLowerCase()
}

function sameSecret (given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Null when the request may proceed, otherwise the status and message to answer with.
 * `boundHost` is the address the server listens on, accepted as a Host in addition to the
 * loopback names when someone has configured a non-default one.
 */
export function checkRequest (req: GuardRequest, token: string | null, boundHost: string): GuardRefusal | null {
  if (header(req, 'origin') !== undefined) {
    return { status: 403, error: 'requests from a web page are refused' }
  }

  const host = header(req, 'host')
  if (!host || !(LOOPBACK_HOSTS.has(hostname(host)) || hostname(host) === boundHost.toLowerCase())) {
    return { status: 403, error: 'the Host header must name this machine' }
  }

  if (req.method === 'GET' && req.path === '/api/health') return null

  if (!token) return { status: 503, error: 'the plugin has no control token yet' }
  const auth = header(req, 'authorization') ?? ''
  const given = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
  if (!given || !sameSecret(given, token)) {
    return {
      status: 401,
      error: 'missing or wrong control token: update the cctabs CLI, which reads it from the token file',
    }
  }

  if (req.method !== 'GET') {
    const type = (header(req, 'content-type') ?? '').split(';')[0].trim().toLowerCase()
    const length = header(req, 'content-length')
    const hasBody = (length !== undefined && length !== '0') || header(req, 'transfer-encoding') !== undefined
    if (hasBody && type !== 'application/json') {
      return { status: 415, error: 'a request body must be application/json' }
    }
  }

  return null
}
