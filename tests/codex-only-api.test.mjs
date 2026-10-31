import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../server/app.mjs';

// The Claude build's counterpart of this file was written during the GLM removal to police
// provider drift. The gate has since inverted: provider is now the whole test, Codex is the
// only writable provider, and a model id can no longer decide anything — it is served by the
// machine's own app-server and OpenAI retires ids over time.
const MODELS = [{ id: 'gpt-6-astra', isDefault: true }, { id: 'gpt-5.6-sol' }, { id: 'gpt-5.5-internal', hidden: true }];
const OFFERED = ['gpt-6-astra', 'gpt-5.6-sol'];

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cc-codex-only-'));
  const calls = [];
  const runner = {
    async health() { return { claudeAvailable: true, claudeVersion: 'test' }; },
    run(input) { calls.push(input); return Promise.resolve({ ok: true, text: 'OK', tools: [] }); },
    async stop(id) { calls.push({ stop: id }); return false; },
    async stopAll() {},
  };
  const source = {
    PATH: process.env.PATH, CODEX_HOME: path.join(dataDir, 'codex-home'),
    OPENAI_API_KEY: 'dummy-official',
    ANTHROPIC_API_KEY: 'dummy-removed-claude', ZAI_API_KEY: 'dummy-removed-zai',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'dummy-spoof', CC_CHAT_CHAT_MODELS: 'glm-5.2',
  };
  const server = await createServer({
    dataDir, runner, environment: source,
    listModels: async () => ({ data: MODELS }),
    ...overrides,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await server.app.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    server, calls,
    async request(route, input, method = input === undefined ? 'GET' : 'POST') {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
        method, headers: { 'content-type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

function savedChat(overrides = {}) {
  return { id: 'legacy', title: 'Keep history', projectId: null, sessionId: null, model: 'sonnet', permissionMode: 'default', createdAt: '1', updatedAt: '1', status: 'idle', messages: [{ id: 'm', role: 'user', content: 'keep me' }], ...overrides };
}

test('health and creation expose only Codex, and the model list comes from the backend', async t => {
  const f = await fixture(t);
  const health = await f.request('/health');
  assert.deepEqual(health.body.chatModels, OFFERED);
  assert.equal(health.body.providers, undefined);
  // No credential and no removed-provider model id anywhere in the payload. The frozen UI's
  // naming tiers (haiku/sonnet/opus) are deliberately still on the wire and are checked
  // separately — they are tier tokens, not Claude models.
  assert.doesNotMatch(JSON.stringify(health.body), /dummy-|glm|zai|anthropic/i);
  assert.doesNotMatch(JSON.stringify(health.body.chatModels), /sonnet|opus|haiku/i);
  assert.deepEqual(health.body.sessionNaming, { summaryModels: ['haiku', 'sonnet'], namingModel: 'opus' });

  for (const model of OFFERED) {
    const created = await f.request('/chats', { model });
    assert.equal(created.status, 201);
    assert.equal(created.body.model, model);
    // Every new record is stamped, so the gate has something to read for the rest of time.
    assert.equal(created.body.provider, 'codex');
    // Decision 6: a new chat inherits full access, matching every chat this app ever started.
    assert.equal(created.body.permissionMode, 'bypassPermissions');
  }
  const noChoice = await f.request('/chats', {});
  assert.equal(noChoice.body.model, 'gpt-6-astra', 'a client with no saved choice adopts the backend default');

  const before = f.server.app.store.snapshot();
  for (const input of [
    { model: 'sonnet' }, { model: 'opus' }, { model: 'glm-5.2' },
    { model: 'gpt-5.5-internal' }, { model: 'gpt-9-never-existed' },
    { provider: 'claude' }, { provider: 'zai' }, { provider: 'unknown' }, { provider: '' },
  ]) {
    assert.equal((await f.request('/chats', input)).status, 400, JSON.stringify(input));
  }
  assert.deepEqual(f.server.app.store.snapshot(), before);
  assert.equal(f.calls.length, 0);
});

test('all legacy non-Codex histories stay readable and cannot send, convert or be deleted', async t => {
  const f = await fixture(t);
  for (const chat of [
    savedChat(),
    savedChat({ id: 'explicit-claude', provider: 'claude', model: 'opus' }),
    savedChat({ id: 'explicit-zai', provider: 'zai', model: 'glm-5.2' }),
    savedChat({ id: 'unknown-provider', provider: 'something-else', model: 'other-model' }),
  ]) {
    await f.server.app.store.update(state => { state.chats.push(chat); });
    const before = f.server.app.store.snapshot();
    assert.equal((await f.request(`/chats/${chat.id}/messages`, { content: 'must not launch' })).status, 409);
    assert.equal((await f.request(`/chats/${chat.id}`, { model: 'gpt-6-astra' }, 'PATCH')).status, 409);
    assert.equal((await f.request(`/chats/${chat.id}`, { title: 'new' }, 'PATCH')).status, 409);
    // Converting a legacy record to Codex by patching the provider is not a supported field.
    assert.equal((await f.request(`/chats/${chat.id}`, { provider: 'codex' }, 'PATCH')).status, 400);
    assert.equal((await f.request(`/chats/${chat.id}/sync`, {})).status, 409);
    assert.equal((await f.request(`/chats/${chat.id}/stop`, {})).status, 409);
    assert.equal((await f.request(`/chats/${chat.id}`, undefined, 'DELETE')).status, 409);
    assert.deepEqual(f.server.app.store.snapshot(), before);
    // Nothing was migrated and nothing was lost: the stored record is byte-identical.
    assert.deepEqual((await f.request('/state')).body.chats.find(item => item.id === chat.id), chat);
  }
  assert.equal(f.calls.length, 0);
});

// The keystone of the inverted gate. Under the old model-membership rule a model id the
// backend stopped offering would silently turn a healthy conversation read-only.
test('a Codex chat whose stored model the backend no longer offers stays fully writable', async t => {
  const f = await fixture(t);
  const retired = savedChat({ id: 'retired-model', provider: 'codex', model: 'gpt-5.3-codex-spark' });
  await f.server.app.store.update(state => { state.chats.push(retired); });

  assert.equal((await f.request('/chats/retired-model/messages', { content: 'still mine' })).status, 202);
  assert.equal((await f.request('/chats/retired-model', { title: 'Renamed' }, 'PATCH')).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  // The retired id is carried to the runner untouched — never silently swapped for a live one.
  assert.equal(f.calls[0].model, 'gpt-5.3-codex-spark');
  // Choosing a model is still bounded by what the backend offers today.
  assert.equal((await f.request('/chats/retired-model', { model: 'gpt-9-never-existed' }, 'PATCH')).status, 400);
});

test('Codex chats launch with only official Codex credentials and no removed-provider leakage', async t => {
  const f = await fixture(t);
  for (const chat of [savedChat({ id: 'codex-one', provider: 'codex', model: 'gpt-6-astra' }), savedChat({ id: 'codex-two', provider: 'codex', model: 'gpt-5.6-sol' })]) {
    await f.server.app.store.update(state => { state.chats.push(chat); });
    assert.equal((await f.request(`/chats/${chat.id}/messages`, { content: 'hello' })).status, 202);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.env.OPENAI_BASE_URL, 'https://api.openai.com/v1');
    assert.equal(call.env.OPENAI_API_KEY, 'dummy-official');
    // A new chat defaults to full access, so anything left here is readable by the model.
    assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.env.ZAI_API_KEY, undefined);
    assert.equal(call.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
  }
});

test('native imports reject removed providers and retired models before reading any history', async t => {
  let reads = 0;
  const f = await fixture(t, { nativeSessions: {
    async list() { return []; },
    async resumable(sessionId) { reads++; return { sessionId, cwd: process.cwd(), name: 'Native', startedAt: 1 }; },
    async messages() { reads++; return { messages: [], nextOffset: null }; },
  } });
  for (const input of [{ provider: 'claude' }, { provider: 'zai' }, { model: 'sonnet' }, { model: 'gpt-5.5-internal' }]) {
    assert.equal((await f.request('/native-sessions/native/import', input)).status, 400, JSON.stringify(input));
  }
  assert.equal(reads, 0);
  // A thread already bound to a legacy record cannot be re-imported into a live one.
  await f.server.app.store.update(state => { state.chats.push(savedChat({ sessionId: 'native' })); });
  assert.equal((await f.request('/native-sessions/native/import', {})).status, 409);
  assert.equal(reads, 0);

  const imported = await f.request('/native-sessions/codex-native/import', {});
  assert.equal(imported.status, 201);
  assert.equal(imported.body.model, 'gpt-6-astra');
  assert.equal(imported.body.provider, 'codex');
  assert.equal(imported.body.permissionMode, 'bypassPermissions');
});

test('removed-provider histories cannot invoke naming or native rename', async t => {
  let calls = 0;
  const f = await fixture(t, {
    sessionNameGenerator: async () => { calls++; return { summary: 'x', suggestions: ['a', 'b', 'c'] }; },
    nativeSessions: { async list() { return []; }, async rename() { calls++; } },
  });
  await f.server.app.store.update(state => { state.chats.push(savedChat({ sessionId: 'old-session' })); });
  const before = f.server.app.store.snapshot();
  assert.equal((await f.request('/session-names/suggest', { target: { kind: 'chat', id: 'legacy' }, summaryModel: 'haiku' })).status, 409);
  assert.equal((await f.request('/chats/legacy', { title: 'new' }, 'PATCH')).status, 409);
  assert.equal(calls, 0);
  assert.deepEqual(f.server.app.store.snapshot(), before);
});

test('native duplicate views cannot bypass the read-only guard or lose their identity', async t => {
  let reads = 0;
  const f = await fixture(t, { nativeSessions: {
    async list() { return [{ id: 'native-old', sessionId: 'native-old', name: 'Old', action: 'resume', terminalCommand: "codex resume 'native-old'", existingTerminal: { attachCommand: 'maw a old' } }]; },
    async historySnapshot() { reads++; return { messages: [], changeToken: 'next' }; },
    async messages() { reads++; return { messages: [], nextOffset: null }; },
    async rename() { reads++; },
    async resumable() { reads++; },
    async existingTerminal() { reads++; return { attachCommand: 'maw a old' }; },
  }, syncIntervalMs: 0 });
  await f.server.app.store.update(state => { state.chats.push(savedChat({ sessionId: 'native-old' })); });
  const before = f.server.app.store.snapshot();
  const listed = (await f.request('/native-sessions')).body.sessions[0];
  assert.equal(listed.action, 'unavailable');
  assert.equal(listed.terminalCommand, null);
  assert.equal(listed.existingTerminal, undefined);
  assert.match(listed.readOnlyReason, /removed provider/i);
  for (const [route, input, method] of [
    ['/native-sessions/native-old/messages', undefined, 'GET'],
    ['/native-sessions/native-old', { title: 'x' }, 'PATCH'],
    ['/session-names/suggest', { target: { kind: 'native', id: 'native-old' }, summaryModel: 'haiku' }, 'POST'],
    ['/session-names/alias', { target: { kind: 'native', id: 'native-old' }, title: 'x', expectedTitle: 'Old' }, 'POST'],
    ['/session-names/alias', { target: { kind: 'chat', id: 'legacy' }, title: 'x', expectedTitle: 'Keep history' }, 'POST'],
    ['/chats/legacy/sync', {}, 'POST'],
    ['/chats/legacy/stop', {}, 'POST'],
    ['/chats/legacy', undefined, 'DELETE'],
  ]) assert.equal((await f.request(route, input, method)).status, 409, route);
  await f.server.app.transcriptSync.tick();
  assert.equal(await f.server.app.transcriptSync.syncChat('legacy', { force: true }), false);
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.server.app.store.snapshot(), before);
});

test('an unreachable Codex reports the outage without turning healthy chats read-only', async t => {
  const f = await fixture(t, { listModels: async () => { throw Object.assign(new Error('codex is not installed'), { statusCode: 503 }); } });
  const health = await f.request('/health');
  assert.equal(health.status, 200);
  // claudeAvailable already reports the outage; an empty list is that same outage, not a 500.
  assert.deepEqual(health.body.chatModels, []);

  const live = savedChat({ id: 'live-chat', provider: 'codex', model: 'gpt-6-astra' });
  await f.server.app.store.update(state => { state.chats.push(live); });
  assert.equal((await f.request('/chats/live-chat/messages', { content: 'still writable' })).status, 202);
  // Creating a chat still needs a real list, so it fails loudly rather than inventing one.
  assert.equal((await f.request('/chats', {})).status, 503);
});

// The Timeline is mounted in-process, inside the request try/catch and after the CORS and
// closing checks, so its status codes and headers ride the same response the rest of the
// API uses. There is no second listener to authenticate separately.
test('the Timeline is a route on this backend, behind the same origin boundary', async t => {
  const f = await fixture(t);
  const port = f.server.address().port;

  // No thread index in the scratch home, so the service answers its own 503 — proving the
  // apiError status code survives the mount rather than becoming a 500.
  const local = await f.request('/timeline?limit=20');
  assert.equal(local.status, 503);
  assert.match(local.body.error, /Codex thread index is unavailable/);

  const untrusted = await fetch(`http://127.0.0.1:${port}/api/timeline/view`, { headers: { origin: 'https://untrusted.example' } });
  assert.equal(untrusted.status, 403);
  assert.deepEqual(await untrusted.json(), { error: 'Forbidden origin' });

  const view = await fetch(`http://127.0.0.1:${port}/api/timeline/view`);
  assert.equal(view.status, 200);
  assert.match(view.headers.get('content-type'), /text\/html/);
  assert.match(await view.text(), /<!doctype html>/i);

  assert.equal((await f.request('/timeline?limit=7')).status, 400);
});
