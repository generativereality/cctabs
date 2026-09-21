import { describe, it, expect } from 'bun:test'
import { findUnknownOptions, unknownOptionMessage } from './unknown-options.js'

// Shaped like `new`'s declaration, including the `-p` that means --prompt here
// and --path on `send` — the collision that produced the bug report.
const NEW_ARGS = {
  name: { type: 'positional' },
  dir: { type: 'positional' },
  prompt: { type: 'string', short: 'p' },
  file: { type: 'string', short: 'f' },
  worktree: { type: 'boolean', short: 'W' },
}

const opt = (name: string, rawName = name.length === 1 ? `-${name}` : `--${name}`) =>
  ({ kind: 'option', name, rawName })

describe('findUnknownOptions', () => {
  it('accepts a declared long option and its short form', () => {
    expect(findUnknownOptions([opt('prompt'), opt('f')], NEW_ARGS)).toEqual([])
  })

  it('reports an option that belongs to a different command', () => {
    // The measured case: `cctabs new <name> <dir> --path <file>` opened the tab
    // and delivered nothing, because --path is a `send` option.
    expect(findUnknownOptions([opt('path')], NEW_ARGS)).toEqual(['--path'])
  })

  it('does not treat a positional name as an option', () => {
    expect(findUnknownOptions([opt('name')], NEW_ARGS)).toEqual(['--name'])
  })

  it('reports every unknown, in the order typed, without duplicates', () => {
    expect(findUnknownOptions([opt('path'), opt('z'), opt('path')], NEW_ARGS))
      .toEqual(['--path', '-z'])
  })

  it('leaves --help and --version to gunshi', () => {
    expect(findUnknownOptions([opt('help'), opt('h'), opt('version'), opt('v')], NEW_ARGS)).toEqual([])
  })

  it('accepts --no-<flag> for a declared boolean', () => {
    expect(findUnknownOptions([opt('no-worktree')], NEW_ARGS)).toEqual([])
    expect(findUnknownOptions([opt('no-prompt')], NEW_ARGS)).toEqual(['--no-prompt'])
  })

  it('stops at a `--` terminator, so flag-shaped payload is not an option', () => {
    // `cctabs send tab -- --verify is broken` — the escape hatch send documents.
    const tokens = [opt('f'), { kind: 'option-terminator' }, opt('verify')]
    expect(findUnknownOptions(tokens, NEW_ARGS)).toEqual([])
  })

  it('ignores positional tokens entirely', () => {
    const tokens = [{ kind: 'positional', value: 'mmm-b2b' }, opt('path')]
    expect(findUnknownOptions(tokens, NEW_ARGS)).toEqual(['--path'])
  })

  it('survives a command with no declared args', () => {
    expect(findUnknownOptions([opt('anything')], {})).toEqual(['--anything'])
  })
})

describe('unknownOptionMessage', () => {
  it('names the command and says nothing ran', () => {
    const msg = unknownOptionMessage('new', ['--path'])
    expect(msg).toContain('`--path`')
    expect(msg).toContain('cctabs new')
    expect(msg).toContain('Nothing was run')
  })

  it('pluralises for several', () => {
    expect(unknownOptionMessage('new', ['--path', '-z'])).toContain('are not options')
  })
})
