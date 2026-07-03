import { describe, it, expect } from 'bun:test'
import { applyPrefix } from './config.js'

describe('applyPrefix', () => {
  it('prepends the prefix to a bare name', () => {
    expect(applyPrefix('auth', 'mbp18-')).toBe('mbp18-auth')
  })

  it('is a no-op when the prefix is empty (default install)', () => {
    expect(applyPrefix('auth', '')).toBe('auth')
  })

  it('does not double-prefix a name that already carries it', () => {
    expect(applyPrefix('mbp18-auth', 'mbp18-')).toBe('mbp18-auth')
  })

  it('treats an explicitly-typed full name as already-prefixed', () => {
    // User typed the whole thing — startsWith guard leaves it untouched.
    expect(applyPrefix('mbp18-api', 'mbp18-')).toBe('mbp18-api')
  })

  it('only guards on a true prefix, not a mid-string match', () => {
    expect(applyPrefix('my-mbp18-thing', 'mbp18-')).toBe('mbp18-my-mbp18-thing')
  })
})
