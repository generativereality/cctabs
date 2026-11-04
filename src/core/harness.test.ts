import { expect, test } from 'bun:test'
import { harnessArgs, harnessOfCommand, harnessUnsupported, parseHarness } from './harness.js'
import { harnessLaunchBody, harnessMissing } from './open-harness.js'

test('only the five harnesses parse', () => {
  expect(parseHarness('opencode2')).toBe('opencode2')
  expect(parseHarness('grok')).toBe('grok')
  expect(parseHarness('opencode')).toBe('opencode')
  expect(parseHarness('pi')).toBe('pi')
  expect(parseHarness('hermes')).toBe('hermes')
  expect(parseHarness('codex')).toBeNull()
  expect(parseHarness(undefined)).toBeNull()
})

test('opencode: TUI with the prompt, model and session on argv, never `run`', () => {
  expect(harnessArgs('opencode', {})).toEqual([])
  expect(harnessArgs('opencode', { prompt: 'fix the tests', model: 'anthropic/claude-sonnet-4' }))
    .toEqual(['--model', 'anthropic/claude-sonnet-4', '--prompt=fix the tests'])
  expect(harnessArgs('opencode', { resumeId: 'ses_1' })).toEqual(['--session', 'ses_1'])
})

test('pi: the prompt is a message after --, and the tab name names the session', () => {
  expect(harnessArgs('pi', { prompt: '-v is broken', name: 'review' })).toEqual(['--name', 'review', '--', '-v is broken'])
  expect(harnessArgs('pi', { resumeId: 'abc', name: 'review', model: 'sonnet:high' })).toEqual(['--model', 'sonnet:high', '--session', 'abc'])
  expect(harnessArgs('pi', { prompt: '--print' })).not.toContain('-p')
})

test('hermes: interactive chat seeded with --query, never --oneshot', () => {
  expect(harnessArgs('hermes', {})).toEqual(['chat'])
  expect(harnessArgs('hermes', { prompt: 'hi', model: 'nous/hermes-4', resumeId: 'latest' }))
    .toEqual(['chat', '--model', 'nous/hermes-4', '--resume', 'latest', '--query=hi'])
})

test('a harness is recognised from its command line, whatever its install path', () => {
  expect(harnessOfCommand('/opt/homebrew/bin/opencode --prompt=x')).toBe('opencode')
  expect(harnessOfCommand('"C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd" -- hi')).toBe('pi')
  expect(harnessOfCommand('hermes.exe chat')).toBe('hermes')
  expect(harnessOfCommand('pip install x')).toBeNull()
})

test('POSIX launch line quotes every word', () => {
  expect(harnessLaunchBody('pi', ['--', "it's done; rm -rf /"], { posix: true }, 'darwin'))
    .toBe(`pi '--' 'it'\\''s done; rm -rf /'`)
})

test('Windows launch line carries no user text for cmd or Git Bash to parse', () => {
  const prompt = 'echo %PATH% & del /q * "quoted" !bang!\r\nline 2\\'
  for (const posix of [false, true]) {
    const body = harnessLaunchBody('opencode', [`--prompt=${prompt}`], { posix }, 'win32')
    expect(body.startsWith('node -e ')).toBe(true)
    for (const bad of ['%PATH%', '&', '"quoted"', '!bang!', 'line 2']) expect(body).not.toContain(bad)
    const encoded = body.match(/[A-Za-z0-9+/=]{40,}/)![0]
    const script = Buffer.from(encoded, 'base64').toString()
    expect(script).toContain(JSON.stringify([`--prompt=${prompt}`]))
    expect(script).toContain("shell:false")
  }
})

test('opencode 2: TUI with --prompt and --session, and no --model on its launch line', () => {
  expect(harnessArgs('opencode2', {})).toEqual([])
  expect(harnessArgs('opencode2', { prompt: '-x first', resumeId: 'ses_2', model: 'ignored/model' }))
    .toEqual(['--session', 'ses_2', '--prompt=-x first'])
  expect(harnessUnsupported('opencode2', { model: 'anthropic/claude-sonnet-4' })).toContain('no --model')
  expect(harnessUnsupported('opencode2', { prompt: 'hi' })).toBeNull()
})

test('grok: TUI with --model and --resume; a first prompt is refused, never sent as headless -p', () => {
  expect(harnessArgs('grok', {})).toEqual([])
  expect(harnessArgs('grok', { model: 'grok-code', resumeId: 'abc' })).toEqual(['--model', 'grok-code', '--resume', 'abc'])
  expect(harnessArgs('grok', { prompt: 'hi' })).not.toContain('-p')
  expect(harnessUnsupported('grok', { prompt: 'hi' })).toContain('cctabs send')
  expect(harnessUnsupported('grok', { model: 'grok-code' })).toBeNull()
})

test('opencode 2 runs the `opencode` binary, and its missing-install message names it', () => {
  expect(harnessLaunchBody('opencode2', ['--prompt=hi'], { posix: true }, 'darwin')).toBe(`opencode '--prompt=hi'`)
  expect(harnessMissing('zsh: command not found: opencode', 'opencode2')).toBe(true)
  expect(harnessMissing('zsh: command not found: grok', 'grok')).toBe(true)
  const win = harnessLaunchBody('opencode2', [], { posix: false }, 'win32')
  const script = Buffer.from(win.match(/[A-Za-z0-9+/=]{40,}/)![0], 'base64').toString()
  expect(script).toContain('"opencode.exe"')
  expect(script).not.toContain('opencode2.exe')
})
