import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexAppServer } from './codex-app-server.mjs';
import { normalizeItem } from './codex-items.mjs';
import { LockWatcher } from './timeline/locks.mjs';
import { INTERACTIVE_THREADS } from './timeline/threads.mjs';

const ITEM_PAGE = 200;
// codex-items.mjs's normalizeItem() return value for a type it cannot render (see the
// comment there); named here rather than in that file, which this wiring pass does not touch.
const UNKNOWN_ITEM_KIND = 'unknown';
// thread/items/list answers one of these for a thread with no rollout yet (thread/start
// ran but no turn has completed): honest signal for "nothing written", not a failure.
const NO_ROLLOUT_CODES = new Set([-32601, -32600]);

// recency_at_ms defaults to 0 and updated_at_ms was added later, so neither is
// usable alone; updated_at (seconds) is the only column present on every row.
const COLUMNS = `id, rollout_path, cwd, name, title, first_user_message, preview,
  coalesce(created_at_ms, created_at * 1000) as created_ms,
  max(coalesce(recency_at_ms, 0), coalesce(updated_at_ms, 0), updated_at * 1000) as updated_ms`;
const READ_QUERY = `select ${COLUMNS} from threads where id = ?`;

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(homedir(), '.codex');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function savedSession(row) {
  return {
    sessionId: row.id,
    cwd: row.cwd,
    path: row.rollout_path,
    customTitle: row.name || null,
    summary: row.title || null,
    firstPrompt: row.first_user_message || row.preview || null,
    createdAt: row.created_ms,
    lastModified: row.updated_ms,
  };
}

function historyRecord(entry, sessionId) {
  const content = entry.kind === 'tool'
    ? [
      { type: 'tool_use', id: entry.id, name: entry.tool.name, input: entry.tool.input },
      ...(entry.result ? [{ type: 'tool_result', tool_use_id: entry.id, content: entry.result.content, is_error: entry.result.isError }] : []),
    ]
    : [{ type: 'text', text: entry.text }];
  const role = entry.kind === 'user' ? 'user' : 'assistant';
  return { type: role, uuid: entry.id, session_id: sessionId, parent_tool_use_id: null, message: { role, content } };
}

export class CodexSessions {
  constructor({ server = new CodexAppServer(), codexHome = defaultCodexHome(), execFileFn = execFile } = {}) {
    this.server = server;
    this.stateFile = path.join(codexHome, 'state_5.sqlite');
    this.locks = new LockWatcher({ directory: path.join(codexHome, 'thread-writer-locks'), execFileFn });
  }

  async listSessions({ limit = 100, offset = 0 } = {}) {
    const query = `select ${COLUMNS} from threads where archived = 0 and ${INTERACTIVE_THREADS} order by updated_ms desc limit ? offset ?`;
    return this.#read((database) => database.prepare(query).all(limit, offset)).map(savedSession);
  }

  async getSessionMessages(sessionId, { offset = 0, limit = 100 } = {}) {
    const wanted = offset + limit;
    const entries = [];
    let unknownItems = 0;
    let cursor = null;
    do {
      let page;
      try {
        page = await this.server.request('thread/items/list', { threadId: sessionId, limit: Math.min(wanted, ITEM_PAGE), ...(cursor ? { cursor } : {}) });
      } catch (error) {
        // A thread with no rollout yet (started but no turn has run) is an empty history,
        // not a failure; anything else is a real error and keeps propagating.
        if (NO_ROLLOUT_CODES.has(error?.code)) return [];
        throw error;
      }
      for (const row of page.data) {
        const entry = normalizeItem(row.item);
        if (!entry) continue;
        if (entry.kind === UNKNOWN_ITEM_KIND) { unknownItems++; continue; }
        entries.push(entry);
      }
      cursor = page.nextCursor;
    } while (cursor && entries.length < wanted);
    if (unknownItems) console.warn(`getSessionMessages(${sessionId}): skipped ${unknownItems} item(s) of an unknown type`);
    return entries.slice(offset, wanted).map((entry) => historyRecord(entry, sessionId));
  }

  async getSessionInfo(sessionId) {
    const row = this.#read((database) => database.prepare(READ_QUERY).get(sessionId));
    if (!row) return null;
    const session = savedSession(row);
    // The caller's change token is (lastModified, fileSize, cwd): the rollout is
    // the only source that moves on every appended item.
    const file = await stat(row.rollout_path).catch(() => null);
    return { ...session, lastModified: file?.mtimeMs ?? session.lastModified, fileSize: file?.size ?? null };
  }

  async renameSession(sessionId, title) {
    await this.server.request('thread/name/set', { threadId: sessionId, name: title });
  }

  // Replaces native-sessions.mjs's `claude agents --json --all` exec once wiring lands.
  async listLiveThreads() {
    const holders = await this.locks.read();
    if (!holders.size) return [];
    const ids = [...holders.keys()];
    // A claimed subagent thread is still machinery, not a session the person can resume from
    // a terminal, so the same interactive filter as listSessions applies here.
    const rows = this.#read((database) => database.prepare(`select ${COLUMNS} from threads where id in (${ids.map(() => '?').join(',')}) and ${INTERACTIVE_THREADS}`).all(...ids));
    return rows.map((row) => {
      const session = savedSession(row);
      return {
        kind: 'interactive',
        id: row.id,
        sessionId: row.id,
        pid: holders.get(row.id)[0],
        cwd: row.cwd,
        name: session.customTitle || session.summary || session.firstPrompt,
        startedAt: session.createdAt,
        updatedAt: session.lastModified,
        // The writer lock is held for as long as the thread is loaded, so an open
        // idle thread is still claimed by its holder.
        status: 'busy',
        terminalCommand: `codex resume ${shellQuote(row.id)}`,
      };
    });
  }

  // app.mjs's handler.close() must await this once wiring lands: the app-server child's piped
  // stdio keeps the event loop referenced, so an embedder awaiting app.close() otherwise hangs.
  async close() {
    await this.server.close();
  }

  #read(query) {
    let database;
    try { database = new DatabaseSync(this.stateFile, { readOnly: true }); }
    catch (error) { throw Object.assign(new Error('Unable to read Codex thread state'), { statusCode: 503, cause: error }); }
    try { return query(database); }
    finally { database.close(); }
  }
}
