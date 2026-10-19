import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// The plugin is a separate package outside this one's rootDir, so its modules are loaded by
// path at run time (as plugin-version.test.ts reads its files) rather than imported.
type Refusal = { status: number; error: string } | null
const plugin = (file: string) => new URL(`../../tabby-plugin/src/${file}`, import.meta.url).pathname
const { checkRequest } = (await import(plugin('request-guard.ts'))) as {
  checkRequest: (req: { method: string; path: string; headers: Record<string, string> }, token: string | null, boundHost: string) => Refusal
}
const { mintControlToken } = (await import(plugin('control-token.ts'))) as { mintControlToken: () => string }
import { authHeaders, curlAuth, readControlToken } from './control-token.js'

const TOKEN = 'a'.repeat(64)
const req = (over: Partial<{ method: string; path: string; headers: Record<string, string> }> = {}) => ({
  method: 'GET',
  path: '/api/tabs',
  headers: { host: '127.0.0.1:3300', authorization: `Bearer ${TOKEN}` },
  ...over,
})

describe('plugin request guard', () => {
  it('lets the CLI through', () => {
    expect(checkRequest(req(), TOKEN, '127.0.0.1')).toBeNull()
    expect(
      checkRequest(
        req({
          method: 'POST',
          path: '/api/tabs/new',
          headers: { host: 'localhost:3300', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': '2' },
        }),
        TOKEN,
        '127.0.0.1',
      ),
    ).toBeNull()
  })

  it('refuses any request a browser made, token or not', () => {
    const r = checkRequest(req({ headers: { host: '127.0.0.1:3300', origin: 'https://evil.example', authorization: `Bearer ${TOKEN}` } }), TOKEN, '127.0.0.1')
    expect(r?.status).toBe(403)
  })

  it('refuses a rebinding Host', () => {
    const r = checkRequest(req({ headers: { host: 'evil.example:3300', authorization: `Bearer ${TOKEN}` } }), TOKEN, '127.0.0.1')
    expect(r?.status).toBe(403)
    expect(checkRequest(req({ headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN, '127.0.0.1')?.status).toBe(403)
  })

  it('refuses a missing or wrong token, and a tokenless plugin is closed rather than open', () => {
    expect(checkRequest(req({ headers: { host: '127.0.0.1:3300' } }), TOKEN, '127.0.0.1')?.status).toBe(401)
    expect(checkRequest(req({ headers: { host: '127.0.0.1:3300', authorization: 'Bearer nope' } }), TOKEN, '127.0.0.1')?.status).toBe(401)
    expect(checkRequest(req(), null, '127.0.0.1')?.status).toBe(503)
  })

  it('answers /api/health without a token, so a CLI can learn that one is needed', () => {
    expect(checkRequest(req({ path: '/api/health', headers: { host: '[::1]:3300' } }), TOKEN, '127.0.0.1')).toBeNull()
  })

  it('refuses a body not labelled JSON — the shape of a no-preflight form post', () => {
    const r = checkRequest(
      req({
        method: 'POST',
        path: '/api/tabs/new',
        headers: { host: '127.0.0.1:3300', authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain', 'content-length': '40' },
      }),
      TOKEN,
      '127.0.0.1',
    )
    expect(r?.status).toBe(415)
  })
})

describe('control token file', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cctabs-token-'))
    process.env.CCTABS_CONTROL_TOKEN_FILE = join(dir, 'sub', 'control-token')
  })
  afterEach(() => {
    delete process.env.CCTABS_CONTROL_TOKEN_FILE
    rmSync(dir, { recursive: true, force: true })
  })

  it('is minted readable by this user only, and read back by the CLI', () => {
    const token = mintControlToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') {
      expect(statSync(process.env.CCTABS_CONTROL_TOKEN_FILE!).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, 'sub')).mode & 0o777).toBe(0o700)
    }
    expect(readControlToken()).toBe(token)
    expect(authHeaders()).toEqual({ authorization: `Bearer ${token}` })
    expect(mintControlToken()).not.toBe(token)
  })

  it('reads as no token when there is no file, so an old plugin keeps working', () => {
    expect(readControlToken()).toBeNull()
    expect(authHeaders()).toEqual({})
    expect(curlAuth()).toEqual({ args: [] })
  })

  it('reaches the server through curl stdin, never argv', async () => {
    process.env.CCTABS_CONTROL_TOKEN_FILE = join(dir, 'control-token')
    writeFileSync(process.env.CCTABS_CONTROL_TOKEN_FILE, `${TOKEN}\n`)
    const auth = curlAuth()
    expect(auth.args.join(' ')).not.toContain(TOKEN)

    let seen = null as string | null
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen = request.headers.get('authorization')
        return new Response('{}')
      },
    })
    try {
      // Async spawn: a sync one would block the event loop the server answers on.
      const proc = Bun.spawn(['curl', ...auth.args, '-fsS', '--max-time', '5', `http://127.0.0.1:${server.port}/api/tabs`], {
        stdin: new TextEncoder().encode(auth.input),
      })
      await proc.exited
      expect(seen).toBe(`Bearer ${TOKEN}`)
    } finally {
      server.stop(true)
    }
  })
})
