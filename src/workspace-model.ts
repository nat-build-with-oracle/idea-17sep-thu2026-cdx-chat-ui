import type { Chat, NativeSession, Project, Repository } from './types'

export interface WorkspaceRepository extends Repository {
  projectId: string | null
  aliases: string[]
  chats: Chat[]
  sessions: NativeSession[]
}
/** Synthetic row, not a directory: consumers compare against this instead of matching a label. */
export const OUTSIDE_PROJECTS_ID = 'outside-projects'
// Relative on purpose: every path-keyed preference rejects it, so it can never collide with a real repository.
const OUTSIDE_PROJECTS_PATH = 'not in a repository'
const cleanPath = (value: string) => value.replace(/\/+$/, '') || '/'
const newestSession = (a: NativeSession, b: NativeSession) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || (a.sessionId || '').localeCompare(b.sessionId || '')

/** Read-only sidebar projection: discovering or opening a thread never imports it. */
export function buildWorkspaceRepositories(projects: readonly Project[], repositories: readonly Repository[], sessions: readonly NativeSession[], chats: readonly Chat[]): WorkspaceRepository[] {
  const byPath = new Map<string, WorkspaceRepository>()
  for (const repo of repositories) byPath.set(cleanPath(repo.path), { ...repo, projectId: null, aliases: [repo.id], chats: [], sessions: [] })
  for (const project of projects) {
    const key = cleanPath(project.canonicalPath || project.path)
    const existing = byPath.get(key)
    // Preserve saved names/IDs; duplicate saved aliases share the same repo row.
    if (existing?.projectId) { existing.aliases.push(project.id); continue }
    byPath.set(key, { ...project, path: key, modifiedAt: existing?.modifiedAt ?? 0, projectId: project.id, aliases: [...(existing?.aliases ?? []), project.id], chats: [], sessions: [] })
  }
  const rows = [...byPath.values()]
  const byDepth = [...rows].sort((a, b) => b.path.length - a.path.length)
  const imported = new Set(chats.map(chat => chat.sessionId).filter(Boolean))
  const knownSessions = new Set<string>()
  const outside: NativeSession[] = []
  for (const session of [...sessions].sort(newestSession)) {
    if (!session.sessionId || imported.has(session.sessionId) || knownSessions.has(session.sessionId)) continue
    const cwd = cleanPath(session.canonicalPath || session.cwd)
    const parent = byDepth.find(repo => cwd === cleanPath(repo.path) || cwd.startsWith(`${cleanPath(repo.path)}/`))
    if (parent) parent.sessions.push(session)
    else outside.push(session)
    knownSessions.add(session.sessionId)
  }
  for (const chat of chats) {
    const project = projects.find(item => item.id === chat.projectId)
    if (project) byPath.get(cleanPath(project.canonicalPath || project.path))?.chats.push(chat)
  }
  const ordered = rows.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))
  // Appended after the sort so threads that ran outside the repository tree stay visible without displacing a real repository.
  if (!outside.length) return ordered
  return [...ordered, { id: OUTSIDE_PROJECTS_ID, name: 'Outside projects', path: OUTSIDE_PROJECTS_PATH, modifiedAt: 0, projectId: null, aliases: [], chats: [], sessions: outside }]
}
