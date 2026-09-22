import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'

const MODELS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra']

test('model picker offers exactly the backend-supplied ids verbatim, without provider routing', async t => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' })
  t.after(() => vite.close())
  const { default: Picker } = await vite.ssrLoadModule('/src/ModelPicker.tsx')
  let choice
  const props = { model: 'gpt-6-astra', models: MODELS, disabled: false, onChange: model => { choice = model } }
  const markup = renderToStaticMarkup(createElement(Picker, props))
  for (const id of MODELS) assert.match(markup, new RegExp(`value="${id.replace('.', '\\.')}"[^>]*>${id.replace('.', '\\.')}`))
  // No invented display names: a backend id the UI does not recognise must still render.
  assert.doesNotMatch(markup, /Claude|GLM|Z\.AI|provider|optgroup/i)
  assert.equal((markup.match(/<option/g) || []).length, MODELS.length)
  const tree = Picker(props)
  tree.props.children[0].props.onChange({ target: { value: 'gpt-5.6-sol' } })
  assert.equal(choice, 'gpt-5.6-sol')
})

test('a stored model the backend no longer offers stays selectable and is never silently swapped', async t => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' })
  t.after(() => vite.close())
  const { default: Picker } = await vite.ssrLoadModule('/src/ModelPicker.tsx')
  const markup = renderToStaticMarkup(createElement(Picker, { model: 'gpt-5.3-codex-spark', models: MODELS, disabled: false, onChange() {} }))
  assert.match(markup, /value="gpt-5\.3-codex-spark"/)
  assert.equal((markup.match(/<option/g) || []).length, MODELS.length + 1)
  assert.match(markup, /<select[^>]*value="gpt-5\.3-codex-spark"|selected/)
  // An empty list (Codex unreachable) must not erase the model the chat is using.
  const offline = renderToStaticMarkup(createElement(Picker, { model: 'gpt-6-astra', models: [], disabled: true, onChange() {} }))
  assert.equal((offline.match(/<option/g) || []).length, 1)
  assert.match(offline, /value="gpt-6-astra"/)
})

test('frontend chat writes do not send or patch provider fields', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const api = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /health\?\.providers|setProvider\(|provider:\s*nextProvider/)
  assert.doesNotMatch(api, /Pick<Chat,[^>]*'provider'/)
  assert.match(app, /api\.createChat\(\{[^}]*model,[^}]*permissionMode: permission/s)
})

test('the picker takes its option list from the backend health payload, not a build-time constant', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const picker = await readFile(new URL('../src/ModelPicker.tsx', import.meta.url), 'utf8')
  assert.match(app, /models=\{health\?\.chatModels \?\? \[\]\}/)
  assert.doesNotMatch(picker, /sonnet|opus|haiku|gpt-/i)
})
