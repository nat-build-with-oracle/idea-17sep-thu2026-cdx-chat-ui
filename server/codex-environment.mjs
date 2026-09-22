const OPENAI_URL = 'https://api.openai.com/v1';
const AUTH_KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];
// Named CODEX_* levers (verified against codex-cli 0.154.0's embedded strings) that redirect a
// login/model endpoint or inject a third-party credential. OPENAI_* is stripped wholesale below,
// so only the non-OPENAI_ names need listing here. CODEX_HOME and everything else pass through
// untouched, since that is how the normal Codex login (keychain/config.toml/auth.json) works.
const REMOVED_OVERRIDES = new Set([
  'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', // re-added below only when the endpoint is official
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_APP_SERVER_CHATGPT_BASE_URL', 'CODEX_AUTHAPI_BASE_URL',
  'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL', 'CODEX_AGENT_IDENTITY_JWKS_BASE_URL',
  'CODEX_CLOUD_TASKS_BASE_URL', 'CODEX_OSS_BASE_URL', 'CODEX_OSS_PORT', 'CODEX_URL',
  'CODEX_EXEC_SERVER_URL', 'CODEX_EXEC_SERVER_NOISE_REGISTRY_URL',
  'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN', 'CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID',
  'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN', 'CODEX_CONNECTORS_TOKEN',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', // would let a rogue env spoof the app-server originator
]);

// Credentials of the providers this build removed. A new chat defaults to full access, so
// anything left in this environment is readable by whatever the model runs; the Claude
// build stripped its removed provider's keys for exactly that reason, and so does this one.
const REMOVED_PROVIDERS = /^(ANTHROPIC_|CLAUDE_|ZAI_|Z_AI_)/;

// Keep the normal Codex login (CODEX_HOME, keychain, auth.json, config.toml) and official
// credentials. Never reuse a token or provider endpoint from a removed third-party override.
export function createCodexEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^OPENAI_/.test(key) && !REMOVED_PROVIDERS.test(key) && !REMOVED_OVERRIDES.has(key)));
  const official = !source.OPENAI_BASE_URL || source.OPENAI_BASE_URL.replace(/\/$/, '') === OPENAI_URL;
  if (official) {
    for (const key of AUTH_KEYS) if (source[key]) env[key] = source[key];
  }
  return { ...env, OPENAI_BASE_URL: OPENAI_URL };
}
