import { expect, test } from 'bun:test'
import { harnessArgs, harnessOfCommand, parseHarness } from './harness.js'
import { harnessLaunchBody } from './open-harness.js'

test('only the three harnesses parse', () => {
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
