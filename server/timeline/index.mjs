// Mount the returned handler inside the app's request try/catch and after the
// CORS headers are set, so its apiError status codes and CORS reach the client:
//   if (await timeline(request, response, url)) return;
import os from 'node:os';
import path from 'node:path';
import { LockWatcher } from './locks.mjs';
import { RolloutTails, TAIL_BYTES } from './rollouts.mjs';
import { readThreads } from './threads.mjs';
import { timelinePage, timelineScript } from './view.mjs';

const MAX_THREADS = 2_000;
const MAX_SESSIONS = 50;
const LIMITS = new Set([20, 50, 100, 200]);

function apiError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function sortByTime(left, right) {
  const leftTime = Date.parse(left.timestamp ?? '');
  const rightTime = Date.parse(right.timestamp ?? '');
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  if (leftValid && leftTime !== rightTime) return rightTime - leftTime;
  return left.id.localeCompare(right.id);
}

export class TimelineService {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), maxSessions = MAX_SESSIONS, maxThreads = MAX_THREADS, execFileFn } = {}) {
    const home = path.resolve(codexHome);
    this.databaseFile = path.join(home, 'state_5.sqlite');
    this.locks = new LockWatcher({ directory: path.join(home, 'thread-writer-locks'), execFileFn });
    this.tails = new RolloutTails();
    this.maxSessions = maxSessions;
    this.maxThreads = maxThreads;
  }

  async snapshot({ project = null, limit = 200 } = {}) {
    const started = performance.now();
    const scannedAt = new Date().toISOString();
    let threads;
    try {
      threads = readThreads(this.databaseFile, this.maxThreads);
    } catch (error) {
      throw apiError(`Codex thread index is unavailable: ${error.message}`, 503);
    }
    // Liveness is the claim itself: a held writer lock, including one held by an
    // idle tab and one held by this backend's own app-server child.
    const held = await this.locks.read();
    const eligible = project ? threads.filter((thread) => project.includes(thread.project)) : threads;
    const selected = eligible.slice(0, this.maxSessions);
    const { items, reads, readErrors, unknownItems } = await this.tails.read(selected);
    const rows = selected.flatMap((thread, index) => items[index].map((item) => ({
      id: `${thread.id}:${item.ordinal}`,
      threadId: thread.id,
      itemId: item.itemId,
      path: thread.path,
      project: thread.project,
      name: thread.name,
      tier: thread.tier,
      originator: thread.originator,
      live: held.has(thread.id),
      timestamp: item.timestamp,
      kind: item.kind,
      role: item.role,
      title: item.title,
      text: item.text,
      truncated: item.truncated,
    })));
    rows.sort(sortByTime);
    return {
      rows: rows.slice(0, limit),
      scannedAt,
      threads: threads.length,
      liveThreads: threads.filter((thread) => held.has(thread.id)).length,
      lockReadFailed: this.locks.readFailed,
      filesConsidered: selected.length,
      totalFiles: eligible.length,
      limitedSessions: eligible.length > this.maxSessions,
      tailBytes: TAIL_BYTES,
      maxSessions: this.maxSessions,
      limit,
      omittedRows: Math.max(0, rows.length - limit),
      readErrors,
      reads,
      unknownItems,
      tickMs: Math.round(performance.now() - started),
    };
  }
}

export function createTimelineRoutes(options = {}) {
  const service = options.service || new TimelineService(options);
  const handler = async (request, response, url) => {
    if (request.method !== 'GET' || !url.pathname.startsWith('/api/timeline')) return false;
    if (url.pathname === '/api/timeline') {
      const project = url.searchParams.getAll('project');
      if (project.length > 200 || project.some((value) => value.length > 4096)) throw apiError('Project filter is too long');
      const limit = Number(url.searchParams.get('limit') ?? 200);
      if (!LIMITS.has(limit)) throw apiError('Expected limit=20, 50, 100 or 200');
      const snapshot = await service.snapshot({ project: project.length ? project : null, limit });
      const body = JSON.stringify(snapshot);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
      response.end(body);
      return true;
    }
    if (url.pathname === '/api/timeline/view' || url.pathname === '/api/timeline/view.js') {
      const script = url.pathname.endsWith('.js');
      const body = script ? timelineScript() : timelinePage();
      response.writeHead(200, {
        'content-type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(body);
      return true;
    }
    return false;
  };
  handler.service = service;
  return handler;
}
