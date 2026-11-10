import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  claudeContextUsage,
  claudeWindowOf,
  codexContextUsage,
  formatContext,
  scanClaudeLines,
  scanCodexLines,
} from './context-usage.js'

const assistant = (model: string, u: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', ...extra, message: { model, usage: u } })
const modelAttachment = (modelId: string, marketingName: string) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'model', identity: { modelId, marketingName } } })
const boundary = (postTokens: number) =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { postTokens } })
const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 99_000, output_tokens: 500 }

function withFile(lines: string[], run: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-'))
  try {
    const file = join(dir, 's.jsonl')
    writeFileSync(file, lines.join('\n') + '\n')
    run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('claudeWindowOf', () => {
  test('[1m] or a "1M context" name means the 1M window; anything else 200k', () => {
    expect(claudeWindowOf('claude-opus-5-5[1m]')).toBe(1_000_000)
    expect(claudeWindowOf('claude-opus-5-5', 'Opus 5.5 (1M context)')).toBe(1_000_000)
    expect(claudeWindowOf('claude-opus-5-5', 'Opus 5.5')).toBe(200_000)
  })
})

describe('scanClaudeLines', () => {
  test('the last main-thread turn counts input, both cache kinds and output', () => {
    const s = scanClaudeLines([assistant('claude-opus-5-5', { ...usage, input_tokens: 9 }), assistant('claude-opus-5-5', usage)])
    expect(s.used).toBe(100_502)
  })

  test('skips subagent turns and <synthetic> entries', () => {
    const s = scanClaudeLines([
      assistant('claude-opus-5-5', usage),
      assistant('claude-haiku-5-5', { input_tokens: 5 }, { isSidechain: true }),
      assistant('<synthetic>', { input_tokens: 0 }),
    ])
    expect(s.used).toBe(100_502)
  })

  test('a compaction with no turn after it reports the compacted size', () => {
    expect(scanClaudeLines([assistant('claude-opus-5-5', usage), boundary(34_784)]).used).toBe(34_784)
  })

  test('tolerates the cut-off first line of a tail read', () => {
    expect(scanClaudeLines(['ge":{"input_tokens":1}}', assistant('claude-opus-5-5', usage)]).used).toBe(100_502)
  })
})

describe('claudeContextUsage', () => {
  test('the window comes from the model attachment', () => {
    withFile([modelAttachment('claude-opus-5-5[1m]', 'Opus 5.5 (1M context)'), assistant('claude-opus-5-5', usage)], (f) => {
      expect(claudeContextUsage(f)).toEqual({ used: 100_502, window: 1_000_000, percent: 10, window_source: 'reported' })
    })
  })

  test('finds an attachment far behind the last turn (measured: 4,000 lines back in a 13 MB file)', () => {
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } })
    const lines = [JSON.stringify({ type: 'user' }), modelAttachment('claude-opus-5-5[1m]', ''), ...Array(1500).fill(filler), assistant('claude-opus-5-5', usage)]
    // Put more than the head read in front, so neither the first tail nor the head holds it.
    lines.unshift(...Array(300).fill(filler))
    withFile(lines, (f) => expect(claudeContextUsage(f)?.window).toBe(1_000_000))
  })

  test('an attachment for a different model is not trusted (a /model switch)', () => {
    withFile([modelAttachment('claude-sonnet-5-5[1m]', ''), assistant('claude-opus-5-5', usage)], (f) => {
      expect(claudeContextUsage(f)).toMatchObject({ window: 200_000, percent: 50, window_source: 'inferred' })
    })
  })

  test('past 200k with no attachment can only be the 1M window', () => {
    withFile([assistant('claude-opus-5-5', { cache_read_input_tokens: 400_000 })], (f) => {
      expect(claudeContextUsage(f)).toMatchObject({ window: 1_000_000, percent: 40, window_source: 'usage' })
    })
  })

  test('no turn, or no file, is null', () => {
    withFile([modelAttachment('claude-opus-5-5', '')], (f) => expect(claudeContextUsage(f)).toBeNull())
    expect(claudeContextUsage('/nonexistent/x.jsonl')).toBeNull()
  })
})

describe('codex', () => {
  const tokenCount = (total: number, window: number) =>
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total }, model_context_window: window } } })

  test('the last token_count event, against the window Codex reports', () => {
    expect(scanCodexLines([tokenCount(1000, 475_000), tokenCount(20_048, 475_000)])).toEqual({ used: 20_048, window: 475_000 })
    withFile([tokenCount(47_500, 475_000)], (f) => expect(codexContextUsage(f)).toMatchObject({ percent: 10, window_source: 'reported' }))
  })

  test('a token_count with no info yet (before the first turn) is skipped', () => {
    expect(scanCodexLines([JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } })])).toBeNull()
  })
})

test('formatContext marks only an inferred window as approximate', () => {
  expect(formatContext({ used: 1, window: 1, percent: 42, window_source: 'reported' })).toBe('ctx 42%')
  expect(formatContext({ used: 1, window: 1, percent: 42, window_source: 'usage' })).toBe('ctx 42%')
  expect(formatContext({ used: 1, window: 1, percent: 42, window_source: 'inferred' })).toBe('ctx ~42%')
})
