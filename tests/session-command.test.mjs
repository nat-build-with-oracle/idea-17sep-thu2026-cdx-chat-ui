import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

async function loadCommand(t) {
  const server = await createServer({ server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' })
  t.after(() => server.close())
  return server.ssrLoadModule('/src/SessionCommand.tsx')
}

test('removed-provider sessions are read-only and never offer Codex commands', async t => {
  const { default: SessionCommand } = await loadCommand(t)
  for (const chat of [{ provider: 'zai', model: 'glm-5.3' }, { provider: 'claude', model: 'opus' }, { provider: undefined, model: 'sonnet' }]) {
    const html = renderToStaticMarkup(createElement(SessionCommand, { sessionId: 'legacy-session', ...chat, onCopy() {} }))
    assert.match(html, /removed provider/i)
    assert.match(html, /read-only/i)
    assert.doesNotMatch(html, /codex resume|Copy -p|Copy new tmux|Show all commands/)
  }
})

// The mirror of the inverted gate: a Codex chat whose stored model id this build has
// never heard of is still live, because the id list is served, not compiled in.
test('a Codex chat with an unrecognised stored model still offers its launch commands', async t => {
  const { default: SessionCommand } = await loadCommand(t)
  const html = renderToStaticMarkup(createElement(SessionCommand, { sessionId: 'future-session', provider: 'codex', model: 'gpt-9-not-yet-released', onCopy() {} }))
  assert.doesNotMatch(html, /removed provider|is kept read-only/i)
  assert.match(html, /codex resume &#x27;future-session&#x27;/)
  assert.match(html, /Show all commands/)
})

test('native legacy read-only reasons suppress commands without provider metadata', async t => {
  const { default: SessionCommand } = await loadCommand(t)
  const html = renderToStaticMarkup(createElement(SessionCommand, { sessionId: 'native-legacy', readOnlyReason: 'This saved session belongs to a removed provider and is read-only.', onCopy() {} }))
  assert.match(html, /removed provider/i)
  assert.doesNotMatch(html, /codex resume|Show all commands/)
})

test('resume command copies the exact visible CLI without executing it', async t => {
  const { default: SessionCommand, resumeCommand } = await loadCommand(t)
  // No `cd`: `codex resume` reopens the thread in its own recorded working directory.
  const expected = "codex resume 'session-full-id'"
  assert.equal(resumeCommand('session-full-id'), expected)
  assert.doesNotMatch(resumeCommand('session-full-id'), /cd |--resume/)

  let copied = ''
  const tree = SessionCommand({ sessionId: 'session-full-id', provider: 'codex', cwd: '/Users/example/My Repo', onCopy(command) { copied = command } })
  tree.props.children[0].props.onClick()
  assert.equal(copied, expected)

  const html = renderToStaticMarkup(createElement(SessionCommand, { sessionId: 'session-full-id', provider: 'codex', cwd: '/Users/example/My Repo', onCopy() {} }))
  assert.match(html, /<code>codex resume &#x27;session-full-id&#x27;<\/code>/)
  assert.match(html, /aria-label="Copy resume command:/)
  assert.match(html, /title="codex resume/)
})

test('compact header command is a copyable summary; full commands remain in the disclosure', async t => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/styles.css', import.meta.url), 'utf8'))
  assert.match(source, /\.session-command code \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s)
  assert.doesNotMatch(source, /\.session-command code \{[^}]*overflow-x:\s*auto;/s)
  const { default: SessionCommand } = await loadCommand(t)
  const html = renderToStaticMarkup(createElement(SessionCommand, { sessionId: 'long-session', provider: 'codex', cwd: '/very/long/project/path', onCopy() {} }))
  assert.match(html, /Show all commands/)
  assert.match(html, /Full session commands/)
})

test('shell quoting preserves apostrophes in the thread id', async t => {
  const { resumeCommand } = await loadCommand(t)
  assert.equal(resumeCommand("session'id"), "codex resume 'session'\\''id'")
  assert.equal(resumeCommand('session-id'), "codex resume 'session-id'")
})

test('missing session IDs render no command or placeholder', async t => {
  const { default: SessionCommand } = await loadCommand(t)
  assert.equal(renderToStaticMarkup(createElement(SessionCommand, { sessionId: null, cwd: '/repo', onCopy() {} })), '')
})

test('the adjacent tmux button copies a named session launcher without replacing the resume command', async t => {
  const { default: SessionCommand } = await loadCommand(t)
  let copied
  const props = { sessionId: 'native-id', provider: 'codex', cwd: '/repos/neo-oracle', title: 'arra memory one click', onCopy: (...args) => { copied = args } }
  const tree = SessionCommand(props)
  const html = renderToStaticMarkup(tree)
  assert.match(html, /Copy tmux/)
  assert.match(html, /Copy tmux command for neo-oracle-arra-memory-one-click/)
  assert.equal((html.match(/<button/g) || []).length, 9)
  tree.props.children[1].props.onClick()
  assert.equal(copied[1], 'tmux')
  assert.match(copied[0], /tmux new-session/)
  assert.match(copied[0], /maw a/)
  // tmux still needs a start directory of its own, so -c keeps the cwd.
  assert.match(copied[0], /-c '\/repos\/neo-oracle'/)
  tree.props.children[0].props.onClick()
  assert.deepEqual(copied, ["codex resume 'native-id'", 'resume'])
})

test('one-shot test copies an explicit read-only prompt and preserves the current thread id', async t => {
  const { default: SessionCommand, oneShotCommand } = await loadCommand(t)
  const id = '11111111-2222-4333-8444-666666666666'
  const expected = `codex exec resume '${id}' -s read-only 'Reply with exactly: ARRA sync test OK. Do not use tools or modify files.'`
  assert.equal(oneShotCommand(id), expected)
  let copied
  const tree = SessionCommand({ sessionId: id, provider: 'codex', cwd: '/repos/neo-oracle', onCopy: (...args) => { copied = args } })
  tree.props.children[2].props.onClick()
  assert.deepEqual(copied, [expected, 'oneshot'])
  assert.match(renderToStaticMarkup(tree), /Running uses Codex quota and appends a test turn/)
  assert.doesNotMatch(expected, /dangerously-bypass-approvals-and-sandbox|--ephemeral/)
})

test('collapsed disclosure contains complete selectable commands and each copy matches its text', async t => {
  const { default: SessionCommand, resumeCommand, oneShotCommand } = await loadCommand(t)
  const copied = []
  const tree = SessionCommand({ sessionId: 'exact-id', provider: 'codex', cwd: '/repos/neo-oracle', title: 'Memory test', onCopy: (...args) => copied.push(args) })
  const disclosure = tree.props.children.find(child => child?.type === 'details')
  assert.equal(disclosure.props.open, undefined)
  const cards = disclosure.props.children[1].props.children[1]
  assert.equal(cards.length, 6)
  for (const card of cards) {
    const displayed = card.props.children[1].props.children.props.children
    card.props.children[0].props.children[1].props.onClick()
    assert.equal(copied.at(-1)[0], displayed)
  }
  assert.deepEqual(copied.map(([, kind]) => kind), ['resume', 'tmux', 'oneshot', 'resume', 'tmux', 'oneshot'])
  assert.equal(copied[0][0], resumeCommand('exact-id'))
  assert.equal(copied[2][0], oneShotCommand('exact-id'))
  const html = renderToStaticMarkup(tree)
  assert.match(html, /Show all commands/)
  assert.match(html, /Full session commands/)
  assert.match(html, /Copy only—nothing runs here/)
  assert.equal((html.match(/<pre><code>/g) || []).length, 6)
})

test('verified existing terminal copies the backend attach command exactly without changing launch commands', async t => {
  const { default: SessionCommand, resumeCommand } = await loadCommand(t)
  const guardedAttach = "if tmux has-session -t '=ampere-token' 2>/dev/null; then maw a 'ampere-token'; else printf '%s\\n' 'Terminal closed.' >&2; false; fi"
  const existingTerminal = {
    sessionName: 'ampere-token',
    target: 'ampere-token:arra-memory-one-click.0',
    paneId: '%94',
    attachCommand: guardedAttach,
  }
  const copied = []
  const tree = SessionCommand({
    sessionId: 'native-id',
    provider: 'codex',
    cwd: '/repos/neo-oracle',
    title: 'arra memory one click',
    existingTerminal,
    onCopy: (...args) => copied.push(args),
  })
  const attachButton = tree.props.children.find(child => child?.props?.className?.includes('existing-terminal-command'))
  attachButton.props.onClick()
  assert.deepEqual(copied.at(-1), [guardedAttach, 'attach'])

  const cards = tree.props.children.find(child => child?.type === 'details').props.children[1].props.children[1]
  assert.equal(cards.length, 7)
  assert.equal(cards[0].props.children[1].props.children.props.children, guardedAttach)
  cards[0].props.children[0].props.children[1].props.onClick()
  assert.deepEqual(copied.at(-1), [guardedAttach, 'attach'])
  assert.equal(cards[1].props.children[1].props.children.props.children, resumeCommand('native-id'))

  const html = renderToStaticMarkup(tree)
  assert.match(html, /Copy existing terminal/)
  assert.match(html, /Existing terminal · ampere-token · ampere-token:arra-memory-one-click\.0/)
  assert.match(html, /New tmux · neo-oracle-arra-memory-one-click/)
  assert.match(html, /Existing terminal attach is safe while its owner is open/)
  assert.match(html, /Before running resume, new tmux, or one-shot commands, finish any existing Codex writer/)
  assert.doesNotMatch(existingTerminal.attachCommand, /arra-memory-one-click|%94/)
})

test('full-access variants opt in to sandbox bypass without changing standard commands', async t => {
  const { default: SessionCommand, resumeCommand, oneShotCommand } = await loadCommand(t)
  const id = "session'quoted"
  const cwd = "/Users/O'Brien/neo-oracle"
  assert.equal(resumeCommand(id, true), `${resumeCommand(id)} --dangerously-bypass-approvals-and-sandbox`)
  assert.doesNotMatch(resumeCommand(id), /dangerously/)
  assert.match(oneShotCommand(id, true), /--dangerously-bypass-approvals-and-sandbox '/)
  // The full-access one-shot genuinely is not sandboxed: it must not also claim read-only.
  assert.doesNotMatch(oneShotCommand(id, true), /-s read-only/)
  assert.match(oneShotCommand(id), /-s read-only/)
  const copied = []
  const tree = SessionCommand({ sessionId: id, provider: 'codex', cwd, title: 'Memory', onCopy: (...args) => copied.push(args) })
  const cards = tree.props.children.find(child => child?.type === 'details').props.children[1].props.children[1]
  const dangerous = cards.filter(card => card.props.className.includes('dangerous'))
  assert.equal(dangerous.length, 3)
  for (const card of dangerous) {
    card.props.children[0].props.children[1].props.onClick()
    assert.equal(copied.at(-1)[0], card.props.children[1].props.children.props.children)
    assert.equal((copied.at(-1)[0].match(/--dangerously-bypass-approvals-and-sandbox/g) || []).length, 1)
  }
  assert.match(renderToStaticMarkup(tree), /Full access bypasses the sandbox/)
  assert.match(renderToStaticMarkup(tree), /Full access · One-shot sync test \(no sandbox\)/)
})
