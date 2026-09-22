import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CodexSessions } from '../server/codex-sessions.mjs';

const COLUMNS = ['id', 'rollout_path', 'cwd', 'name', 'title', 'first_user_message', 'preview', 'created_at', 'created_at_ms', 'updated_at', 'updated_at_ms', 'recency_at_ms', 'archived', 'thread_source', 'originator', 'model'];

// A scratch state_5.sqlite with the columns this backend actually reads. The developer's
// real ~/.codex is never opened by these tests.
async function scratchHome(t, rows = []) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cc-codex-sessions-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'thread-writer-locks'), { recursive: true });
  const database = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  database.exec(`create table threads (${COLUMNS.map((name) => `${name} ${name.endsWith('_ms') || name === 'created_at' || name === 'updated_at' || name === 'archived' ? 'INTEGER' : 'TEXT'}`).join(', ')})`);
  const insert = database.prepare(`insert into threads (${COLUMNS.join(', ')}) values (${COLUMNS.map(() => '?').join(', ')})`);
  for (const row of rows) {
    insert.run(...COLUMNS.map((name) => ({ archived: 0, created_at: 0, updated_at: 0, ...row })[name] ?? null));
  }
  database.close();
  return home;
}

function lockTable(entries) {
  return (command, args, options, callback) => {
    const directory = args.at(-1);
    const lines = [];
    for (const [pid, ids] of Object.entries(entries)) {
      lines.push(`p${pid}`);
      for (const id of ids) lines.push(`n${path.join(directory, `${id}.lock`)}`);
    }
    callback(lines.length ? null : Object.assign(new Error('no open files'), { code: 1 }), lines.join('\n'));
  };
}

function fakeServer(script = {}) {
  const calls = [];
  return {
    calls,
    methods() { return calls.map(([method]) => method); },
    closed: false,
    async request(method, params) {
      calls.push([method, params]);
      if (!script[method]) throw Object.assign(new Error(`${method} is not supported`), { code: -32601 });
      return script[method](params);
    },
    async close() { this.closed = true; },
  };
}

const THREAD = { id: 't1', rollout_path: '/tmp/none.jsonl', cwd: '/work/repo' };

test('saved threads are the interactive, non-archived ones, newest first, in the app shape', async (t) => {
  const home = await scratchHome(t, [
    { ...THREAD, id: 'user-thread', name: 'Pinned name', title: 'Summary', first_user_message: 'hello there', created_at_ms: 1_000, recency_at_ms: 9_000, thread_source: 'user' },
    { ...THREAD, id: 'null-source', preview: 'only a preview', created_at: 5, updated_at: 7, thread_source: null },
    { ...THREAD, id: 'subagent', thread_source: 'subagent', recency_at_ms: 99_000 },
    { ...THREAD, id: 'avatar', thread_source: 'avatar_quick_chat', recency_at_ms: 99_000 },
    { ...THREAD, id: 'archived-thread', archived: 1, recency_at_ms: 99_000 },
  ]);
  const sessions = new CodexSessions({ server: fakeServer(), codexHome: home });
  const listed = await sessions.listSessions();

  // Subagent, review and quick-chat threads outnumber real ones seven to one; without the
  // interactive filter the list is mostly machinery talking to itself.
  assert.deepEqual(listed.map((item) => item.sessionId), ['user-thread', 'null-source']);
  assert.deepEqual(listed[0], {
    sessionId: 'user-thread', cwd: '/work/repo', path: '/tmp/none.jsonl',
    customTitle: 'Pinned name', summary: 'Summary', firstPrompt: 'hello there',
    createdAt: 1_000, lastModified: 9_000,
  });
  // recency_at_ms defaults to 0 and updated_at_ms was added later, so the seconds column
  // is the only one present on every row.
  assert.equal(listed[1].lastModified, 7_000);
  assert.equal(listed[1].createdAt, 5_000);
  assert.equal(listed[1].firstPrompt, 'only a preview');
  assert.equal(listed[1].customTitle, null);

  assert.deepEqual((await sessions.listSessions({ limit: 1 })).map((item) => item.sessionId), ['user-thread']);
  assert.deepEqual((await sessions.listSessions({ limit: 1, offset: 1 })).map((item) => item.sessionId), ['null-source']);
});

test('history pages thread/items/list, normalizes both message kinds, and slices to the window', async (t) => {
  const home = await scratchHome(t, [THREAD]);
  const pages = {
    undefined: { data: [{ item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'ask' }] } }, { item: { type: 'reasoning', id: 'r1' } }], nextCursor: 'page-2' },
    'page-2': { data: [{ item: { type: 'holographicProjection', id: 'x1' } }, { item: { type: 'commandExecution', id: 'c1', status: 'completed', command: ['ls'], exitCode: 0, aggregatedOutput: 'a' } }, { item: { type: 'agentMessage', id: 'a1', text: 'answer' } }], nextCursor: null },
  };
  const requests = [];
  const server = fakeServer({ 'thread/items/list'(params) { requests.push(params); return pages[params.cursor]; } });
  const sessions = new CodexSessions({ server, codexHome: home });

  const all = await sessions.getSessionMessages('t1', { limit: 10 });
  assert.deepEqual(requests[0], { threadId: 't1', limit: 10 });
  assert.equal(requests[1].cursor, 'page-2');
  assert.deepEqual(all.map((record) => [record.type, record.uuid]), [['user', 'u1'], ['assistant', 'c1'], ['assistant', 'a1']]);
  // A tool becomes the tool_use/tool_result pair native-sessions' normalizer consumes.
  assert.deepEqual(all[1].message.content, [
    { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', tool_use_id: 'c1', content: 'a', is_error: false },
  ]);
  assert.deepEqual(all[0].message.content, [{ type: 'text', text: 'ask' }]);
  assert.equal(all[0].session_id, 't1');

  const windowed = await sessions.getSessionMessages('t1', { offset: 1, limit: 1 });
  assert.deepEqual(windowed.map((record) => record.uuid), ['c1']);
});

// thread/items/list answers one of these for a thread that exists but has no rollout yet
// — thread/start ran and no turn has completed. That is an empty history, not a failure.
test('a thread with no rollout yet reads as empty history, and any other error propagates', async (t) => {
  const home = await scratchHome(t, [THREAD]);
  for (const code of [-32601, -32600]) {
    const server = fakeServer({ 'thread/items/list'() { throw Object.assign(new Error('no rollout'), { code }); } });
    assert.deepEqual(await new CodexSessions({ server, codexHome: home }).getSessionMessages('t1'), []);
  }
  const broken = fakeServer({ 'thread/items/list'() { throw Object.assign(new Error('disk on fire'), { code: -32000 }); } });
  await assert.rejects(new CodexSessions({ server: broken, codexHome: home }).getSessionMessages('t1'), /disk on fire/);
});

test('thread metadata is overlaid with the rollout file the change token is built from', async (t) => {
  const home = await scratchHome(t, [{ ...THREAD, rollout_path: path.join(os.tmpdir(), 'cc-rollout-missing.jsonl'), title: 'Summary', recency_at_ms: 4_000 }]);
  const rollout = path.join(home, 'rollout.jsonl');
  await writeFile(rollout, 'x'.repeat(41));
  const sessions = new CodexSessions({ server: fakeServer(), codexHome: home });

  assert.equal(await sessions.getSessionInfo('nope'), null);
  const missingFile = await sessions.getSessionInfo('t1');
  assert.equal(missingFile.fileSize, null);
  assert.equal(missingFile.lastModified, 4_000, 'a missing rollout falls back to the index timestamp');

  const withFile = await scratchHome(t, [{ ...THREAD, rollout_path: rollout, recency_at_ms: 4_000 }]);
  const present = await new CodexSessions({ server: fakeServer(), codexHome: withFile }).getSessionInfo('t1');
  assert.equal(present.fileSize, 41);
  assert.notEqual(present.lastModified, 4_000, 'the rollout is what actually moves when an item is appended');
});

test('live threads come from held writer locks, are filtered to interactive, and quote their id', async (t) => {
  const home = await scratchHome(t, [
    { ...THREAD, id: "held'thread", name: 'Open here', cwd: '/work/one', created_at_ms: 10, recency_at_ms: 20 },
    { ...THREAD, id: 'held-subagent', thread_source: 'subagent' },
    { ...THREAD, id: 'idle-thread' },
  ]);
  const sessions = new CodexSessions({
    server: fakeServer(), codexHome: home,
    execFileFn: lockTable({ 4321: ["held'thread", 'held-subagent'] }),
  });
  const live = await sessions.listLiveThreads();
  assert.equal(live.length, 1);
  assert.deepEqual(live[0], {
    kind: 'interactive', id: "held'thread", sessionId: "held'thread", pid: 4321,
    cwd: '/work/one', name: 'Open here', startedAt: 10, updatedAt: 20,
    // The lock is held for as long as the thread is loaded, so an open idle thread counts.
    status: 'busy',
    terminalCommand: "codex resume 'held'\\''thread'",
  });
});

test('no held lock means no live thread, and the thread index is not even opened', async (t) => {
  const home = await scratchHome(t, [THREAD]);
  const sessions = new CodexSessions({ server: fakeServer(), codexHome: home, execFileFn: lockTable({}) });
  assert.deepEqual(await sessions.listLiveThreads(), []);
  await rm(path.join(home, 'state_5.sqlite'));
  assert.deepEqual(await sessions.listLiveThreads(), [], 'the empty holder set short-circuits before any read');
});

test('an unreadable thread index is a 503 rather than a crash', async (t) => {
  const home = await scratchHome(t, []);
  await rm(path.join(home, 'state_5.sqlite'));
  const sessions = new CodexSessions({ server: fakeServer(), codexHome: home });
  await assert.rejects(sessions.listSessions(), (error) => error.statusCode === 503 && /Unable to read Codex thread state/.test(error.message));
});

test('rename goes through thread/name/set and close reaps the shared child', async (t) => {
  const home = await scratchHome(t, [THREAD]);
  const server = fakeServer({ 'thread/name/set': () => ({}) });
  const sessions = new CodexSessions({ server, codexHome: home });
  await sessions.renameSession('t1', 'Chosen title');
  assert.deepEqual(server.calls.at(-1), ['thread/name/set', { threadId: 't1', name: 'Chosen title' }]);
  await sessions.close();
  assert.equal(server.closed, true);
});

// Wiring note 4: this connection is shared with every other reader. thread/resume and
// thread/start take the writer lock and would break every live CodexRunner turn.
test('the shared connection never takes the writer lock', async (t) => {
  const home = await scratchHome(t, [THREAD]);
  const server = fakeServer({
    'thread/items/list': () => ({ data: [], nextCursor: null }),
    'thread/name/set': () => ({}),
  });
  const sessions = new CodexSessions({ server, codexHome: home, execFileFn: lockTable({ 1: ['t1'] }) });
  await sessions.listSessions();
  await sessions.getSessionMessages('t1');
  await sessions.getSessionInfo('t1');
  await sessions.listLiveThreads();
  await sessions.renameSession('t1', 'name');
  assert.deepEqual([...new Set(server.methods())].sort(), ['thread/items/list', 'thread/name/set']);
});
