import assert from 'node:assert/strict'
import test from 'node:test'
import { createDevEnvironments } from '../scripts/dev-environment.mjs'

test('dev credentials are available only to the backend process', () => {
  // Names the backend is entitled to keep, because they are the official Codex login.
  const officialNames = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']
  // Codex-vendor names the backend must drop: a redirected endpoint or an injected
  // third-party credential, plus the originator spoof.
  const removedNames = [
    'OPENAI_ORG_ID',
    'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'CODEX_CLOUD_TASKS_BASE_URL',
  ]
  // Credentials of providers this build no longer speaks. createCodexEnvironment passes
  // non-Codex names through by design, so these are pinned on the client side only.
  const foreignNames = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ZAI_API_KEY', 'Z_AI_API_KEY', 'CC_CHAT_CHAT_MODELS', 'API_TIMEOUT_MS']
  const secretNames = [...officialNames, ...removedNames, ...foreignNames]
  const sourceEnv = {
    PATH: '/test/bin',
    HOME: '/test/home',
    VITE_PUBLIC_MARKER: 'visible',
    DEV_ORIGIN: 'http://old-origin.test',
    ...Object.fromEntries(secretNames.map((name) => [name, `secret-${name}`])),
  }

  const { backendEnv, clientEnv } = createDevEnvironments(sourceEnv)

  // Not one credential of any vendor reaches the Vite process.
  for (const name of secretNames) assert.equal(name in clientEnv, false, name)
  for (const name of officialNames) assert.equal(backendEnv[name], sourceEnv[name], name)
  for (const name of removedNames) assert.equal(backendEnv[name], undefined, name)
  assert.equal(backendEnv.OPENAI_BASE_URL, 'https://api.openai.com/v1')
  assert.equal(backendEnv.DEV_ORIGIN, 'http://127.0.0.1:5173')
  assert.deepEqual(clientEnv, {
    PATH: '/test/bin',
    HOME: '/test/home',
    VITE_PUBLIC_MARKER: 'visible',
    DEV_ORIGIN: 'http://old-origin.test',
  })
})

// CODEX_HOME is the normal Codex login location, not a credential: the backend must keep
// it, or a developer running against a non-default home silently gets the wrong threads.
test('the backend keeps the normal Codex login location while the client sees none of it', () => {
  const { backendEnv, clientEnv } = createDevEnvironments({
    PATH: '/test/bin', CODEX_HOME: '/test/home/.codex', CODEX_BIN: '/test/bin/codex',
  })
  assert.equal(backendEnv.CODEX_HOME, '/test/home/.codex')
  assert.equal(backendEnv.CODEX_BIN, '/test/bin/codex')
  assert.equal('CODEX_HOME' in clientEnv, false)
  assert.equal('CODEX_BIN' in clientEnv, false)
})
