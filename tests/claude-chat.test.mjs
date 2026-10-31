import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

// The gate inverted with the Codex migration: provider decides, never the model id.
// Codex model ids are served by the backend and retired over time, so no build-time
// list may judge them — a retired id must not turn a healthy conversation read-only.
test('only Codex chats are writable; every other provider gets a read-only explanation', async t => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' })
  t.after(() => vite.close())
  const { chatReadOnlyReason, isWritableCodexChat } = await vite.ssrLoadModule('/src/claude-chat.ts')

  for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'a-model-this-build-has-never-seen', '', undefined]) {
    assert.equal(isWritableCodexChat({ provider: 'codex', model }), true)
    assert.equal(chatReadOnlyReason({ provider: 'codex', model }), '')
  }
  for (const provider of ['claude', 'zai', '', null, undefined]) {
    assert.equal(isWritableCodexChat({ provider, model: 'sonnet' }), false)
    assert.match(chatReadOnlyReason({ provider, model: 'sonnet' }), /removed provider/i)
    assert.match(chatReadOnlyReason({ provider, model: 'gpt-6-astra' }), /removed provider/i)
  }
  assert.match(chatReadOnlyReason({ provider: 'claude', model: 'opus' }), /read-only/i)
  assert.match(chatReadOnlyReason({ model: 'glm-5.2' }), /removed provider/i)
})
