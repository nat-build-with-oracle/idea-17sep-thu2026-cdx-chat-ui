import { createCodexEnvironment } from '../server/codex-environment.mjs'

const CLIENT_BLOCKED_ENV_NAMES = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
  'CC_CHAT_CHAT_MODELS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'API_TIMEOUT_MS',
])

export function createDevEnvironments(sourceEnv = process.env) {
  // The client half is only a Vite static server: it needs no model-vendor variable at all,
  // so every vendor prefix is withheld rather than enumerated key by key. ANTHROPIC_ stays
  // listed because a machine that once ran the Claude build still carries those tokens.
  const clientEnv = Object.fromEntries(
    Object.entries(sourceEnv).filter(([name]) => (
      !/^(ANTHROPIC_|OPENAI_|CODEX_)/.test(name) && !CLIENT_BLOCKED_ENV_NAMES.has(name)
    )),
  )

  return {
    backendEnv: { ...createCodexEnvironment(sourceEnv), DEV_ORIGIN: 'http://127.0.0.1:5173' },
    clientEnv,
  }
}
