import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWorkspaceRepositories, OUTSIDE_PROJECTS_ID } from '../src/workspace-model.ts'
import { initialRoute, recoverChatRoute } from '../src/route-recovery.ts'

const repo = (id, path, modifiedAt = 0) => ({ id, path, name: path.split('/').pop(), modifiedAt })
const project = { id: 'saved-repo', name: 'My repo', path: '/Code/org/repo', createdAt: '' }
const session = (sessionId, cwd, startedAt = 0) => ({ sessionId, cwd, startedAt, action: 'resume', name: sessionId })

test('sidebar merges discovered repositories with saved projects, not just manually added folders', () => {
  const rows = buildWorkspaceRepositories([project], [repo('discovered', project.path, 5), repo('other', '/Code/org/other', 10)], [], [])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.id), ['other', 'saved-repo'])
  assert.equal(rows[1].name, 'My repo')
  assert.equal(rows[1].projectId, 'saved-repo')
})

test('native threads belong to nearest repository with path boundaries, imported threads appear once', () => {
  const chat = { id: 'chat', projectId: project.id, sessionId: 'imported', updatedAt: '2026-01-01' }
  const rows = buildWorkspaceRepositories([project], [repo('nested', '/Code/org/repo/inner'), repo('different', '/Code/org/repo-two')], [session('parent','/Code/org/repo/src',30), session('child','/Code/org/repo/inner/src',20), session('imported',project.path,50),session('unowned','/Code/org/repo-three',60)], [chat])
  assert.deepEqual(rows.find(row=>row.id===project.id).sessions.map(s=>s.sessionId), ['parent'])
  assert.deepEqual(rows.find(row=>row.id==='nested').sessions.map(s=>s.sessionId), ['child'])
  assert.equal(rows.find(row=>row.id==='different').sessions.length, 0)
  assert.deepEqual(rows.find(row=>row.id===project.id).chats, [chat])
  assert.deepEqual(rows.find(row=>row.id===OUTSIDE_PROJECTS_ID).sessions.map(s=>s.sessionId), ['unowned'])
})

test('threads with no repository collect into one Outside projects group, last and only when it has threads', () => {
  const repositories = [repo('a','/Code/a',5), repo('b','/Code/b',1)]
  const owned = [session('owned','/Code/a/src',10)]
  assert.equal(buildWorkspaceRepositories([], repositories, owned, []).find(row=>row.id===OUTSIDE_PROJECTS_ID), undefined)
  assert.equal(buildWorkspaceRepositories([], repositories, [], []).length, 2)
  const rows = buildWorkspaceRepositories([], repositories, [...owned, session('home','/Users/beta',20), session('tmp','/private/tmp/scratch',30), session('near','/Code/a-not-inside',40)], [])
  assert.deepEqual(rows.map(row=>row.id), ['a','b',OUTSIDE_PROJECTS_ID])
  const group = rows[rows.length-1]
  assert.equal(group.name, 'Outside projects')
  assert.deepEqual(group.sessions.map(s=>s.sessionId), ['near','tmp','home'])
  assert.deepEqual(rows[0].sessions.map(s=>s.sessionId), ['owned'])
  assert.deepEqual(group.aliases, [])
  assert.deepEqual(group.chats, [])
  assert.equal(group.projectId, null)
  // A relative path keeps the synthetic row out of every path-keyed preference, including the "/" fallback.
  assert.ok(!group.path.startsWith('/'))
  assert.notEqual(group.path.replace(/\/+$/,'') || '/', '/')
})

test('an imported thread outside every repository stays in its chat row instead of the Outside projects group', () => {
  const rows = buildWorkspaceRepositories([], [repo('a','/Code/a')], [session('imported','/Users/beta/sandbox')], [{ id:'chat', projectId:'a', sessionId:'imported' }])
  assert.equal(rows.find(row=>row.id===OUTSIDE_PROJECTS_ID), undefined)
})

test('preferences and search leave the synthetic group alone', async () => {
  const { applyRepositoryPreferences, parseRepositoryPreferences, setRepositoryFavorite, setRepositoryName } = await import('../src/repository-preferences.ts')
  const { searchRepositories } = await import('../src/project-search.ts')
  const rows = buildWorkspaceRepositories([], [repo('a','/Code/a')], [session('loose','/Users/beta')], [])
  const group = rows.find(row=>row.id===OUTSIDE_PROJECTS_ID)
  const preferences = setRepositoryName(setRepositoryFavorite(parseRepositoryPreferences('{}'), group.path, true), group.path, 'Renamed')
  assert.equal(preferences.favorites.size, 0)
  assert.equal(preferences.names.size, 0)
  const projected = applyRepositoryPreferences(rows, preferences)
  assert.deepEqual(projected.map(row=>row.id), ['a', OUTSIDE_PROJECTS_ID])
  assert.equal(projected[1].name, 'Outside projects')
  assert.equal(projected[1].sessions.length, 1)
  assert.deepEqual(searchRepositories(rows.filter(row=>row.id!==OUTSIDE_PROJECTS_ID), '', 'all').map(row=>row.id), ['a'])
})

test('the sidebar renders the group without any control that would start a chat in it', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(source, /const repositoryRows = useMemo\(\(\) => preferredRows\.filter\(row => row\.id !== OUTSIDE_PROJECTS_ID\)/)
  assert.match(source, /\{visibleOutsideProjects && projectRow\(visibleOutsideProjects\)\}/)
  assert.match(source, /\{!preview && !outside && <RepositoryActions/)
  assert.match(source, /\{!outside && <button className="project-empty" onClick=\{\(\) => newChat\(repo\.id\)\}/)
  assert.match(source, /!outside && repositoryRows\.indexOf\(repo\) < 3/)
  const picker = source.slice(source.indexOf('<div className="project-picker">'), source.indexOf('</select>'))
  assert.match(picker, /repositoryRows\.map/)
  assert.doesNotMatch(picker, /preferredRows|outsideProjects/)
  assert.match(source, /<ProjectSearch repositories=\{repositoryRows\}/)
})

test('repository ordering uses filesystem mtime, threads are newest first with deterministic ties', () => {
  const rows=buildWorkspaceRepositories([], [repo('b','/Code/b',2),repo('a','/Code/a',2)], [session('older','/Code/a',5),session('newer','/Code/a',10)], [])
  assert.deepEqual(rows.map(row=>row.id),['a','b'])
  assert.deepEqual(rows[0].sessions.map(item=>item.sessionId),['newer','older'])
})

test('preview IDs do not become a live initial selection', () => {
  assert.deepEqual(initialRoute(false,'preview-0','mother-oracle'), {view:'new',projectId:null})
  assert.deepEqual(initialRoute(true,'real-chat','real-repo'), {view:'chat',chatId:'preview-0'})
  assert.deepEqual(initialRoute(false,'real-chat','real-repo'), {view:'chat',chatId:'real-chat'})
})

test('missing preview and stale remembered routes recover, explicit unknown IDs remain honest', () => {
  assert.deepEqual(recoverChatRoute({view:'chat',chatId:'preview-0'},[],[],false), {view:'new',projectId:null})
  assert.deepEqual(recoverChatRoute({view:'chat',chatId:'gone'},[],[],true), {view:'new',projectId:null})
  assert.equal(recoverChatRoute({view:'chat',chatId:'gone'},[],[],false), null)
  assert.equal(recoverChatRoute({view:'chat',chatId:'existing'},[{id:'existing'}],[],true), null)
})

test('old chat links using a native session UUID recover to the matching real thread', () => {
  assert.deepEqual(recoverChatRoute({view:'chat',chatId:'native-id'},[],[session('native-id','/Code/repo')],false), {view:'native',sessionId:'native-id',tab:'saved',search:''})
  assert.deepEqual(recoverChatRoute({view:'chat',chatId:'native-id'},[{id:'app-id',sessionId:'native-id'}],[],false), {view:'chat',chatId:'app-id'})
})

test('discovered IDs and duplicate saved IDs remain valid aliases after registration', () => {
  const duplicate = { ...project, id:'older-alias', name:'Older name' }
  const rows=buildWorkspaceRepositories([project,duplicate],[repo('discovered-id',project.path,5)],[],[{id:'old-chat',projectId:duplicate.id}])
  assert.equal(rows.length,1)
  assert.deepEqual(rows[0].aliases,['discovered-id',project.id,duplicate.id])
  assert.equal(rows[0].chats[0].id,'old-chat')
})

test('hidden repository preferences survive IDs changing and reject corrupt storage', async () => {
  const { parseHiddenRepositories, changeRepositoryVisibility } = await import('../src/repository-visibility.ts')
  assert.equal(parseHiddenRepositories('{broken').size,0)
  assert.equal(parseHiddenRepositories('{"path":"/Code/repo"}').size,0)
  assert.deepEqual([...parseHiddenRepositories('["/Code/repo/", "relative", null, "/Code/repo"]')],['/Code/repo'])
  const original=new Set()
  const hidden=changeRepositoryVisibility(original,'/Code/repo/',true)
  assert.equal(original.size,0)
  assert.deepEqual([...parseHiddenRepositories(JSON.stringify([...hidden]))],['/Code/repo'])
  assert.equal(changeRepositoryVisibility(hidden,'/Code/repo',false).size,0)
})


test('canonical path groups legacy project and native symlink aliases without changing IDs', () => {
  const alias = { ...project, path:'/alias', canonicalPath:project.path }
  const native = { ...session('native','/other-alias'), canonicalPath:project.path }
  const rows=buildWorkspaceRepositories([alias],[repo('discovered',project.path)],[native],[{id:'chat',projectId:alias.id}])
  assert.equal(rows.length,1)
  assert.equal(rows[0].path,project.path)
  assert.equal(rows[0].sessions[0].sessionId,'native')
  assert.equal(rows[0].chats[0].id,'chat')
})
