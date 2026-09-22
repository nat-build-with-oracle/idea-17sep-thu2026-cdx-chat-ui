import { execFile } from 'node:child_process';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { CodexSessions } from './codex-sessions.mjs';
import { withMcpDenial } from './codex-items.mjs';
import { MawTerminalService } from './maw-terminals.mjs';

const ACTIVE_BACKGROUND_STATES = new Set(['working', 'blocked']);
const RESUMABLE_BACKGROUND_STATES = new Set(['done', 'completed', 'failed', 'stopped']);
const ACTIVE_STATUSES = new Set(['busy', 'waiting', 'idle']);

function shortString(value, maximum = 500) {
  return typeof value === 'string' ? value.slice(0, maximum) : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function timestamp(value) {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// There is no `codex attach`. A thread another process holds and a thread waiting on disk
// are reopened by the same command, which restores the thread's own working directory.
function codexResume(id) {
  return `codex resume ${shellQuote(id)}`;
}

function normalize(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const kind = record.kind === 'interactive' || record.kind === 'background' ? record.kind : null;
  const cwd = shortString(record.cwd, 4096);
  if (!kind || !cwd || !path.isAbsolute(cwd)) return null;
  const sessionId = shortString(record.sessionId, 200);
  const state = shortString(record.state, 100);
  const status = shortString(record.status, 100);
  const pid = positiveInteger(record.pid);
  const id = shortString(record.id, 200);
  const active = Boolean(pid) || (kind === 'background' && ACTIVE_BACKGROUND_STATES.has(state)) || (kind === 'interactive' && ACTIVE_STATUSES.has(status));
  const resumable = Boolean(sessionId) && !active && (kind !== 'background' || RESUMABLE_BACKGROUND_STATES.has(state));
  const action = active && kind === 'background' && id ? 'openTerminal'
    : active && kind === 'interactive' && sessionId ? 'resumeAfterExit'
      : resumable ? 'resume' : 'unavailable';
  const terminalCommand = action === 'unavailable' ? null : codexResume(sessionId || id);
  return {
    id,
    cwd: path.resolve(cwd),
    kind,
    name: shortString(record.name, 500),
    pid,
    sessionId,
    startedAt: timestamp(record.startedAt),
    updatedAt: timestamp(record.updatedAt) ?? timestamp(record.lastModified) ?? timestamp(record.startedAt),
    state,
    status,
    waitingFor: shortString(record.waitingFor, 500),
    action,
    terminalCommand,
  };
}

function normalizeSaved(record) {
  const sessionId = shortString(record?.sessionId, 200);
  const cwd = shortString(record?.cwd, 4096);
  if (!sessionId || !cwd || !path.isAbsolute(cwd)) return null;
  const resolvedCwd = path.resolve(cwd);
  return {
    id: sessionId,
    cwd: resolvedCwd,
    kind: 'saved',
    name: shortString(record.customTitle || record.summary || record.firstPrompt, 500),
    pid: null,
    sessionId,
    startedAt: timestamp(record.createdAt) ?? timestamp(record.lastModified),
    updatedAt: timestamp(record.lastModified) ?? timestamp(record.createdAt),
    state: 'saved',
    status: null,
    waitingFor: null,
    action: 'resume',
    terminalCommand: codexResume(sessionId),
  };
}

function safeUnknown(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return String(value); }
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(safeUnknown(content));
  return content.map((block) => typeof block === 'string' ? block : block?.text || '').filter(Boolean).join('\n');
}

function messageTime(record, fallback) {
  const candidate = record?.timestamp ?? record?.message?.timestamp ?? fallback;
  const date = typeof candidate === 'string' || Number.isFinite(candidate) ? new Date(candidate) : new Date(0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function sessionChangeToken(info) {
  return JSON.stringify([info.lastModified ?? null, info.fileSize ?? null, info.cwd ?? null]);
}

function visibleText(text) {
  const command = text.match(/^\s*<command-name>(\/[\s\S]*?)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>\s*$/);
  if (!command) return text;
  const name = command[1].trim();
  const args = command[2].trim();
  return args ? `${name} ${args}` : name;
}

function normalizeHistoryMessage(record, fallbackTime) {
  if (!record || (record.type !== 'user' && record.type !== 'assistant')) return null;
  const message = record.message && typeof record.message === 'object' ? record.message : {};
  const source = Array.isArray(message.content) ? message.content : [{ type: 'text', text: typeof message.content === 'string' ? message.content : '' }];
  const blocks = [];
  const tools = [];
  const text = [];
  for (const block of source) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
      text.push(block.text);
    } else if (block?.type === 'tool_use') {
      const tool = { id: shortString(block.id, 500) || `history-tool-${blocks.length}`, name: shortString(block.name, 500) || 'tool', input: safeUnknown(block.input ?? {}), status: 'complete' };
      blocks.push({ type: 'tool', ...tool });
      tools.push(tool);
    } else if (block?.type === 'tool_result') {
      blocks.push(withMcpDenial({ type: 'toolResult', toolUseId: shortString(block.tool_use_id, 500), content: blockText(block.content), isError: Boolean(block.is_error) }));
    }
  }
  // A rollout item carries no token counts of its own, so a synced message keeps whatever
  // whole-turn usage the live run stamped on it and shows none otherwise.
  return {
    id: shortString(record.uuid, 500) || `${record.session_id || 'history'}-${fallbackTime}`,
    role: record.type,
    content: visibleText(text.join('')),
    createdAt: messageTime(record, fallbackTime),
    status: 'complete',
    ...(tools.length ? { tools } : {}),
    history: {
      sourceUuid: shortString(record.uuid, 500),
      parentToolUseId: shortString(record.parent_tool_use_id, 500),
      blocks,
    },
  };
}

export class NativeSessionService {
  constructor({ execFileFn = execFile, sdk = new CodexSessions({ execFileFn }), terminalLocator } = {}) {
    this.execFileFn = execFileFn;
    this.sdk = sdk;
    this.terminalLocator = terminalLocator || new MawTerminalService({ execFileFn });
    this.mutationQueue = Promise.resolve();
  }

  async list() {
    const [activeResult, savedResult] = await Promise.allSettled([this.#listActive(), this.#listSaved()]);
    if (activeResult.status === 'rejected' && savedResult.status === 'rejected') throw activeResult.reason;
    const saved = savedResult.status === 'fulfilled' ? savedResult.value : [];
    const active = activeResult.status === 'fulfilled' ? activeResult.value : [];
    if (activeResult.status === 'rejected') {
      for (const session of saved) {
        session.action = 'unavailable';
        session.status = 'liveStatusUnknown';
      }
    }
    const sessions = new Map(saved.map((session) => [session.sessionId, session]));
    for (const session of active) {
      const prior = session.sessionId ? sessions.get(session.sessionId) : null;
      if (prior) {
        // An attached background job also appears as an interactive process.
        // Keep its job identity, but retain the strongest active-owner guard.
        const background = [prior, session].find((entry) => entry.kind === 'background');
        const owner = [prior, session].find((entry) => entry.action === 'resumeAfterExit')
          || [prior, session].find((entry) => entry.action === 'openTerminal');
        const updatedAt = Math.max(prior.updatedAt || 0, session.updatedAt || 0) || null;
        const merged = { ...prior, ...session, ...(background || {}), name: background?.name || session.name || prior.name, updatedAt };
        if (owner) Object.assign(merged, { action: owner.action, terminalCommand: owner.terminalCommand, pid: owner.pid || merged.pid });
        sessions.set(session.sessionId, merged);
      }
      else sessions.set(session.sessionId || `active:${session.kind}:${session.id || session.pid}`, session);
    }
    const result = [...sessions.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const paths = new Map();
    await Promise.all([...new Set(result.map(session => session.cwd))].map(async cwd => {
      try { paths.set(cwd, await realpath(cwd)); } catch { /* Keep sessions from missing folders. */ }
    }));
    for (const session of result) {
      if (paths.has(session.cwd)) session.canonicalPath = paths.get(session.cwd);
    }
    const ownerCounts = new Map();
    for (const session of result) {
      if (session.pid) ownerCounts.set(session.pid, (ownerCounts.get(session.pid) || 0) + 1);
    }
    const ownerPids = [...ownerCounts.keys()].filter(pid => ownerCounts.get(pid) === 1);
    if (ownerPids.length) {
      try {
        const terminals = await this.terminalLocator.locate(ownerPids);
        for (const session of result) {
          const terminal = ownerCounts.get(session.pid) === 1 ? terminals.get(session.pid) : undefined;
          if (terminal) session.existingTerminal = terminal;
        }
      } catch { /* Optional terminal discovery must not affect the ownership guard. */ }
    }
    return result;
  }

  // Liveness is the writer-lock claim itself, so a thread someone left open in an idle
  // tab is listed as held — the same guard that keeps two writers off one thread.
  async #listActive() {
    let records;
    try {
      records = await this.sdk.listLiveThreads();
    } catch (error) {
      throw Object.assign(new Error('Unable to list live Codex threads'), { statusCode: 503, cause: error });
    }
    if (!Array.isArray(records)) throw Object.assign(new Error('Codex returned invalid live thread data'), { statusCode: 502 });
    return records.map(normalize).filter(Boolean);
  }

  async #listSaved() {
    try {
      return (await this.sdk.listSessions({ limit: 500, offset: 0 })).map(normalizeSaved).filter(Boolean);
    } catch (error) {
      throw Object.assign(new Error('Unable to list saved Codex threads'), { statusCode: 503, cause: error });
    }
  }

  async resumable(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw Object.assign(new Error('Invalid native session id'), { statusCode: 400 });
    const session = (await this.list()).find((entry) => entry.sessionId === sessionId);
    if (!session) throw Object.assign(new Error('Codex thread not found'), { statusCode: 404 });
    if (session.action === 'openTerminal' || session.action === 'resumeAfterExit') {
      const pid = session.pid ? ` (PID ${session.pid})` : '';
      const terminal = session.existingTerminal;
      const attach = terminal ? ` Existing maw terminal: ${terminal.target}. Attach with: ${terminal.attachCommand}.` : '';
      throw Object.assign(new Error(`Another Codex process still holds this thread's writer lock${pid}. Its last turn may be done, and an open idle thread still counts as held. Use that terminal, or exit it before sending here. History sync remains available.${attach}`), { statusCode: 409 });
    }
    if (session.action !== 'resume') throw Object.assign(new Error('Codex thread cannot be resumed'), { statusCode: 409 });
    return session;
  }

  async messages(sessionId, { offset = 0, limit = 100 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw Object.assign(new Error('Invalid message offset'), { statusCode: 400 });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new Error('Message limit must be between 1 and 200'), { statusCode: 400 });
    const session = (await this.list()).find((entry) => entry.sessionId === sessionId);
    if (!session) throw Object.assign(new Error('Codex thread not found'), { statusCode: 404 });
    let source;
    try {
      source = await this.sdk.getSessionMessages(sessionId, { offset, limit: limit + 1 });
    } catch (error) {
      throw Object.assign(new Error('Unable to read Codex thread history'), { statusCode: 502, cause: error });
    }
    if (!Array.isArray(source)) throw Object.assign(new Error('Codex returned invalid thread history'), { statusCode: 502 });
    const hasMore = source.length > limit;
    const fallback = session.startedAt || 0;
    const messages = source.slice(0, limit).map((message, index) => normalizeHistoryMessage(message, fallback + index)).filter(Boolean);
    return { messages, nextOffset: hasMore ? offset + limit : null };
  }

  async historySnapshot(sessionId, previousToken = null) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw Object.assign(new Error('Invalid native session id'), { statusCode: 400 });
    let before;
    try {
      before = await this.sdk.getSessionInfo(sessionId);
    } catch (error) {
      throw Object.assign(new Error('Unable to read Codex thread metadata'), { statusCode: 502, cause: error });
    }
    if (!before) throw Object.assign(new Error('Codex thread not found'), { statusCode: 404 });
    const changeToken = sessionChangeToken(before);
    if (previousToken === changeToken) return null;

    let source;
    try {
      source = await this.sdk.getSessionMessages(sessionId, { limit: 10_001 });
    } catch (error) {
      throw Object.assign(new Error('Unable to read Codex thread history'), { statusCode: 502, cause: error });
    }
    if (!Array.isArray(source)) throw Object.assign(new Error('Codex returned invalid thread history'), { statusCode: 502 });
    if (source.length > 10_000) throw Object.assign(new Error('Codex thread history exceeds the safe snapshot limit'), { statusCode: 413 });

    let after;
    try {
      after = await this.sdk.getSessionInfo(sessionId);
    } catch (error) {
      throw Object.assign(new Error('Unable to verify Codex thread metadata'), { statusCode: 502, cause: error });
    }
    if (!after || sessionChangeToken(after) !== changeToken) {
      throw Object.assign(new Error('Codex thread changed while its history was being read'), { statusCode: 409, transient: true });
    }
    const fallback = before.createdAt ?? before.lastModified ?? 0;
    return {
      changeToken,
      messages: source.map((message, index) => normalizeHistoryMessage(message, fallback + index)).filter(Boolean),
    };
  }

  async rename(sessionId, title) {
    const operation = this.mutationQueue.then(() => this.#rename(sessionId, title));
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  async #rename(sessionId, title) {
    const session = (await this.list()).find((entry) => entry.sessionId === sessionId);
    if (!session) throw Object.assign(new Error('Codex thread not found'), { statusCode: 404 });
    if (session.action !== 'resume') throw Object.assign(new Error('Codex thread cannot be safely renamed while live ownership is unknown or active'), { statusCode: 409 });
    try {
      await this.sdk.renameSession(sessionId, title);
    } catch (error) {
      throw Object.assign(new Error('Unable to rename Codex thread'), { statusCode: 502, cause: error });
    }
    let refreshed;
    try { refreshed = await this.sdk.getSessionInfo?.(sessionId); }
    catch { /* Rename succeeded; a metadata refresh failure must not report otherwise. */ }
    return { ...session, name: shortString(refreshed?.customTitle || refreshed?.summary, 500) || title };
  }
}
