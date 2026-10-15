import { expect, test } from 'bun:test'
import type { TerminalAdapter } from './adapter.js'
import { wakeSuspendedTab } from './suspend-ops.js'

test('Codex wake uses current screen after its nonce, when PTY redraws omit the placeholder', async () => {
  let nonce = ''
  let screens = 0
  const adapter = {
    sendInput: async (_id: string, text: string) => { if (text.startsWith('\x15')) nonce = text.slice(1) },
    scrollback: () => `▶ cctabs: resuming test (${nonce})\nWorked for 2s`,
    screenText: async () => { screens++; return '› Ask Codex to do anything' },
  } as unknown as TerminalAdapter
  const result = await wakeSuspendedTab(adapter, {
    name: 'test', blockId: 'b', tabId: 't', record: {
      sessionId: '00000000-0000-0000-0000-000000000000', name: 'test', dir: '/tmp', engine: 'codex', suspendedAt: '',
    },
  }, { timeoutMs: 4000 })
  expect(result).toMatchObject({ ok: true, ready: 'confirmed' })
  expect(screens).toBe(2)
})
