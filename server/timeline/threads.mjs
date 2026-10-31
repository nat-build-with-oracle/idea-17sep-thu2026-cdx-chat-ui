import { DatabaseSync } from 'node:sqlite';

// Threads a person opened. Subagent, review and compaction runs live in the same
// table and outnumber them seven to one, so without this the Timeline is mostly
// machinery talking to itself. Import this rather than spelling it a second time.
export const INTERACTIVE_THREADS = `(thread_source is null or thread_source = 'user')`;

// recency_at_ms defaults to 0 and updated_at_ms was added later, so neither is
// usable alone; updated_at (seconds) is the only column present on every row.
const QUERY = `select id, rollout_path, cwd, name, title, thread_source, originator, model,
  max(coalesce(recency_at_ms, 0), coalesce(updated_at_ms, 0), updated_at * 1000) as updated_ms
  from threads where archived = 0 and ${INTERACTIVE_THREADS} order by updated_ms desc limit ?`;

function isoTime(milliseconds) {
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

export function readThreads(databaseFile, limit) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database.prepare(QUERY).all(limit).map((row) => ({
      id: row.id,
      path: row.rollout_path,
      project: row.cwd,
      name: row.name || row.title || null,
      tier: row.thread_source || 'session',
      originator: row.originator,
      model: row.model,
      updatedAt: isoTime(row.updated_ms),
    }));
  } finally {
    database.close();
  }
}
