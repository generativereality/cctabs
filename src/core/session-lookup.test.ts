import { describe, it, expect } from 'bun:test'
import { classifySessionLookup, explainSessionLookup } from './session-lookup.js'

describe('classifySessionLookup', () => {
  const never = () => { throw new Error('should not count') }

  it('reports found without paying for a count', () => {
    expect(classifySessionLookup({ cwd: '/repo', found: true, countInDir: never }))
      .toEqual({ status: 'found' })
  })

  it('reports no-cwd when there was nothing to look up', () => {
    expect(classifySessionLookup({ cwd: '', found: false, countInDir: never }))
      .toEqual({ status: 'no-cwd' })
  })

  // The distinction the whole type exists for: a lookup that threw is UNKNOWN,
  // not absent, and a caller that treats it as absent will spawn over a live
  // session or write one off as dead.
  it('reports lookup-failed, with the error, in preference to not-found', () => {
    const r = classifySessionLookup({
      cwd: '/repo', found: false, error: new Error('EACCES'), countInDir: never,
    })
    expect(r.status).toBe('lookup-failed')
    expect(r.detail).toBe('EACCES')
  })

  it('an error with no cwd is still lookup-failed, not no-cwd', () => {
    expect(classifySessionLookup({ cwd: '', found: false, error: new Error('boom'), countInDir: never }).status)
      .toBe('lookup-failed')
  })

  it('reports not-found with the directory transcript count', () => {
    expect(classifySessionLookup({ cwd: '/repo', found: false, countInDir: () => 4 }))
      .toEqual({ status: 'not-found', sessionsInDir: 4 })
  })
})

describe('explainSessionLookup', () => {
  it('says nothing for a resolved session', () => {
    expect(explainSessionLookup({ status: 'found' })).toBeNull()
  })

  // "renamed" vs "never ran here" are the two readings of not-found, and they
  // call for opposite responses.
  it('distinguishes a renamed tab from a directory with no history', () => {
    expect(explainSessionLookup({ status: 'not-found', sessionsInDir: 3 })).toContain('renamed')
    expect(explainSessionLookup({ status: 'not-found', sessionsInDir: 0 })).toContain('has ever run')
  })

  it('marks a failed lookup as unknown rather than absent', () => {
    expect(explainSessionLookup({ status: 'lookup-failed', detail: 'EACCES' }))
      .toContain('unknown, not absent')
  })

  it('explains a missing cwd', () => {
    expect(explainSessionLookup({ status: 'no-cwd' })).toContain('no working directory')
  })
})
