import type { Chat } from './types'

type StoredChatIdentity = Pick<Chat, 'provider' | 'model'>

// Mirrors server/app.mjs's gate: provider decides, not the model id. Codex model ids are
// supplied by the backend and retired over time, so no build-time list can judge them.
export function isWritableCodexChat(chat: StoredChatIdentity) {
  return chat.provider === 'codex'
}

export function chatReadOnlyReason(chat: StoredChatIdentity) {
  if (isWritableCodexChat(chat)) return ''
  return 'This conversation used a removed provider and is kept read-only. Its saved history is unchanged; start a new Codex conversation to continue.'
}
