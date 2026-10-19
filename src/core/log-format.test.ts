import { describe, it, expect } from 'bun:test'
import { createConsola } from 'consola'
import { tightenConsola, unpadBadge } from './log-format.js'

describe('unpadBadge', () => {
  it('drops the blank lines around a badge, and nothing else', () => {
    expect(unpadBadge('\n ERROR  Not sent: x\n')).toBe(' ERROR  Not sent: x')
    expect(unpadBadge('ℹ plain line')).toBe('ℹ plain line')
    expect(unpadBadge('\n two\nlines \n')).toBe(' two\nlines ')
  })
})

describe('tightenConsola', () => {
  it('makes an error the last non-empty line of stderr', () => {
    let written = ''
    const stream = { write: (s: string) => { written += s; return true } }
    const c = createConsola({ fancy: true, stdout: stream, stderr: stream } as never)
    tightenConsola(c)
    c.error('Not sent: tab still has an unsent draft')
    const lines = written.split('\n')
    expect(lines.at(-1)).toBe('') // the newline that ends the line
    expect(lines.at(-2)).toContain('Not sent: tab still has an unsent draft')
  })
})
