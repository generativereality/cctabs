import { describe, it, expect } from 'bun:test'
import { pluginTimeoutSec, isTransientCurlExit, splitCurlOutput, TabbyPluginRequestError } from './plugin-request.js'

describe('pluginTimeoutSec', () => {
  it('defaults to 30s — /api/tabs took 6s on a loaded machine, against the old 5s cap', () => {
    expect(pluginTimeoutSec({})).toBe(30)
  })
  it('takes CCTABS_TABBY_TIMEOUT, and ignores nonsense', () => {
    expect(pluginTimeoutSec({ CCTABS_TABBY_TIMEOUT: '90' })).toBe(90)
    expect(pluginTimeoutSec({ CCTABS_TABBY_TIMEOUT: '0' })).toBe(30)
    expect(pluginTimeoutSec({ CCTABS_TABBY_TIMEOUT: 'soon' })).toBe(30)
  })
})

describe('isTransientCurlExit', () => {
  it('retries timeouts and dropped connections, not HTTP or usage errors', () => {
    expect(isTransientCurlExit(28)).toBe(true)
    expect(isTransientCurlExit(7)).toBe(true)
    expect(isTransientCurlExit(22)).toBe(false)
    expect(isTransientCurlExit(2)).toBe(false)
    expect(isTransientCurlExit(null)).toBe(false)
  })
})

describe('splitCurlOutput', () => {
  it('separates the body from the status trailer', () => {
    expect(splitCurlOutput('{"tabs":[]}\n200')).toEqual({ status: 200, body: '{"tabs":[]}' })
    expect(splitCurlOutput('{"error":"no matching tab"}\n404')).toEqual({ status: 404, body: '{"error":"no matching tab"}' })
  })
  it('keeps newlines inside the body', () => {
    expect(splitCurlOutput('a\nb\n200')).toEqual({ status: 200, body: 'a\nb' })
  })
  it('is null when there is no trailer — curl gave up before answering', () => {
    expect(splitCurlOutput('')).toBeNull()
    expect(splitCurlOutput('{"tabs":[')).toBeNull()
    expect(splitCurlOutput('x\n000')).toBeNull()
  })
})

describe('TabbyPluginRequestError', () => {
  it('says a timeout is the plugin being slow, not absent, and how to wait longer', () => {
    const e = new TabbyPluginRequestError('Reading the tab list', 'curl exit 28', true)
    expect(e.message).toContain('did not answer within')
    expect(e.message).toContain('CCTABS_TABBY_TIMEOUT')
    expect(e.message).not.toContain('install')
  })
})
