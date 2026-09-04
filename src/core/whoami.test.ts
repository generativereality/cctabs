import { describe, it, expect } from 'bun:test'
import { resolveIdentity, worktreeOf, UNKNOWN_TAB, type WhoamiTab } from './whoami.js'
import { pathToProjectSlug } from './session.js'

describe('worktreeOf', () => {
  it('names the worktree a cwd sits in, in the form a reader is given', () => {
    expect(worktreeOf('/Users/x/Dev/horizon/.claude/worktrees/dropoff-ux'))
      .toBe('.claude/worktrees/dropoff-ux')
  })

  it('names it from a subdirectory of the worktree, not just its root', () => {
    expect(worktreeOf('/Users/x/Dev/horizon/.claude/worktrees/dropoff-ux/app/src'))
      .toBe('.claude/worktrees/dropoff-ux')
  })

  it('is null for a plain repo checkout', () => {
    expect(worktreeOf('/Users/x/Dev/horizon')).toBeNull()
    expect(worktreeOf('/Users/x/Dev/horizon-cache-cleanup')).toBeNull()
  })

  it('still answers for a worktree that has been deleted', () => {
    // Textual on purpose: a reader asking "what was this session working on?"
    // needs the answer precisely when the directory is gone.
    expect(worktreeOf('/nonexistent/repo/.claude/worktrees/gone'))
      .toBe('.claude/worktrees/gone')
  })

  it('is not fooled by a similarly-named directory', () => {
    expect(worktreeOf('/Users/x/worktrees/thing')).toBeNull()
  })

  it('handles null/empty without throwing', () => {
    expect(worktreeOf(null)).toBeNull()
    expect(worktreeOf(undefined)).toBeNull()
    expect(worktreeOf('')).toBeNull()
  })
})

const tab = (tabId: string, name: string, cwd?: string): WhoamiTab => ({ tabId, name, cwd })

describe('resolveIdentity', () => {
  const tabs = [
    tab('t1', 'coordination', '/Users/x/Dev/horizon'),
    tab('t2', 'dropoff-ux', '/Users/x/Dev/horizon/.claude/worktrees/dropoff-ux'),
    tab('t3', 'other', '/Users/x/Dev/other'),
  ]

  it('uses the process-tree match when the terminal supplies one', () => {
    const id = resolveIdentity({ sessionId: 's1', tabs, currentTabId: 't2' })
    expect(id.tab).toBe('dropoff-ux')
    expect(id.via).toBe('pid')
    expect(id.worktree).toBe('.claude/worktrees/dropoff-ux')
  })

  it('falls back to the session\'s own project slug when the pid walk finds nothing', () => {
    // The case the horizon convention warns about: an SSH hop or a deep process
    // chain breaks the pid match, but the session still knows its own id.
    const id = resolveIdentity({
      sessionId: 's1',
      tabs,
      currentTabId: undefined,
      sessionSlug: pathToProjectSlug('/Users/x/Dev/horizon/.claude/worktrees/dropoff-ux'),
      slugOf: pathToProjectSlug,
    })
    expect(id.tab).toBe('dropoff-ux')
    expect(id.via).toBe('session-slug')
  })

  it('refuses the fallback when two tabs share the directory', () => {
    // Indistinguishable this way, and inventing an answer is the failure the
    // command exists to prevent.
    const ambiguous = [...tabs, tab('t4', 'coordination-2', '/Users/x/Dev/horizon')]
    const id = resolveIdentity({
      sessionId: 's1',
      tabs: ambiguous,
      sessionSlug: pathToProjectSlug('/Users/x/Dev/horizon'),
      slugOf: pathToProjectSlug,
    })
    expect(id.tab).toBeNull()
    expect(id.via).toBeNull()
  })

  it('prefers the pid match over the slug fallback when both are available', () => {
    const id = resolveIdentity({
      sessionId: 's1',
      tabs,
      currentTabId: 't3',
      sessionSlug: pathToProjectSlug('/Users/x/Dev/horizon'),
      slugOf: pathToProjectSlug,
    })
    expect(id.tab).toBe('other')
    expect(id.via).toBe('pid')
  })

  it('reports no tab rather than guessing when neither route answers', () => {
    const id = resolveIdentity({ sessionId: 's1', tabs })
    expect(id.tab).toBeNull()
    expect(id.tabId).toBeNull()
    expect(id.via).toBeNull()
    expect(id.sessionId).toBe('s1')
  })

  it('still reports the session id when there is no tab at all', () => {
    // A session in a plain terminal, over SSH or in CI: callers are meant to
    // say "unnamed session", which needs the id to still be available.
    const id = resolveIdentity({ sessionId: 's9', tabs: [] })
    expect(id.tab).toBeNull()
    expect(id.sessionId).toBe('s9')
  })

  it('carries the Claude account through', () => {
    const id = resolveIdentity({
      sessionId: 's1', tabs, currentTabId: 't1',
      origin: { backend: 'enterprise', configDir: '/Users/x/.claude-enterprise' },
    })
    expect(id.backend).toBe('enterprise')
    expect(id.configDir).toBe('/Users/x/.claude-enterprise')
  })

  it('never consults a "focused tab" notion', () => {
    // Focus is a different question and reads false for a background tab
    // running the command — matching on it is the documented trap.
    const id = resolveIdentity({ sessionId: 's1', tabs, currentTabId: 't1' })
    expect(id.tab).toBe('coordination')
  })

  it('exposes the sentinel callers match on', () => {
    expect(UNKNOWN_TAB).toBe('unknown')
  })
})
