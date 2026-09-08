import { describe, it, expect } from 'bun:test'
import { buildPathHandoff, CLIP_RISK_BYTES } from './send.js'

describe('buildPathHandoff', () => {
  it('names the absolute path and says the contents ARE the message', () => {
    const msg = buildPathHandoff('/Users/x/.cctabs-prompts/brief.txt')
    expect(msg).toContain('/Users/x/.cctabs-prompts/brief.txt')
    expect(msg).toContain('in full')
    // Without this the receiving session treats a brief as reading material
    // and summarises it back instead of acting on it.
    expect(msg).toContain('not a document to summarise')
  })

  // The property that makes --path the robust mode: what crosses the prompt
  // line is bounded by the path length, not by the payload.
  it('stays far below the size where clipping was measured', () => {
    const msg = buildPathHandoff('/Users/someone/a/fairly/deep/path/to/a/brief-file.txt')
    expect(msg.length).toBeLessThan(CLIP_RISK_BYTES)
  })
})
