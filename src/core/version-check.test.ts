import { describe, it, expect } from 'bun:test'
import { isNewer, outdatedBanner } from './version-check.js'

describe('isNewer', () => {
  it('compares numerically, not as text', () => {
    expect(isNewer('0.5.10', '0.5.9')).toBe(true)
    expect(isNewer('0.5.9', '0.5.10')).toBe(false)
  })
  it('is false for equal versions', () => {
    expect(isNewer('0.5.9', '0.5.9')).toBe(false)
  })
  it('ranks a release above its prerelease', () => {
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true)
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false)
  })
  it('never calls garbage newer', () => {
    expect(isNewer('latest', '0.5.0')).toBe(false)
  })
})

describe('outdatedBanner', () => {
  it('warns when a newer release exists', () => {
    expect(outdatedBanner({ current: '0.5.9', latest: '0.5.10' }, 'p')).toContain('OUTDATED 0.5.9 < 0.5.10')
  })
  it('stays quiet when the cached "latest" is older than what is installed', () => {
    // The observed `OUTDATED 0.5.2 < 0.5.0`: a stale cache after an upgrade.
    expect(outdatedBanner({ current: '0.5.2', latest: '0.5.0' }, 'p')).toBeNull()
  })
  it('stays quiet with no update info', () => {
    expect(outdatedBanner(undefined, 'p')).toBeNull()
  })
})
