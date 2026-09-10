import { describe, it, expect } from 'bun:test'
import { parseSendArgv } from './send-argv.js'

const parse = (...tokens: string[]) => parseSendArgv(tokens)

describe('parseSendArgv', () => {
  it('reads the target and the inline text', () => {
    expect(parse('mytab', 'hello world')).toMatchObject({ target: 'mytab', text: 'hello world' })
  })

  it('reads a target with no text', () => {
    expect(parse('mytab')).toMatchObject({ target: 'mytab', text: undefined })
  })

  // THE BUG. The option parser drops any argv element containing `--`, so a
  // message that quoted a flag name vanished and `send` reported success for a
  // delivery of nothing. These are the exact shapes measured as lost.
  it('keeps text that mentions flag names', () => {
    expect(parse('mytab', 'BUG 1 — the --path option does not hand over a path').text)
      .toBe('BUG 1 — the --path option does not hand over a path')
    expect(parse('mytab', 'I ran --file and --verify too').text)
      .toBe('I ran --file and --verify too')
  })

  it('keeps text containing a bare double dash anywhere', () => {
    expect(parse('mytab', 'a--b').text).toBe('a--b')
    expect(parse('mytab', 'trailing --').text).toBe('trailing --')
  })

  it('keeps a tab name containing a double dash', () => {
    expect(parse('my--tab', 'hi')).toMatchObject({ target: 'my--tab', text: 'hi' })
  })

  it('skips flags that come after the text', () => {
    expect(parse('mytab', 'hello', '--verify', '--force'))
      .toMatchObject({ target: 'mytab', text: 'hello' })
  })

  it('skips flags that come before the text', () => {
    expect(parse('--verify', 'mytab', 'hello'))
      .toMatchObject({ target: 'mytab', text: 'hello' })
  })

  // A value-taking flag's value must not be mistaken for the inline text.
  it('does not treat a flag value as the text', () => {
    expect(parse('mytab', '--file', '/tmp/brief.txt')).toMatchObject({ target: 'mytab', text: undefined })
    expect(parse('mytab', '-f', '/tmp/brief.txt')).toMatchObject({ target: 'mytab', text: undefined })
    expect(parse('mytab', '--path', '/tmp/brief.txt')).toMatchObject({ target: 'mytab', text: undefined })
    expect(parse('mytab', '--wait-timeout', '30')).toMatchObject({ target: 'mytab', text: undefined })
  })

  it('handles a flag that carries its own value', () => {
    expect(parse('mytab', '--file=/tmp/brief.txt')).toMatchObject({ target: 'mytab', text: undefined })
  })

  it('treats a boolean flag as consuming nothing', () => {
    expect(parse('mytab', '--verify', 'hello')).toMatchObject({ target: 'mytab', text: 'hello' })
  })

  // A lone `-` is the stdin convention, not a flag.
  it('treats a lone dash as a value', () => {
    expect(parse('-', 'hello')).toMatchObject({ target: '-', text: 'hello' })
  })

  describe('the -- terminator', () => {
    it('takes everything after it as text, however flag-shaped', () => {
      const r = parse('mytab', '--', '--verify', 'is', 'broken')
      expect(r).toMatchObject({ target: 'mytab', text: '--verify is broken', explicitText: true })
    })

    it('lets text override an earlier positional', () => {
      const r = parse('mytab', 'ignored', '--', 'the real text')
      expect(r).toMatchObject({ target: 'mytab', text: 'the real text' })
    })

    it('marks an empty terminator as an explicit empty, not a missing one', () => {
      const r = parse('mytab', '--')
      expect(r).toMatchObject({ target: 'mytab', text: '', explicitText: true })
    })

    it('leaves the target missing when there is none, rather than inventing one', () => {
      expect(parse('--', 'text').target).toBeUndefined()
    })
  })

  it('reports no target for an empty command line', () => {
    expect(parse()).toMatchObject({ target: undefined, text: undefined, explicitText: false })
  })
})
