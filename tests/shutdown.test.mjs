import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/app.mjs';

class ActiveRunner {
  constructor() {
    this.calls = [];
    this.pending = new Map();
  }

  health() {
    return Promise.resolve({ claudeAvailable: true, claudeVersion: 'test' });
  }

  run(options) {
    this.calls.push(options);
    return new Promise((resolve) => {
      this.pending.set(options.chatId, resolve);
      options.onUpdate({ text: 'partial response', tools: [] });
    });
  }

  stop() {
    return Promise.resolve(false);
  }

  async stopAll() {
    for (const resolve of this.pending.values()) {
      resolve({ ok: false, interrupted: true, text: 'partial response', tools: [] });
    }
    this.pending.clear();
  }
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cc-chat-shutdown-'));
  const server = await createServer({ dataDir, cwd: process.cwd(), listModels: async () => ({ data: [{ id: 'gpt-6-astra', isDefault: true }, { id: 'gpt-5.6-sol' }] }), environment: { PATH: process.env.PATH, CODEX_HOME: path.join(dataDir, 'codex-home') }, ...overrides });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  t.after(async () => {
    if (!closed) await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    origin,
    server,
    async closeHttp() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  return { response, value: await response.json() };
}

test('app close waits until an active run is interrupted and its final state is persisted', async (t) => {
  const runner = new ActiveRunner();
  const f = await fixture(t, { runner });
  const created = await jsonRequest(`${f.origin}/api/chats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const sent = await jsonRequest(`${f.origin}/api/chats/${created.value.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'keep the partial response' }),
  });
  assert.equal(sent.response.status, 202);
  assert.equal(runner.calls.length, 1);

  await f.server.app.close();

  const memory = f.server.app.store.snapshot().chats[0];
  assert.equal(memory.status, 'idle');
  assert.equal(memory.messages.at(-1).status, 'interrupted');
  assert.equal(memory.messages.at(-1).content, 'partial response');
  const disk = JSON.parse(await readFile(path.join(f.dataDir, 'state.json'), 'utf8')).chats[0];
  assert.equal(disk.status, 'idle');
  assert.equal(disk.messages.at(-1).status, 'interrupted');
  assert.equal(disk.messages.at(-1).content, 'partial response');

  await f.closeHttp();
});

test('app close prevents a runner launch after a delayed native ownership check', async (t) => {
  let resumableCalls = 0;
  let releaseRecheck;
  let signalRecheckStarted;
  const recheckStarted = new Promise((resolve) => { signalRecheckStarted = resolve; });
  const delayedRecheck = new Promise((resolve) => { releaseRecheck = resolve; });
  const native = {
    id: 'saved',
    cwd: process.cwd(),
    kind: 'saved',
    name: 'Saved',
    sessionId: 'shutdown-race-session',
    startedAt: 1,
    action: 'resume',
  };
  const nativeSessions = {
    async list() { return [native]; },
    async messages() { return { messages: [], nextOffset: null }; },
    async rename() { return native; },
    async resumable() {
      resumableCalls += 1;
      if (resumableCalls === 3) {
        signalRecheckStarted();
        await delayedRecheck;
      }
      return native;
    },
  };
  const runner = new ActiveRunner();
  const f = await fixture(t, { nativeSessions, runner });
  const imported = await jsonRequest(`${f.origin}/api/native-sessions/${native.sessionId}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const sent = await jsonRequest(`${f.origin}/api/chats/${imported.value.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'do not launch after shutdown starts' }),
  });
  assert.equal(sent.response.status, 202);
  await recheckStarted;

  const closing = f.server.app.close();
  releaseRecheck(native);
  await closing;

  assert.equal(runner.calls.length, 0);
  const chat = f.server.app.store.snapshot().chats[0];
  assert.equal(chat.status, 'idle');
  assert.equal(chat.messages.at(-1).status, 'interrupted');

  await f.closeHttp();
});

test('shutdown starts sync close and runner stop together and waits for both', async (t) => {
  const runner = new ActiveRunner();
  const f = await fixture(t, { runner });
  const originalClose = f.server.app.transcriptSync.close.bind(f.server.app.transcriptSync);
  await originalClose();
  let releaseSync;
  let releaseRunner;
  const syncClosed = new Promise((resolve) => { releaseSync = resolve; });
  const runnerStopped = new Promise((resolve) => { releaseRunner = resolve; });
  const calls = [];
  f.server.app.transcriptSync.close = () => { calls.push('sync'); return syncClosed; };
  runner.stopAll = () => { calls.push('runner'); return runnerStopped; };
  let settled = false;
  const closing = f.server.app.close().then(() => { settled = true; });
  try {
    assert.deepEqual(calls, ['sync', 'runner']);
    releaseSync();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    releaseSync();
    releaseRunner();
    await closing;
  }
  assert.equal(settled, true);
  await f.closeHttp();
});

const ENTRYPOINT = fileURLToPath(new URL('../server/index.mjs', import.meta.url));

// Stand-in app-server: answers the startup handshake and exits when its stdin closes, so the
// timing measured below is the HTTP server's shutdown, not a real CLI child being reaped.
const FAKE_APP_SERVER = `#!/usr/bin/env node
const readline = require('node:readline');
const RESULTS = {
  initialize: { userAgent: 'codex_cli_rs/9.9.9 (fake app-server)' },
  'account/read': { account: { planType: 'test-plan' } },
  'model/list': { data: [{ id: 'gpt-6-astra', isDefault: true }] },
};
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const result = RESULTS[message.method];
  const reply = result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: message.method + ' is not supported' } };
  console.log(JSON.stringify(reply));
});
input.once('close', () => process.exit(0));
`;

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function backendProcess(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-chat-shutdown-signal-'));
  const cwd = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  const fakeCodex = path.join(root, 'codex');
  await Promise.all([mkdir(cwd), mkdir(home), mkdir(codexHome)]);
  await writeFile(fakeCodex, FAKE_APP_SERVER);
  await chmod(fakeCodex, 0o755);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [ENTRYPOINT], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOME: home,
      CODEX_BIN: fakeCodex,
      CODEX_HOME: codexHome,
      CC_CHAT_DATA_DIR: path.join(root, 'data'),
      CC_CHAT_CWD: cwd,
      CC_CHAT_DESKTOP: '',
      DEV_ORIGIN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Backend exited before listening (${child.exitCode})`);
    try { if ((await fetch(`${origin}/api/state`)).status === 200) break; } catch { /* not accepting connections yet */ }
    if (Date.now() > deadline) throw new Error('Timed out waiting for the backend to listen');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { child, origin, port };
}

function openEvents(origin) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${origin}/api/events`, { agent: new http.Agent({ keepAlive: true }) }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (chunk.includes('event: state')) resolve({ request, response }); });
    });
    request.once('error', reject);
  });
}

// A request the server can never finish: headers without their terminating blank line. An open
// tab produces the same shape whenever a fetch is in flight, and such a socket is never "idle",
// so server.close() alone waits on it forever.
async function openUnfinishedRequest(port) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.on('data', () => {});
  socket.on('error', () => {});
  socket.write(`GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return socket;
}

test('SIGTERM exits the backend while an open browser tab still holds its sockets', async (t) => {
  const backend = await backendProcess(t);
  const events = await openEvents(backend.origin);
  const unfinished = await openUnfinishedRequest(backend.port);
  t.after(() => { events.request.destroy(); unfinished.destroy(); });

  const started = Date.now();
  backend.child.kill('SIGTERM');
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend still running 10s after SIGTERM')), 10_000);
    backend.child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  const elapsed = Date.now() - started;

  assert.deepEqual(exit, { code: 0, signal: null });
  // Under the 5s forced-exit backstop: the sockets must actually be dropped, not waited out.
  assert.ok(elapsed < 4_000, `Backend took ${elapsed}ms to exit after SIGTERM`);
});
