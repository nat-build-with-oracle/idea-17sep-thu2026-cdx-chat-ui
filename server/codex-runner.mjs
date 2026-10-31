import { CodexAppServer } from './codex-app-server.mjs';
import { normalizeItem, normalizeThreadUsage } from './codex-items.mjs';

const SANDBOX = {
  bypassPermissions: { mode: 'danger-full-access', policy: { type: 'dangerFullAccess' } },
  default: { mode: 'workspace-write', policy: { type: 'workspaceWrite' } },
};
const STREAM_METHODS = ['item/started', 'item/completed', 'item/agentMessage/delta', 'thread/tokenUsage/updated', 'turn/completed'];
const WRITER_LOCKED = 'This conversation is open in another Codex session. Close it there, then send again.';
// Measured, not assumed: under workspace-write with approvalPolicy "never" every MCP call
// comes back as an mcpToolCall item with status "failed" and error.message "MCP tool call
// requires approval, but approval policy is never" — the server process is never reached.
// Approvals are never shown here, so that refusal is permanent for the mode, not a prompt.
// The standing warning for the mode lives in the composer toolbar, not in the transcript:
// transcript sync rebuilds message content from rollout records, so app copy no rollout
// item can account for is deleted on the next tick.
const MCP_DENIED = 'Denied: MCP tools are unavailable with Default permissions. Switch this conversation to Full access to allow them.';

const writerLocked = (error) => error.code === -32600 && /active writer/.test(error.message);
// The runner only ever sees live app-server items, which spell the type in camelCase.
const mcpCall = (item) => item?.type === 'mcpToolCall';

class TurnStream {
  constructor(onUpdate, sandboxed) {
    this.onUpdate = onUpdate;
    this.sandboxed = sandboxed;
    this.sessionId = null;
    this.messages = new Map();
    this.tools = new Map();
    this.sourceIds = new Set();
    this.unknownTypes = new Set();
    this.usage = null;
  }

  get text() {
    return [...this.messages.values()].filter(Boolean).join('\n\n');
  }

  item(item, completed) {
    const entry = normalizeItem(item);
    if (!entry || entry.kind === 'user') return;
    // Nothing renders an item type this build has never seen, but the turn should
    // still be able to say how much of itself it could not show.
    if (entry.kind === 'unknown') { this.unknownTypes.add(entry.type); return; }
    // Only a completed item reaches the rollout, and transcript sync matches saved
    // messages to rollout items by this id.
    if (completed) this.sourceIds.add(entry.id);
    if (entry.kind === 'tool') { this.tools.set(entry.id, this.#tool(entry, item)); return; }
    if (entry.text || !this.messages.has(entry.id)) this.messages.set(entry.id, entry.text);
  }

  // src/activity-model.ts reads `result` straight off a live tool object, so a refused
  // call only shows as an error card — instead of "No output" — when it rides along here.
  #tool(entry, item) {
    if (!entry.result?.isError) return entry.tool;
    const content = this.sandboxed && mcpCall(item) && typeof entry.result.content === 'string'
      ? `${MCP_DENIED}\n\n${entry.result.content}`
      : entry.result.content;
    return { ...entry.tool, result: { ...entry.result, content } };
  }

  delta(itemId, delta) {
    this.messages.set(itemId, `${this.messages.get(itemId) ?? ''}${delta}`);
  }

  tokens(tokenUsage) {
    const usage = normalizeThreadUsage(tokenUsage);
    // The message shows what this turn cost, not what the thread has cost so far.
    // Each update restates that absolute figure; assign it, never accumulate it.
    if (usage?.turnTotal) this.usage = usage.turnTotal;
  }

  // An interrupted item/started never gets its item/completed, so its card would spin forever.
  close() {
    for (const tool of this.tools.values()) tool.status = 'complete';
  }

  emit(final = false) {
    this.onUpdate({
      sessionId: this.sessionId,
      text: this.text,
      tools: [...this.tools.values()].map((tool) => structuredClone(tool)),
      ...(this.usage ? { usage: { ...this.usage } } : {}),
      ...(this.sourceIds.size ? { sourceUuids: [...this.sourceIds] } : {}),
      final,
    });
  }
}

export class CodexRunner {
  constructor({ createConnection, command = process.env.CODEX_BIN || 'codex', clientVersion, env } = {}) {
    this.createConnection = createConnection || ((options) => new CodexAppServer(options));
    this.command = command;
    this.clientVersion = clientVersion;
    this.env = env;
    this.running = new Map();
    this.healthPromise = null;
  }

  async health() {
    if (!this.healthPromise) {
      const connection = this.#connect(this.env);
      // This promise is cached for the life of the process, so shutting the probe
      // connection down must never be able to reject it.
      this.healthPromise = connection.health().then((result) => {
        void connection.close().catch(() => {});
        return result;
      });
    }
    return this.healthPromise;
  }

  run({ chatId, sessionId, title, model, permissionMode, cwd, prompt, onUpdate, env }) {
    if (this.running.has(chatId)) throw Object.assign(new Error('Chat is already running'), { statusCode: 409 });
    // One app-server child per run, as this backend has always had one CLI child per turn:
    // concurrent chats stay concurrent without multiplexing two live turns down one pipe.
    const turn = { threadId: sessionId || null, turnId: null, interrupted: false, connection: this.#connect(env ?? this.env) };
    const done = this.#turn(turn, { sessionId, title, model, permissionMode, cwd, prompt, onUpdate })
      .finally(() => this.running.delete(chatId));
    this.running.set(chatId, { done, interrupt: () => this.#interrupt(turn) });
    return done;
  }

  async stop(chatId) {
    const entry = this.running.get(chatId);
    if (!entry) return false;
    await entry.interrupt();
    await entry.done;
    return true;
  }

  async stopAll() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  #connect(env) {
    return this.createConnection({
      command: this.command,
      ...(env ? { env } : {}),
      ...(this.clientVersion ? { clientVersion: this.clientVersion } : {}),
    });
  }

  async #turn(turn, { sessionId, title, model, permissionMode, cwd, prompt, onUpdate }) {
    const { connection } = turn;
    const sandbox = SANDBOX[permissionMode] ?? SANDBOX.default;
    const stream = new TurnStream(onUpdate, sandbox !== SANDBOX.bypassPermissions);
    let unsubscribe = () => {};
    let unsubscribeExit = () => {};
    try {
      await connection.start();
      if (sessionId) await connection.request('thread/resume', { threadId: sessionId, cwd, sandbox: sandbox.mode, approvalPolicy: 'never', excludeTurns: true });
      else turn.threadId = (await connection.request('thread/start', { cwd, sandbox: sandbox.mode, approvalPolicy: 'never', ...(model ? { model } : {}) })).thread.id;
      stream.sessionId = turn.threadId;
      // The thread exists before a single token is spent; publish its id now so the chat
      // can be resumed even when this turn never finishes.
      stream.emit();
      // A thread name is cosmetic — never fail a turn over it.
      if (title?.trim()) await connection.request('thread/name/set', { threadId: turn.threadId, name: title.trim() }).catch(() => {});
      const terminal = new Promise((resolve) => {
        unsubscribe = connection.on(STREAM_METHODS, (params, message) => {
          if (message.method === 'turn/completed') return resolve(params.turn);
          if (message.method === 'item/agentMessage/delta') stream.delta(params.itemId, params.delta);
          else if (message.method === 'thread/tokenUsage/updated') stream.tokens(params.tokenUsage);
          else stream.item(params.item, message.method === 'item/completed');
          stream.emit();
        });
        // turn/completed is the only terminal notification, so a child that dies mid-turn
        // would leave this pending forever.
        unsubscribeExit = connection.onExit((exit) => resolve({ status: 'failed', error: { message: exit.reason || 'Codex app-server exited during the turn' } }));
      });
      if (turn.interrupted) return this.#result(turn, stream, { status: 'interrupted' });
      const started = await connection.request('turn/start', {
        threadId: turn.threadId,
        input: [{ type: 'text', text: prompt }],
        // Per-turn overrides are sticky, so every turn restates all of them.
        sandboxPolicy: sandbox.policy,
        approvalPolicy: 'never',
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
      });
      turn.turnId = started.turn.id;
      if (turn.interrupted) await this.#interrupt(turn);
      return this.#result(turn, stream, await terminal);
    } catch (error) {
      return this.#result(turn, stream, { status: 'failed', error: { message: writerLocked(error) ? WRITER_LOCKED : error.message } });
    } finally {
      unsubscribe();
      // close() fires onExit too, so the terminal listener has to go first.
      unsubscribeExit();
      await connection.close();
    }
  }

  async #interrupt(turn) {
    turn.interrupted = true;
    if (!turn.turnId) return;
    // The turn may have ended between the click and this request; the thread stays usable.
    await turn.connection.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId }).catch(() => {});
  }

  #result(turn, stream, outcome) {
    const ok = outcome.status === 'completed';
    const interrupted = turn.interrupted || outcome.status === 'interrupted';
    stream.close();
    stream.emit(true);
    return {
      ok,
      interrupted,
      launchFailed: !ok && !turn.turnId,
      error: ok ? null : interrupted ? 'Interrupted' : outcome.error?.message || `Codex turn ${outcome.status}`,
      sessionId: turn.threadId,
      text: stream.text,
      tools: [...stream.tools.values()],
      ...(stream.usage ? { usage: { ...stream.usage } } : {}),
      ...(stream.sourceIds.size ? { sourceUuids: [...stream.sourceIds] } : {}),
      ...(stream.unknownTypes.size ? { unknownItemTypes: [...stream.unknownTypes] } : {}),
    };
  }
}
