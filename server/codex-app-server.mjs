import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';

const MAX_PENDING_LINE_BYTES = 8 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const RESPAWN_DELAYS_MS = [250, 1000, 3000, 10_000];

// clientInfo.name lands in the `originator` column of state_5.sqlite; it is the only
// discriminator that separates our threads from every other codex client on the machine.
export const CODEX_CLIENT_NAME = 'codex-chat-ui';

function versionFromUserAgent(userAgent) {
  return String(userAgent || '').match(/\/(\d[^\s]*)/)?.[1] || null;
}

export class CodexAppServer {
  constructor({ spawnFn = spawn, command = process.env.CODEX_BIN || 'codex', env, clientVersion = process.env.npm_package_version || '0.0.0' } = {}) {
    this.spawnFn = spawnFn;
    this.command = command;
    this.env = env;
    this.clientVersion = clientVersion;
    this.child = null;
    this.startPromise = null;
    this.initializeResult = null;
    this.pending = new Map();
    this.subscribers = new Map();
    this.exitListeners = new Set();
    this.nextId = 0;
    this.ready = false;
    this.respawns = 0;
    this.retryAt = 0;
    this.respawnTimer = null;
    this.closed = false;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.stderr = '';
  }

  async start() {
    if (this.closed) throw Object.assign(new Error('Codex app-server is closed'), { statusCode: 503 });
    if (!this.startPromise) this.startPromise = this.#launch();
    return this.startPromise;
  }

  async request(method, params) {
    await this.start();
    return this.#request(method, params);
  }

  async notify(method, params) {
    await this.start();
    this.#send({ jsonrpc: '2.0', method, params });
  }

  on(method, listener) {
    const methods = Array.isArray(method) ? method : [method];
    for (const name of methods) {
      if (!this.subscribers.has(name)) this.subscribers.set(name, new Set());
      this.subscribers.get(name).add(listener);
    }
    return () => {
      for (const name of methods) {
        const listeners = this.subscribers.get(name);
        if (listeners?.delete(listener) && listeners.size === 0) this.subscribers.delete(name);
      }
    };
  }

  // turn/completed is the only terminal notification, so a caller waiting on one needs to
  // hear about a child that dies first — without reaching for the child handle itself.
  onExit(listener) {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  // claudeAvailable/claudeVersion are the frozen UI's field names for "a CLI is installed and
  // answering", not a claim about whose CLI it is.
  async health() {
    let initialized;
    try {
      initialized = await this.start();
    } catch (error) {
      return { claudeAvailable: false, claudeVersion: null, authenticated: false, error: error.message };
    }
    const claudeVersion = versionFromUserAgent(initialized?.userAgent);
    try {
      const { account, requiresOpenaiAuth } = await this.request('account/read', {});
      return { claudeAvailable: true, claudeVersion, authenticated: Boolean(account) || requiresOpenaiAuth === false, plan: account?.planType ?? null };
    } catch (error) {
      return { claudeAvailable: true, claudeVersion, authenticated: false, error: error.message };
    }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.respawnTimer);
    const child = this.child;
    if (!child) return;
    const exited = new Promise((resolve) => child.once('close', resolve));
    child.stdin.end();
    const terminate = setTimeout(() => child.kill('SIGTERM'), 1000);
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    terminate.unref?.();
    force.unref?.();
    await exited;
    clearTimeout(terminate);
    clearTimeout(force);
  }

  async #launch() {
    const wait = this.retryAt - Date.now();
    if (wait > 0) await sleep(wait);
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.stderr = '';
    const child = this.spawnFn(this.command, ['app-server', '--listen', 'stdio://'], {
      ...(this.env ? { env: this.env } : {}),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (chunk) => this.#push(chunk));
    child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-16_384); });
    child.stdin.on('error', (error) => { this.stderr = `${this.stderr}\n${error.message}`.trim().slice(-16_384); });
    child.once('error', (error) => this.#gone(child, error.message));
    child.once('close', (code, signal) => this.#gone(child, this.stderr.trim() || `codex app-server exited with code ${code}${signal ? ` (${signal})` : ''}`, code, signal));
    // A child that takes stdin but never answers initialize would leave every later
    // request waiting on start(); kill it so the pending handshake rejects instead.
    const wedged = setTimeout(() => child.kill('SIGKILL'), HANDSHAKE_TIMEOUT_MS);
    wedged.unref?.();
    try {
      const result = await this.#request('initialize', { clientInfo: { name: CODEX_CLIENT_NAME, title: 'Codex Chat UI', version: this.clientVersion } });
      this.#send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      this.initializeResult = result;
      this.ready = true;
      this.readyAt = Date.now();
      return result;
    } finally {
      clearTimeout(wedged);
    }
  }

  #request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  #send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #push(chunk) {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.#line(line);
    if (Buffer.byteLength(this.buffer) > MAX_PENDING_LINE_BYTES) {
      this.buffer = '';
      // Dropping the head of an unterminated line desynchronizes the stream for good, and a
      // turn waits on notifications that can no longer arrive: kill the child so the caller
      // hears a failure instead of stalling forever.
      this.stderr = `${this.stderr}\n[oversized unterminated stream line]`.trim().slice(-16_384);
      this.child?.kill('SIGKILL');
    }
  }

  #line(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method) {
      // approvalPolicy is always "never", so nothing here is answerable; replying anyway
      // keeps a turn from stalling on a prompt this UI never shows.
      this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${message.method} is not supported` } });
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message || 'Codex app-server error'), { code: message.error.code, data: message.error.data }));
      else entry.resolve(message.result);
      return;
    }
    const listeners = this.subscribers.get(message.method);
    if (listeners) for (const listener of [...listeners]) listener(message.params, message);
  }

  #gone(child, reason, code = null, signal = null) {
    if (this.child !== child) return;
    this.child = null;
    this.startPromise = null;
    const wasReady = this.ready;
    this.ready = false;
    const error = Object.assign(new Error(reason), { code: -32000 });
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    const exit = { reason, code, signal, stderr: this.stderr.trim() };
    for (const listener of [...this.exitListeners]) listener(exit);
    if (this.closed || !wasReady) return;
    // A child that outlived the longest backoff was healthy, so its successor starts fresh.
    if (Date.now() - this.readyAt > RESPAWN_DELAYS_MS.at(-1)) this.respawns = 0;
    const delay = RESPAWN_DELAYS_MS[Math.min(this.respawns, RESPAWN_DELAYS_MS.length - 1)];
    this.respawns += 1;
    this.retryAt = Date.now() + delay;
    this.respawnTimer = setTimeout(() => { this.start().catch(() => {}); }, delay);
    this.respawnTimer.unref?.();
  }
}
