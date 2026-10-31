import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexRunner } from '../server/codex-runner.mjs';

// The Claude runner's double was a fake child emitting stdout JSONL. Codex speaks
// JSON-RPC over one app-server connection, so the double answers requests and pushes
// notifications instead. It MUST implement onExit: the runner's terminal promise is
// resolved either by turn/completed or by the child dying, and a stub without onExit
// leaves a turn pending forever — a hang, not a failure.
function fakeConnection(script = {}, options = {}) {
  const listeners = new Map();
  const exitListeners = new Set();
  const calls = [];
  let closed = false;
  const connection = {
    calls,
    options,
    params(method) { return calls.find(([name]) => name === method)?.[1]; },
    methods() { return calls.map(([name]) => name); },
    async start() { calls.push(['start']); },
    on(methods, listener) {
      const names = Array.isArray(methods) ? methods : [methods];
      for (const name of names) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(listener);
      }
      return () => { for (const name of names) listeners.get(name)?.delete(listener); };
    },
    onExit(listener) { exitListeners.add(listener); return () => { exitListeners.delete(listener); }; },
    emit(method, params) { for (const listener of [...(listeners.get(method) ?? [])]) listener(params, { method }); },
    die(exit) { for (const listener of [...exitListeners]) listener(exit); },
    exitListenerCount() { return exitListeners.size; },
    async close() {
      if (closed) return;
      closed = true;
      calls.push(['close']);
      // close() fires onExit too, which is why the runner must unsubscribe first.
      connection.die({ reason: 'closed by caller', code: 0, signal: null, stderr: '' });
    },
    async request(method, params) {
      calls.push([method, params]);
      if (script[method]) return script[method](params, connection);
      if (method === 'thread/start') return { thread: { id: 'thread-new' } };
      if (method === 'turn/start') {
        queueMicrotask(() => connection.emit('turn/completed', { turn: { status: 'completed' } }));
        return { turn: { id: 'turn-1' } };
      }
      if (method === 'turn/interrupt') {
        queueMicrotask(() => connection.emit('turn/completed', { turn: { status: 'interrupted' } }));
        return {};
      }
      return {};
    },
  };
  return connection;
}

function runnerWith(script = {}, runnerOptions = {}) {
  let connection;
  const runner = new CodexRunner({
    createConnection(options) { connection = fakeConnection(script, options); return connection; },
    ...runnerOptions,
  });
  return { runner, connection: () => connection };
}

const TURN = { chatId: 'c1', model: 'gpt-6-astra', permissionMode: 'bypassPermissions', cwd: process.cwd(), prompt: 'hello', onUpdate() {} };

test('a new thread is started with full-access sandbox, a never approval policy, the named title and the prompt only as turn input', async () => {
  const updates = [];
  const fixture = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => {
        connection.emit('item/completed', { item: { type: 'agentMessage', id: 'msg-1', text: 'Hi' } });
        connection.emit('turn/completed', { turn: { status: 'completed' } });
      });
      return { turn: { id: 'turn-1' } };
    },
  }, { command: 'fake-codex', clientVersion: '9.9.9', env: { CODEX_HOME: '/scratch' } });
  const result = await fixture.runner.run({ ...TURN, title: 'Named chat', onUpdate: (update) => updates.push(update) });
  const connection = fixture.connection();

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hi');
  assert.equal(result.sessionId, 'thread-new');
  assert.deepEqual(connection.options, { command: 'fake-codex', env: { CODEX_HOME: '/scratch' }, clientVersion: '9.9.9' });
  assert.deepEqual(connection.params('thread/start'), { cwd: process.cwd(), sandbox: 'danger-full-access', approvalPolicy: 'never', model: 'gpt-6-astra' });
  assert.equal(connection.methods().includes('thread/resume'), false);
  assert.deepEqual(connection.params('thread/name/set'), { threadId: 'thread-new', name: 'Named chat' });
  // The prompt travels as structured turn input, never as an argument or a thread field.
  const started = connection.params('turn/start');
  assert.deepEqual(started.input, [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(started.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(started.approvalPolicy, 'never');
  assert.equal(started.model, 'gpt-6-astra');
  assert.doesNotMatch(JSON.stringify(connection.params('thread/start')), /hello/);
  // The thread id is published before a single token is spent, so an unfinished turn is resumable.
  assert.equal(updates[0].sessionId, 'thread-new');
  assert.equal(updates[0].text, '');
  assert.equal(updates.at(-1).final, true);
});

test('an existing thread is resumed with the workspace-write sandbox and never restarted', async () => {
  const fixture = runnerWith();
  const result = await fixture.runner.run({ ...TURN, sessionId: 'existing-thread', title: 'Renamed here', permissionMode: 'default' });
  const connection = fixture.connection();

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'existing-thread');
  assert.deepEqual(connection.params('thread/resume'), { threadId: 'existing-thread', cwd: process.cwd(), sandbox: 'workspace-write', approvalPolicy: 'never', excludeTurns: true });
  assert.equal(connection.methods().includes('thread/start'), false);
  assert.deepEqual(connection.params('thread/name/set'), { threadId: 'existing-thread', name: 'Renamed here' });
  assert.deepEqual(connection.params('turn/start').sandboxPolicy, { type: 'workspaceWrite' });
});

test('an unknown permission mode falls back to the sandboxed policy, never to full access', async () => {
  const fixture = runnerWith();
  await fixture.runner.run({ ...TURN, permissionMode: 'acceptEdits' });
  assert.equal(fixture.connection().params('thread/start').sandbox, 'workspace-write');
});

test('a cosmetic thread rename never fails the turn', async () => {
  const fixture = runnerWith({ 'thread/name/set': () => { throw new Error('rename refused'); } });
  const result = await fixture.runner.run({ ...TURN, title: 'Doomed name' });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
});

test('per-message usage is the turn figure and is assigned, never accumulated across updates', async () => {
  // Measured against a real thread: the thread total tripled across three identical turns
  // while the per-turn figure stayed put. Stamping `total` would make a message look ever
  // more expensive than it was.
  const usageUpdate = (threadInput, threadOutput) => ({
    tokenUsage: {
      total: { inputTokens: threadInput, outputTokens: threadOutput, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      last: { inputTokens: 19_972, outputTokens: 7, cachedInputTokens: 11_136, cacheWriteInputTokens: 0 },
    },
  });
  const finals = [];
  const fixture = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => {
        connection.emit('thread/tokenUsage/updated', usageUpdate(19_972, 7));
        connection.emit('thread/tokenUsage/updated', usageUpdate(39_964, 14));
        connection.emit('thread/tokenUsage/updated', usageUpdate(59_976, 21));
        connection.emit('turn/completed', { turn: { status: 'completed' } });
      });
      return { turn: { id: 'turn-1' } };
    },
  });
  const result = await fixture.runner.run({ ...TURN, onUpdate(update) { if (update.final) finals.push(update); } });
  // inputTokens is reported inclusive of cache, so the uncached remainder is what is stored.
  const expected = { inputTokens: 8_836, outputTokens: 7, cacheReadInputTokens: 11_136, cacheCreationInputTokens: 0, scope: 'mainAgent' };
  assert.deepEqual(result.usage, expected);
  assert.deepEqual(finals.at(-1).usage, expected);
});

test('a turn that reports no usage stamps none rather than a zero', async () => {
  const fixture = runnerWith();
  const result = await fixture.runner.run({ ...TURN });
  assert.equal('usage' in result, false);
});

test('streamed deltas accumulate per item and several agent messages are joined', async () => {
  const texts = [];
  const fixture = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => {
        connection.emit('item/started', { item: { type: 'agentMessage', id: 'msg-1', text: '' } });
        connection.emit('item/agentMessage/delta', { itemId: 'msg-1', itemid: 'msg-1', delta: 'สวัสดี' });
        connection.emit('item/agentMessage/delta', { itemId: 'msg-1', delta: 'ครับ' });
        connection.emit('item/completed', { item: { type: 'agentMessage', id: 'msg-1', text: 'สวัสดีครับ' } });
        connection.emit('item/completed', { item: { type: 'agentMessage', id: 'msg-2', text: 'second' } });
        connection.emit('turn/completed', { turn: { status: 'completed' } });
      });
      return { turn: { id: 'turn-1' } };
    },
  });
  const result = await fixture.runner.run({ ...TURN, onUpdate: (update) => texts.push(update.text) });
  assert.equal(result.text, 'สวัสดีครับ\n\nsecond');
  assert.ok(texts.includes('สวัสดี'));
  assert.ok(texts.includes('สวัสดีครับ'));
  // Only completed items reach the rollout, so only they can be matched by transcript sync.
  assert.deepEqual(result.sourceUuids, ['msg-1', 'msg-2']);
});

test('only completed items become source ids, and the user echo is never one of them', async () => {
  const fixture = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => {
        connection.emit('item/started', { item: { type: 'commandExecution', id: 'cmd-1', command: ['ls'], status: 'inProgress' } });
        connection.emit('item/completed', { item: { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] } });
        connection.emit('item/completed', { item: { type: 'commandExecution', id: 'cmd-1', command: ['ls'], status: 'completed', aggregatedOutput: 'a\nb', exitCode: 0 } });
        connection.emit('turn/completed', { turn: { status: 'completed' } });
      });
      return { turn: { id: 'turn-1' } };
    },
  });
  const result = await fixture.runner.run({ ...TURN });
  assert.deepEqual(result.sourceUuids, ['cmd-1']);
  assert.equal(result.text, '');
  // A live tool object carries no successful result, exactly as the Claude build's did:
  // output is paired in by activity-model once the transcript syncs.
  assert.deepEqual(result.tools[0], { id: 'cmd-1', name: 'Bash', input: { command: 'ls' }, status: 'complete' });
  assert.equal('result' in result.tools[0], false);
});

test('an interrupted turn force-closes a tool card that never received its completion', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const fixture = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => {
        connection.emit('item/started', { item: { type: 'commandExecution', id: 'cmd-1', command: ['sleep', '300'], status: 'inProgress' } });
        release();
      });
      return { turn: { id: 'turn-1' } };
    },
  });
  const done = fixture.runner.run({ ...TURN, chatId: 'orphan' });
  await held;
  assert.equal(await fixture.runner.stop('orphan'), true);
  const result = await done;

  assert.equal(result.interrupted, true);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Interrupted');
  assert.deepEqual(fixture.connection().params('turn/interrupt'), { threadId: 'thread-new', turnId: 'turn-1' });
  // Without this the card spins forever: its item/completed is never coming.
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].status, 'complete');
});

test('a chat interrupted before its turn starts never reaches turn/start', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const fixture = runnerWith({ 'thread/start'() { release(); return { thread: { id: 'thread-new' } }; } });
  const done = fixture.runner.run({ ...TURN, chatId: 'early', title: '', onUpdate() {} });
  await held;
  await fixture.runner.stop('early');
  const result = await done;
  assert.equal(result.interrupted, true);
  assert.equal(result.launchFailed, true);
  assert.equal(fixture.connection().methods().includes('turn/start'), false);
});

test('a thread already open in another Codex session is reported as a writer-lock conflict, not a raw JSON-RPC error', async () => {
  const fixture = runnerWith({
    'thread/resume'() { throw Object.assign(new Error('thread is held by an active writer'), { code: -32600 }); },
  });
  const result = await fixture.runner.run({ ...TURN, sessionId: 'locked-thread' });
  assert.equal(result.ok, false);
  assert.equal(result.launchFailed, true);
  assert.match(result.error, /open in another Codex session/);
  assert.doesNotMatch(result.error, /-32600|active writer/);
  assert.equal(result.sessionId, 'locked-thread');
});

test('a -32600 that is not the writer lock keeps its own message', async () => {
  const fixture = runnerWith({
    'thread/resume'() { throw Object.assign(new Error('Invalid request: threadId is malformed'), { code: -32600 }); },
  });
  const result = await fixture.runner.run({ ...TURN, sessionId: 'bad-thread' });
  assert.match(result.error, /threadId is malformed/);
  assert.doesNotMatch(result.error, /open in another Codex session/);
});

test('an unsupported method reports its own failure and marks the launch failed', async () => {
  const fixture = runnerWith({
    'thread/start'() { throw Object.assign(new Error('thread/start is not supported'), { code: -32601 }); },
  });
  const result = await fixture.runner.run({ ...TURN });
  assert.equal(result.ok, false);
  assert.equal(result.launchFailed, true);
  assert.match(result.error, /not supported/);
  assert.equal(result.sessionId, null);
});

test('an app-server that dies mid-turn settles the turn as a failure instead of hanging', async () => {
  const fixture = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => connection.die({ reason: 'codex app-server exited with code 1', code: 1, signal: null, stderr: 'boom' }));
      return { turn: { id: 'turn-1' } };
    },
  });
  const result = await fixture.runner.run({ ...TURN });
  assert.equal(result.ok, false);
  assert.equal(result.interrupted, false);
  // turnId exists, so this is a failed turn rather than a failed launch.
  assert.equal(result.launchFailed, false);
  assert.match(result.error, /exited with code 1/);
});

test('a failed turn status without an error message still explains itself', async () => {
  const fixture = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => connection.emit('turn/completed', { turn: { status: 'failed' } }));
      return { turn: { id: 'turn-1' } };
    },
  });
  const result = await fixture.runner.run({ ...TURN });
  assert.equal(result.ok, false);
  assert.match(result.error, /Codex turn failed/);
});

test('the terminal listener is detached before the connection is closed, and the connection is always closed', async () => {
  const fixture = runnerWith();
  await fixture.runner.run({ ...TURN });
  const connection = fixture.connection();
  assert.equal(connection.methods().at(-1), 'close');
  // close() fires onExit; had the runner still been listening it would have raced the result.
  assert.equal(connection.exitListenerCount(), 0);

  const failing = runnerWith({ 'thread/start'() { throw new Error('nope'); } });
  await failing.runner.run({ ...TURN });
  assert.equal(failing.connection().methods().includes('close'), true);
});

test('two turns cannot run on one chat, and stopAll drains every live turn', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const fixture = runnerWith({
    'turn/start'() { release(); return { turn: { id: 'turn-1' } }; },
  });
  const first = fixture.runner.run({ ...TURN, chatId: 'busy' });
  await held;
  assert.throws(() => fixture.runner.run({ ...TURN, chatId: 'busy' }), (error) => error.statusCode === 409);
  await fixture.runner.stopAll();
  assert.equal((await first).interrupted, true);
  assert.equal(await fixture.runner.stop('busy'), false);
});

// The permission warning is the composer toolbar's job (src/App.tsx, driven by
// chat.permissionMode). A transcript notice lived for seconds: transcript sync rebuilds
// message content from rollout records and deletes app copy no rollout item explains.
test('Default permissions put no app copy in the transcript, on the first turn or any later one', async () => {
  const fixture = runnerWith();
  const first = await fixture.runner.run({ ...TURN, chatId: 'mcp-chat', permissionMode: 'default' });
  assert.equal(first.text, '');
  // Every message the runner emits must be matchable to a rollout item, or sync deletes it.
  assert.equal('sourceUuids' in first, false);
  assert.equal((await fixture.runner.run({ ...TURN, chatId: 'mcp-chat', permissionMode: 'default' })).text, '');
});

test('neither permission mode reads the MCP configuration', async () => {
  const configured = { 'config/read': () => ({ config: { mcp_servers: { memory: { command: 'x' } } } }) };
  const sandboxed = runnerWith(configured);
  await sandboxed.runner.run({ ...TURN, chatId: 'sandboxed', permissionMode: 'default' });
  assert.equal(sandboxed.connection().methods().includes('config/read'), false);

  const full = runnerWith(configured);
  await full.runner.run({ ...TURN, chatId: 'full-access', permissionMode: 'bypassPermissions' });
  assert.equal(full.connection().methods().includes('config/read'), false);
});

test('a refused MCP call is surfaced on the tool card rather than shown as empty output', async () => {
  // Measured: under workspace-write with approvalPolicy "never" the MCP server is never
  // reached — the call comes back failed, and no prompt is ever shown to undo it.
  const refusal = 'MCP tool call requires approval, but approval policy is never';
  const fixture = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => {
        connection.emit('item/completed', { item: { type: 'mcpToolCall', id: 'mcp-1', status: 'failed', server: 'memory', tool: 'recall', arguments: { q: 'x' }, error: { message: refusal } } });
        connection.emit('turn/completed', { turn: { status: 'completed' } });
      });
      return { turn: { id: 'turn-1' } };
    },
  });
  const sandboxed = await fixture.runner.run({ ...TURN, chatId: 'denied', permissionMode: 'default' });
  assert.equal(sandboxed.tools[0].name, 'memory.recall');
  assert.equal(sandboxed.tools[0].result.isError, true);
  assert.match(sandboxed.tools[0].result.content, /^Denied: MCP tools are unavailable with Default permissions\./);
  assert.match(sandboxed.tools[0].result.content, new RegExp(refusal));

  // Under full access the same failure is a genuine tool error and must not be re-explained.
  const full = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => {
        connection.emit('item/completed', { item: { type: 'mcpToolCall', id: 'mcp-1', status: 'failed', server: 'memory', tool: 'recall', arguments: {}, error: { message: 'upstream timeout' } } });
        connection.emit('turn/completed', { turn: { status: 'completed' } });
      });
      return { turn: { id: 'turn-1' } };
    },
  });
  const result = await full.runner.run({ ...TURN, chatId: 'full-denied', permissionMode: 'bypassPermissions' });
  assert.equal(result.tools[0].result.content, 'upstream timeout');
});

test('an item type this build cannot render is reported by name instead of vanishing', async () => {
  const fixture = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => {
        connection.emit('item/completed', { item: { type: 'holographicProjection', id: 'x-1' } });
        connection.emit('item/completed', { item: { type: 'holographicProjection', id: 'x-2' } });
        connection.emit('item/completed', { item: { type: 'quantumEntanglement', id: 'x-3' } });
        connection.emit('item/completed', { item: { type: 'agentMessage', id: 'msg-1', text: 'shown' } });
        connection.emit('turn/completed', { turn: { status: 'completed' } });
      });
      return { turn: { id: 'turn-1' } };
    },
  });
  const result = await fixture.runner.run({ ...TURN });
  assert.deepEqual(result.unknownItemTypes, ['holographicProjection', 'quantumEntanglement']);
  assert.equal(result.text, 'shown');
  // An unreadable item is not a rollout match candidate.
  assert.deepEqual(result.sourceUuids, ['msg-1']);
});

test('reasoning is discarded rather than reported as unreadable', async () => {
  const fixture = runnerWith({
    'turn/start'(params, connection) {
      queueMicrotask(() => {
        connection.emit('item/completed', { item: { type: 'reasoning', id: 'r-1', text: 'secret chain of thought' } });
        connection.emit('turn/completed', { turn: { status: 'completed' } });
      });
      return { turn: { id: 'turn-1' } };
    },
  });
  const result = await fixture.runner.run({ ...TURN });
  assert.equal(result.text, '');
  assert.equal('unknownItemTypes' in result, false);
  assert.equal('sourceUuids' in result, false);
});

test('health probes once, closes its probe connection, and survives a close failure', async () => {
  let connections = 0;
  const runner = new CodexRunner({
    createConnection() {
      connections += 1;
      return { async health() { return { claudeAvailable: true, claudeVersion: '0.154.0' }; }, async close() { throw new Error('probe close failed'); } };
    },
  });
  assert.deepEqual(await runner.health(), { claudeAvailable: true, claudeVersion: '0.154.0' });
  assert.deepEqual(await runner.health(), { claudeAvailable: true, claudeVersion: '0.154.0' });
  assert.equal(connections, 1);
});
