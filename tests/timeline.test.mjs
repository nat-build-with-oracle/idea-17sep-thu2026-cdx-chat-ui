import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createTimelineRoutes, TimelineService } from '../server/timeline/index.mjs';
import { timelineScript } from '../server/timeline/view.mjs';
import { parseLockTable } from '../server/timeline/locks.mjs';
import { INTERACTIVE_THREADS } from '../server/timeline/threads.mjs';

const COLUMNS = ['id', 'rollout_path', 'cwd', 'name', 'title', 'created_at', 'updated_at', 'updated_at_ms', 'recency_at_ms', 'archived', 'thread_source', 'originator', 'model'];

function record(item, { ordinal = 0, timestamp = '2026-09-17T08:00:00.000Z' } = {}) {
  return JSON.stringify({ type: 'event_msg', ordinal, timestamp, payload: { type: 'item_completed', item } });
}

// A scratch CODEX_HOME holding a real thread index and real rollout files. Nothing here
// reads the developer's own ~/.codex.
async function scratchHome(t, threads) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cc-timeline-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'thread-writer-locks'), { recursive: true });
  const database = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  database.exec(`create table threads (${COLUMNS.map((name) => `${name} ${['created_at', 'updated_at', 'updated_at_ms', 'recency_at_ms', 'archived'].includes(name) ? 'INTEGER' : 'TEXT'}`).join(', ')})`);
  const insert = database.prepare(`insert into threads (${COLUMNS.join(', ')}) values (${COLUMNS.map(() => '?').join(', ')})`);
  for (const thread of threads) {
    const rollout = path.join(home, `${thread.id}.jsonl`);
    await writeFile(rollout, thread.lines === undefined ? '' : `${thread.lines.join('\n')}\n`);
    const row = { archived: 0, created_at: 0, updated_at: 0, rollout_path: thread.missing ? path.join(home, 'gone.jsonl') : rollout, ...thread };
    insert.run(...COLUMNS.map((name) => row[name] ?? null));
  }
  database.close();
  return home;
}

function lockTable(entries, { fail = false } = {}) {
  return (command, args, options, callback) => {
    if (fail) return callback(Object.assign(new Error('lsof: command not found'), { code: 'ENOENT' }), '');
    const directory = args.at(-1);
    const lines = [];
    for (const [pid, ids] of Object.entries(entries)) {
      lines.push(`p${pid}`);
      for (const id of ids) lines.push(`n${path.join(directory, `${id}.lock`)}`);
    }
    callback(lines.length ? null : Object.assign(new Error('nothing open'), { code: 1 }), lines.join('\n'));
  };
}

test('there is exactly one spelling of the interactive predicate', () => {
  assert.equal(INTERACTIVE_THREADS, "(thread_source is null or thread_source = 'user')");
});

test('a snapshot row carries thread identity, liveness and the renderable item', async (t) => {
  const home = await scratchHome(t, [{
    id: 'thread-a', cwd: '/work/repo', name: 'Summarize current status', thread_source: 'user',
    originator: 'codex-tui', recency_at_ms: 9_000,
    lines: [
      record({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'ask me' }] }, { ordinal: 1, timestamp: '2026-09-17T08:00:01.000Z' }),
      record({ type: 'AgentMessage', id: 'a1', text: 'the answer' }, { ordinal: 2, timestamp: '2026-09-17T08:00:02.000Z' }),
      record({ type: 'CommandExecution', id: 'c1', status: 'completed', command: ['ls'], exit_code: 0, aggregated_output: 'tool output' }, { ordinal: 3, timestamp: '2026-09-17T08:00:03.000Z' }),
      record({ type: 'Reasoning', id: 'r1', text: 'never shown' }, { ordinal: 4 }),
      record({ type: 'HolographicProjection', id: 'x1' }, { ordinal: 5 }),
    ],
  }]);
  const service = new TimelineService({ codexHome: home, execFileFn: lockTable({ 4321: ['thread-a'] }) });
  const snapshot = await service.snapshot({ limit: 20 });

  assert.equal(snapshot.threads, 1);
  assert.equal(snapshot.liveThreads, 1);
  assert.equal(snapshot.lockReadFailed, false);
  assert.equal(snapshot.readErrors, 0);
  assert.equal(snapshot.unknownItems, 1, 'an unrenderable item is counted, not silently dropped');
  assert.equal(snapshot.rows.length, 3, 'reasoning is discarded outright');

  // Newest first.
  assert.deepEqual(snapshot.rows.map((row) => row.itemId), ['c1', 'a1', 'u1']);
  const [tool, agent, user] = snapshot.rows;
  assert.deepEqual(tool, {
    id: 'thread-a:3', threadId: 'thread-a', itemId: 'c1',
    path: path.join(home, 'thread-a.jsonl'), project: '/work/repo', name: 'Summarize current status',
    tier: 'user', originator: 'codex-tui', live: true, timestamp: '2026-09-17T08:00:03.000Z',
    kind: 'tool-use', role: 'assistant', title: 'Bash', text: 'tool output', truncated: false,
  });
  // The header is `row.title || row.role`; a non-tool row has no title, and a header must
  // never read "undefined".
  assert.equal(agent.title, null);
  assert.equal(agent.kind, 'assistant');
  assert.equal(agent.role, 'assistant');
  assert.equal(agent.text, 'the answer');
  assert.equal(user.kind, 'user');
  assert.equal(user.role, 'user');
  assert.equal(user.text, 'ask me');
  for (const row of snapshot.rows) assert.equal(typeof (row.title || row.role), 'string');
});

test('a running tool shows its input, since it has no result to show yet', async (t) => {
  const home = await scratchHome(t, [{
    id: 'thread-a', cwd: '/work', thread_source: 'user',
    lines: [record({ type: 'CommandExecution', id: 'c1', status: 'inProgress', command: ['sleep', '30'] })],
  }]);
  const snapshot = await new TimelineService({ codexHome: home, execFileFn: lockTable({}) }).snapshot();
  assert.equal(snapshot.rows[0].kind, 'tool-use');
  assert.equal(snapshot.rows[0].title, 'Bash');
  assert.deepEqual(JSON.parse(snapshot.rows[0].text), { command: 'sleep 30' });
});

test('only interactive, non-archived threads are scanned', async (t) => {
  const line = record({ type: 'AgentMessage', id: 'a1', text: 'hello' });
  const home = await scratchHome(t, [
    { id: 'user-thread', cwd: '/work', thread_source: 'user', recency_at_ms: 50, lines: [line] },
    { id: 'null-thread', cwd: '/work', thread_source: null, recency_at_ms: 40, lines: [line] },
    { id: 'subagent', cwd: '/work', thread_source: 'subagent', recency_at_ms: 90, lines: [line] },
    { id: 'quick-chat', cwd: '/work', thread_source: 'avatar_quick_chat', recency_at_ms: 90, lines: [line] },
    { id: 'archived', cwd: '/work', thread_source: 'user', archived: 1, recency_at_ms: 90, lines: [line] },
  ]);
  const snapshot = await new TimelineService({ codexHome: home, execFileFn: lockTable({}) }).snapshot();
  assert.equal(snapshot.threads, 2);
  assert.deepEqual([...new Set(snapshot.rows.map((row) => row.threadId))].sort(), ['null-thread', 'user-thread']);
});

// An empty holder map means "nothing is live" only while the read succeeded. Otherwise
// liveness is unknown, and drawing every thread as idle would be a lie.
test('a failed lock read reports liveThreads:0 as unknown rather than idle', async (t) => {
  const home = await scratchHome(t, [{ id: 'thread-a', cwd: '/work', thread_source: 'user', lines: [record({ type: 'AgentMessage', id: 'a1', text: 'hi' })] }]);
  const snapshot = await new TimelineService({ codexHome: home, execFileFn: lockTable({}, { fail: true }) }).snapshot();
  assert.equal(snapshot.liveThreads, 0);
  assert.equal(snapshot.lockReadFailed, true);
  assert.equal(snapshot.rows[0].live, false);

  const healthy = await new TimelineService({ codexHome: home, execFileFn: lockTable({}) }).snapshot();
  assert.equal(healthy.lockReadFailed, false, 'lsof exiting 1 is the ordinary "nothing is open" answer');
});

test('an unreadable rollout is counted as a read error without losing the rest of the timeline', async (t) => {
  const home = await scratchHome(t, [
    { id: 'gone-thread', cwd: '/work', thread_source: 'user', recency_at_ms: 90, missing: true, lines: [] },
    { id: 'good-thread', cwd: '/work', thread_source: 'user', recency_at_ms: 50, lines: [record({ type: 'AgentMessage', id: 'a1', text: 'still here' })] },
  ]);
  const snapshot = await new TimelineService({ codexHome: home, execFileFn: lockTable({}) }).snapshot();
  assert.equal(snapshot.readErrors, 1);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].text, 'still here');
});

test('the project filter and the session cap are reported, not silently applied', async (t) => {
  const line = record({ type: 'AgentMessage', id: 'a1', text: 'hello' });
  const home = await scratchHome(t, [
    { id: 'one', cwd: '/work/one', thread_source: 'user', recency_at_ms: 50, lines: [line] },
    { id: 'two', cwd: '/work/two', thread_source: 'user', recency_at_ms: 40, lines: [line] },
  ]);
  const filtered = await new TimelineService({ codexHome: home, execFileFn: lockTable({}) }).snapshot({ project: ['/work/one'] });
  assert.deepEqual(filtered.rows.map((row) => row.threadId), ['one']);
  assert.equal(filtered.totalFiles, 1);
  assert.equal(filtered.limitedSessions, false);

  const capped = await new TimelineService({ codexHome: home, maxSessions: 1, execFileFn: lockTable({}) }).snapshot();
  assert.equal(capped.filesConsidered, 1);
  assert.equal(capped.totalFiles, 2);
  assert.equal(capped.limitedSessions, true);
  assert.equal(capped.threads, 2, 'the thread count is the whole index, not the scanned slice');
});

test('a missing thread index is a 503 the page can render, not a crash', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cc-timeline-empty-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(
    new TimelineService({ codexHome: home, execFileFn: lockTable({}) }).snapshot(),
    (error) => error.statusCode === 503 && /Codex thread index is unavailable/.test(error.message),
  );
});

test('the lock table is parsed from the process table, never from file existence', () => {
  const holders = parseLockTable([
    'p4321', 'n/home/u/.codex/thread-writer-locks/thread-a.lock', 'n/home/u/.codex/not-a-lock.txt',
    'p1234', 'n/home/u/.codex/thread-writer-locks/thread-a.lock', 'n/home/u/.codex/thread-writer-locks/thread-b.lock',
    'pnot-a-pid', 'n/home/u/.codex/thread-writer-locks/thread-c.lock',
  ].join('\n'));
  assert.deepEqual([...holders.keys()].sort(), ['thread-a', 'thread-b']);
  assert.deepEqual(holders.get('thread-a'), [1234, 4321]);
  assert.deepEqual(parseLockTable(''), new Map());
});

test('the timeline routes answer only their own GETs and bound the limit', async (t) => {
  const home = await scratchHome(t, [{ id: 'thread-a', cwd: '/work', thread_source: 'user', lines: [record({ type: 'AgentMessage', id: 'a1', text: 'hi' })] }]);
  const timeline = createTimelineRoutes({ codexHome: home, execFileFn: lockTable({}) });
  const responses = [];
  const response = () => {
    const entry = { status: 0, headers: {}, body: '' };
    responses.push(entry);
    return { writeHead(status, headers) { entry.status = status; entry.headers = headers; }, end(body) { entry.body = body ?? ''; } };
  };
  const get = (url) => timeline({ method: 'GET' }, response(), new URL(url, 'http://127.0.0.1'));

  assert.equal(await get('/api/state'), false, 'a route it does not own is left to the app');
  assert.equal(await timeline({ method: 'POST' }, response(), new URL('/api/timeline', 'http://127.0.0.1')), false);

  assert.equal(await get('/api/timeline?limit=20'), true);
  assert.equal(JSON.parse(responses.at(-1).body).rows.length, 1);
  await assert.rejects(get('/api/timeline?limit=21'), (error) => error.statusCode === 400);
  await assert.rejects(get(`/api/timeline?project=${'x'.repeat(5000)}`), (error) => error.statusCode === 400);

  // Backend-served, outside the frozen src/ UI, and locked down by its own CSP.
  assert.equal(await get('/api/timeline/view'), true);
  assert.match(responses.at(-1).headers['content-type'], /text\/html/);
  assert.match(responses.at(-1).headers['content-security-policy'], /default-src 'none'/);
  assert.match(responses.at(-1).headers['content-security-policy'], /script-src 'self'/);
  assert.equal(responses.at(-1).headers['x-content-type-options'], 'nosniff');
  assert.match(responses.at(-1).body, /^<!doctype html>/i);
  assert.equal(await get('/api/timeline/view.js'), true);
  assert.match(responses.at(-1).headers['content-type'], /text\/javascript/);
});

// The API sorts newest-first and the default selection is "New events: At the top", so the
// client must render rows as delivered; reversing there parks the viewer on the oldest event.
test('the newest event renders first under the default direction and last under "at the bottom"', () => {
  const ordering = timelineScript().match(/const visible = .*/)?.[0];
  assert.ok(ordering, 'the client script no longer assigns `visible` — update this assertion with it');

  const newestFirst = [{ t: 3 }, { t: 2 }, { t: 1 }];
  const render = new Function('rows', 'state', `${ordering}\nreturn visible;`);

  assert.deepEqual(render(newestFirst, { direction: 'top' }), newestFirst);
  assert.equal(render(newestFirst, { direction: 'top' })[0].t, 3);
  assert.equal(render(newestFirst, { direction: 'bottom' }).at(-1).t, 3);
});
