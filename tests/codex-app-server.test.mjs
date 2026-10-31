import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { CODEX_CLIENT_NAME, CodexAppServer } from '../server/codex-app-server.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let buffer = '';
  child.sent = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) child.sent.push(JSON.parse(line));
      child.emit('sent');
      callback();
    },
  });
  child.stdin.once('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true; };
  child.reply = (id, result) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  child.fail = (id, error) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`);
  child.notify = (method, params) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  child.ask = (id, method) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`);
  child.waitFor = (method) => new Promise((resolve) => {
    const check = () => {
      const message = child.sent.find((entry) => entry.method === method);
      if (message) return resolve(message);
      child.once('sent', check);
    };
    check();
  });
  return child;
}

// Answers the handshake so a test can get straight to the behaviour it cares about.
function serverWith(options = {}) {
  const children = [];
  const server = new CodexAppServer({
    spawnFn(command, args, spawnOptions) {
      const child = fakeChild();
      child.command = command;
      child.args = args;
      child.spawnOptions = spawnOptions;
      children.push(child);
      if (options.handshake !== false) {
        void child.waitFor('initialize').then((message) => child.reply(message.id, { userAgent: 'codex_cli_rs/0.154.0 (macOS)' }));
      }
      return child;
    },
    ...options.server,
  });
  return { server, children, child: () => children.at(-1) };
}

test('the handshake identifies this client, sends initialized, and is the only spawn', async () => {
  const fixture = serverWith();
  const result = await fixture.server.start();
  assert.deepEqual(result, { userAgent: 'codex_cli_rs/0.154.0 (macOS)' });
  const child = fixture.child();
  assert.deepEqual(child.args, ['app-server', '--listen', 'stdio://']);
  assert.equal(child.spawnOptions.shell, false);
  const initialize = child.sent.find((message) => message.method === 'initialize');
  // clientInfo.name lands in the `originator` column and is the only thing separating
  // this backend's threads from every other codex client on the machine.
  assert.equal(initialize.params.clientInfo.name, CODEX_CLIENT_NAME);
  assert.equal(initialize.jsonrpc, '2.0');
  assert.deepEqual(child.sent.at(-1), { jsonrpc: '2.0', method: 'initialized', params: {} });

  await fixture.server.start();
  await fixture.server.start();
  assert.equal(fixture.children.length, 1, 'start() is idempotent');
  await fixture.server.close();
});

test('health reports the CLI version and account under the frozen UI field names', async () => {
  const fixture = serverWith();
  const pending = fixture.server.health();
  const asked = await fixture.child().waitFor('account/read');
  fixture.child().reply(asked.id, { account: { planType: 'pro' } });
  assert.deepEqual(await pending, { claudeAvailable: true, claudeVersion: '0.154.0', authenticated: true, plan: 'pro' });
  await fixture.server.close();
});

test('an unauthenticated or unreachable Codex is reported, never thrown at the health page', async () => {
  const signedOut = serverWith();
  const pending = signedOut.server.health();
  const asked = await signedOut.child().waitFor('account/read');
  signedOut.child().fail(asked.id, { code: -32000, message: 'not logged in' });
  const result = await pending;
  assert.equal(result.claudeAvailable, true, 'the binary answered, so it is installed');
  assert.equal(result.authenticated, false);
  assert.equal(result.error, 'not logged in');
  await signedOut.server.close();

  const missing = new CodexAppServer({ spawnFn() { throw new Error('spawn codex ENOENT'); } });
  assert.deepEqual(await missing.health(), { claudeAvailable: false, claudeVersion: null, authenticated: false, error: 'spawn codex ENOENT' });
});

test('notifications reach every subscriber and unsubscribing is exact', async () => {
  const fixture = serverWith();
  await fixture.server.start();
  const seen = [];
  const unsubscribe = fixture.server.on(['item/completed', 'turn/completed'], (params, message) => seen.push([message.method, params]));
  const other = [];
  fixture.server.on('item/completed', (params) => other.push(params));

  fixture.child().notify('item/completed', { item: { id: 'a' } });
  fixture.child().notify('turn/completed', { turn: { status: 'completed' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen.map(([method]) => method), ['item/completed', 'turn/completed']);
  assert.equal(other.length, 1);

  unsubscribe();
  unsubscribe();
  fixture.child().notify('item/completed', { item: { id: 'b' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 2);
  assert.equal(other.length, 2, 'the other subscriber is untouched');
  await fixture.server.close();
});

// approvalPolicy is always "never", so nothing the server asks is answerable. Replying
// anyway keeps a turn from stalling on a prompt this UI never shows.
test('an inbound request from the app-server is refused with -32601 instead of being ignored', async () => {
  const fixture = serverWith();
  await fixture.server.start();
  fixture.child().ask(77, 'execCommandApproval');
  await new Promise((resolve) => setImmediate(resolve));
  const reply = fixture.child().sent.find((message) => message.id === 77);
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 77, error: { code: -32601, message: 'execCommandApproval is not supported' } });
  await fixture.server.close();
});

test('a JSON-RPC error becomes a rejection carrying its code, and malformed output is skipped', async () => {
  const fixture = serverWith();
  await fixture.server.start();
  const locked = fixture.server.request('thread/resume', { threadId: 't' });
  const asked = await fixture.child().waitFor('thread/resume');
  // Noise on the pipe must not desynchronize the stream or settle the wrong request.
  fixture.child().stdout.write('not json\n\n');
  fixture.child().fail(asked.id, { code: -32600, message: 'thread is held by an active writer', data: { pid: 42 } });
  await assert.rejects(locked, (error) => {
    assert.equal(error.code, -32600);
    assert.match(error.message, /active writer/);
    assert.deepEqual(error.data, { pid: 42 });
    return true;
  });
  // A reply to an id nobody is waiting on is ignored rather than throwing.
  fixture.child().reply(9999, {});
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.server.close();
});

// Wiring note 5: turn/completed is the only terminal notification, so a caller waiting on
// one must hear about a child that dies first — without reaching for the child handle.
test('onExit reports one exit object, rejects everything pending, and unsubscribes idempotently', async () => {
  const fixture = serverWith();
  await fixture.server.start();
  const exits = [];
  const unsubscribe = fixture.server.onExit((exit) => exits.push(exit));
  const ignored = [];
  const stop = fixture.server.onExit((exit) => ignored.push(exit));
  stop();
  stop();

  const pending = fixture.server.request('turn/start', {});
  await fixture.child().waitFor('turn/start');
  fixture.child().stderr.write('panicked at src/main.rs');
  await new Promise((resolve) => setImmediate(resolve));
  fixture.child().emit('close', 1, null);

  await assert.rejects(pending, (error) => error.code === -32000);
  assert.equal(exits.length, 1);
  assert.equal(ignored.length, 0);
  assert.equal(typeof exits[0].reason, 'string');
  assert.equal(exits[0].code, 1);
  assert.equal(exits[0].signal, null);
  assert.equal(exits[0].stderr, 'panicked at src/main.rs');
  unsubscribe();
  await fixture.server.close();
});

test('close fires onExit too, which is why a turn must unsubscribe before awaiting it', async () => {
  const fixture = serverWith();
  await fixture.server.start();
  const exits = [];
  fixture.server.onExit((exit) => exits.push(exit));
  await fixture.server.close();
  assert.equal(exits.length, 1);
  // A deliberate close must never respawn.
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(fixture.children.length, 1);
  await assert.rejects(fixture.server.start(), (error) => error.statusCode === 503);
});

test('closing when nothing was ever spawned resolves rather than waiting on a child', async () => {
  const fixture = serverWith();
  await fixture.server.close();
  assert.equal(fixture.children.length, 0);
});

// Respawn is real, so a long-lived subscriber hears more than one death. The runner's
// per-turn subscribe/unsubscribe is what makes that a non-issue.
test('an unexpected death respawns after a backoff and a later subscriber sees the new child', async (t) => {
  const fixture = serverWith();
  t.after(() => fixture.server.close());
  await fixture.server.start();
  const exits = [];
  fixture.server.onExit((exit) => exits.push(exit));
  fixture.child().emit('close', 1, null);
  assert.equal(exits.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fixture.children.length, 2, 'the first backoff step is 250ms');
  const second = fixture.child();
  assert.ok(second.sent.some((message) => message.method === 'initialize'), 'the successor completes its own handshake');
  second.emit('close', 1, null);
  assert.equal(exits.length, 2, 'one subscriber, two deaths');
});

test('a child that dies before it is ever ready is not respawned into a loop', async () => {
  const fixture = serverWith({ handshake: false });
  const start = fixture.server.start();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.child().emit('close', 1, null);
  await assert.rejects(start, (error) => error.code === -32000);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fixture.children.length, 1);
  await fixture.server.close();
});

// Dropping the head of an unterminated line desynchronizes the stream for good, and a turn
// then waits on notifications that can no longer arrive.
test('an oversized unterminated stream line kills the child instead of stalling a turn', async () => {
  const fixture = serverWith();
  await fixture.server.start();
  const exits = [];
  fixture.server.onExit((exit) => exits.push(exit));
  fixture.child().stdout.write('x'.repeat(9 * 1024 * 1024));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.child().signals, ['SIGKILL']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exits.length, 1);
  assert.match(exits[0].stderr, /oversized unterminated stream line/);
  await fixture.server.close();
});
