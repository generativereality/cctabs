import { describe, it, expect } from 'bun:test'
import { codexArgs, codexStartupSettled, codexReady, codexStatus, codexTrustDialog, isCodexCommand, parseEngine } from './codex.js'

// Real screens, Codex CLI 0.162.1 on macOS via the plugin's `screen` endpoint.
const TRUST = `  Folder access
  /tmp/x
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
› 1. Trust and continue
  2. Back to Agent Command Center
  enter continue · esc back`
const BUSY = `  >_ OpenAI Codex (v0.162.1)
› reply with just: ready
• Working (2s • esc to interrupt)
› Ask Codex to do anything
  GPT-6.1-Sol default · /tmp/x
  ← for agents · ? for shortcuts`
const DONE = `  >_ OpenAI Codex (v0.162.1)
› reply with just: ready
• Working (2s • esc to interrupt)
• ready
  Worked for 3s • 20:07
› Ask Codex to do anything
  ← for agents · ? for shortcuts`

describe('parseEngine', () => {
  it('defaults to claude and accepts codex', () => {
    expect(parseEngine(undefined)).toBe('claude')
    expect(parseEngine('codex')).toBe('codex')
    expect(parseEngine('gemini')).toBeNull()
  })
})

describe('codexArgs', () => {
  it('puts the prompt on argv, so nothing is typed into the TUI', () => {
    expect(codexArgs({ prompt: 'do the thing' })).toEqual(['do the thing'])
  })
  it('makes Codex read CLAUDE.md when asked', () => {
    expect(codexArgs({ prompt: 'p', readClaudeMd: true })).toEqual(['-c', 'project_doc_fallback_filenames=["CLAUDE.md"]', 'p'])
  })
  it('resumes by id, with flags after the subcommand', () => {
    expect(codexArgs({ resumeId: 'abc', model: 'gpt-x' })).toEqual(['resume', '-m', 'gpt-x', 'abc'])
  })
})

it('forks the exact source session with flags after the subcommand', () => {
  expect(codexArgs({ forkId: 'source-id', model: 'test-model', extraFlags: ['--no-alt-screen'] })).toEqual(['fork', '--no-alt-screen', '-m', 'test-model', 'source-id'])
  expect(() => codexArgs({ forkId: 'a', resumeId: 'b' })).toThrow()
})

describe('Codex screens', () => {
  it('sees the trust prompt with the cursor on "Trust and continue"', () => {
    expect(codexTrustDialog(TRUST)).toEqual({ visible: true, onTrust: true })
    expect(codexTrustDialog(BUSY).visible).toBe(false)
  })
  it('is ready only at the input, not in the trust prompt', () => {
    expect(codexReady(DONE)).toBe(true)
    expect(codexReady(TRUST)).toBe(false)
  })
  it('reads busy and idle, and an earlier turn\'s busy line does not keep it busy', () => {
    expect(codexStatus(BUSY)).toBe('active')
    expect(codexStatus(DONE)).toBe('idle')
    expect(codexStatus('motin@mbp ~ %')).toBeUndefined()
  })
})

describe('isCodexCommand', () => {
  it('matches the TUI, through node or native, and not its daemon or a shell', () => {
    expect(isCodexCommand('node /opt/homebrew/bin/codex reply with just: ready')).toBe(true)
    expect(isCodexCommand('/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex reply')).toBe(true)
    expect(isCodexCommand('/Users/x/.codex/packages/app-server-daemon/releases/0.162.1/bin/codex app-server --listen unix://')).toBe(false)
    expect(isCodexCommand("/bin/zsh -l -i -c codex 'reply'")).toBe(false)
    expect(isCodexCommand('C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.exe resume abc')).toBe(true)
  })
})

it('waits past transient startup input frames before confirming Codex is ready', () => {
  expect(codexStartupSettled([DONE])).toBe(false)
  expect(codexStartupSettled([DONE, TRUST, DONE])).toBe(false)
  expect(codexStartupSettled([TRUST, DONE, DONE])).toBe(false)
  expect(codexStartupSettled([DONE, DONE, DONE])).toBe(true)
  expect(codexStartupSettled([BUSY, BUSY, BUSY])).toBe(true)
})
