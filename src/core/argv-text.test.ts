import { describe, it, expect } from 'bun:test'
import { cli, define } from 'gunshi'
import { isOptionShaped, protectArgv, restoreParsed, restoreText } from './argv-text.js'
import { rejectUnknownOptions } from '../commands/index.js'
import { newCommand } from '../commands/new.js'
import { sendCommand } from '../commands/send.js'

describe('isOptionShaped', () => {
  it('accepts real options', () => {
    for (const a of ['--push', '--draft-wait', '--draft-wait=5', '--prompt=run --push now', '-p', '-wj', '-1']) {
      expect(isOptionShaped(a)).toBe(true)
    }
  })

  it('rejects text that merely contains or starts with dashes', () => {
    for (const a of ['run publish.sh --push to ship', '--push is the flag', 'a--b', '- item', '-- spaced', '-', '--']) {
      expect(isOptionShaped(a)).toBe(false)
    }
  })
})

describe('protectArgv', () => {
  it('round-trips text and leaves options and plain words alone', () => {
    const argv = ['send', 'tab', 'run publish.sh --push to ship', '--draft-wait', '5', '--', '-x']
    const p = protectArgv(argv)
    expect(p[0]).toBe('send')
    expect(p[3]).toBe('--draft-wait')
    expect(p[5]).toBe('--')
    expect(p[2]).not.toContain('--')
    expect(p.map(restoreText)).toEqual(argv)
  })

  it('restores through nested parse results without mutating frozen input', () => {
    const frozen = Object.freeze({ prompt: protectArgv(['a --b'])[0], list: Object.freeze([protectArgv(['--c d'])[0]]) })
    expect(restoreParsed(frozen)).toEqual({ prompt: 'a --b', list: ['--c d'] })
  })
})

/**
 * The real parser, with the real commands' argument declarations: the two
 * failures brands-dev hit (2026-10-17..19) reproduced end to end, with the
 * command body swapped for a spy so nothing touches a terminal.
 */
async function parsed(command: { name?: string; args?: unknown }, argv: string[]) {
  let seen: { values: Record<string, unknown>; positionals: string[] } | undefined
  const spy = define({ ...(command as object), run: (ctx: never) => { seen = ctx } } as never)
  const exit = process.exit
  let exited: number | undefined
  process.exit = ((c?: number) => { exited = c ?? 0; throw new Error('exit') }) as never
  try {
    await cli(protectArgv(argv), define({ name: 'cctabs', run: () => {} }), {
      subCommands: new Map([[command.name!, rejectUnknownOptions(spy as never)]]) as never,
      renderHeader: null,
    })
  } catch { /* exit */ } finally { process.exit = exit }
  return { seen, exited }
}

describe('a double-dash word inside text is text', () => {
  it('new --prompt keeps a prompt that quotes a flag', async () => {
    const prompt = 'Fix the publish script, then run it with --push; mention --dry too.'
    const { seen, exited } = await parsed(newCommand, ['new', 'tabname', '/tmp', '--prompt', prompt])
    expect(exited).toBeUndefined()
    expect(seen?.values.prompt).toBe(prompt)
    expect(seen?.positionals.slice(1)).toEqual(['tabname', '/tmp'])
  })

  it('new --prompt keeps a prompt that STARTS with a flag', async () => {
    const { seen } = await parsed(newCommand, ['new', 'tabname', '--prompt', '--push is broken, fix it'])
    expect(seen?.values.prompt).toBe('--push is broken, fix it')
  })

  it('send is not refused as an unknown option, and other flags still parse', async () => {
    const { seen, exited } = await parsed(sendCommand, ['send', 'tab', 'run publish.sh --push to ship', '--draft-wait', '5'])
    expect(exited).toBeUndefined()
    expect(seen?.values['draft-wait']).toBe(5)
    expect(seen?.positionals).toContain('run publish.sh --push to ship')
  })

  it('a bare unknown flag is still refused', async () => {
    const { exited } = await parsed(sendCommand, ['send', 'tab', 'hi', '--bogus'])
    expect(exited).toBe(1)
  })
})
