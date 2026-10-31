import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexEnvironment } from '../server/codex-environment.mjs';

test('Codex environment preserves official auth and the normal login location, not removed overrides', () => {
  const source = {
    PATH: '/bin', HOME: '/home/user', CODEX_HOME: '/home/user/.codex',
    ZAI_API_KEY: 'dummy-zai', ANTHROPIC_API_KEY: 'dummy-claude', CLAUDE_CODE_OAUTH_TOKEN: 'dummy-oauth',
    OPENAI_API_KEY: 'dummy-openai', CODEX_API_KEY: 'dummy-codex', CODEX_ACCESS_TOKEN: 'dummy-token',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'spoofed', CODEX_AUTHAPI_BASE_URL: 'https://foreign.example',
  };
  const before = { ...source };
  assert.deepEqual(createCodexEnvironment(source), {
    PATH: '/bin', HOME: '/home/user', CODEX_HOME: '/home/user/.codex',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_API_KEY: 'dummy-openai', CODEX_API_KEY: 'dummy-codex', CODEX_ACCESS_TOKEN: 'dummy-token',
  });
  assert.deepEqual(source, before);
});

test('third-party credentials and routing cannot cross back into Codex', () => {
  for (const endpoint of ['https://api.z.ai/api/openai', 'https://foreign.example']) {
    const env = createCodexEnvironment({
      PATH: '/bin', OPENAI_BASE_URL: endpoint,
      OPENAI_API_KEY: 'dummy-foreign', CODEX_API_KEY: 'dummy-key', CODEX_ACCESS_TOKEN: 'dummy-token',
      CODEX_OSS_BASE_URL: 'https://foreign.example', CODEX_URL: 'https://foreign.example',
      CODEX_EXEC_SERVER_URL: 'https://foreign.example', CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: 'dummy',
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'https://foreign.example',
      CODEX_APP_SERVER_CHATGPT_BASE_URL: 'https://foreign.example',
      CODEX_GITHUB_PERSONAL_ACCESS_TOKEN: 'dummy-gh', CODEX_CONNECTORS_TOKEN: 'dummy-connector',
    });
    assert.deepEqual(env, { PATH: '/bin', OPENAI_BASE_URL: 'https://api.openai.com/v1' });
  }
});

test('official endpoint with trailing slash keeps the existing credential', () => {
  assert.equal(createCodexEnvironment({ OPENAI_BASE_URL: 'https://api.openai.com/v1/', OPENAI_API_KEY: 'dummy' }).OPENAI_API_KEY, 'dummy');
});

// A rogue env must never be able to make this backend's threads look like another client's:
// clientInfo.name lands in the `originator` column and is the only discriminator there is.
test('the app-server originator can never be spoofed through the environment', () => {
  const env = createCodexEnvironment({ PATH: '/bin', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex-tui' });
  assert.equal('CODEX_INTERNAL_ORIGINATOR_OVERRIDE' in env, false);
});

// A new chat defaults to full access, so every credential left in this environment is
// readable by whatever the model runs. The providers this build removed keep none.
test('credentials of removed providers never reach the Codex child', () => {
  const env = createCodexEnvironment({
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'sk-ant-real', ANTHROPIC_AUTH_TOKEN: 'auth-real', ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-real', CLAUDE_CONFIG_DIR: '/home/user/.claude',
    ZAI_API_KEY: 'zai-real', Z_AI_API_KEY: 'zai-real-2',
  });
  assert.deepEqual(env, { PATH: '/bin', OPENAI_BASE_URL: 'https://api.openai.com/v1' });
});
