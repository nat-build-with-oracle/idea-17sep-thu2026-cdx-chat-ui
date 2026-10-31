import { open } from 'node:fs/promises';
// The rollout spells a thread item in snake/Pascal case ({type:"AgentMessage",
// client_id}) where the app-server wire spells the same item in camel case
// ({type:"agentMessage", clientId}); normalizeItem accepts either.
import { normalizeItem } from '../codex-items.mjs';

export const TAIL_BYTES = 64 * 1024;
const MAX_ITEMS = 100;
const MAX_TEXT = 3000;
const MAX_CONCURRENCY = 6;
// Holding more tails than one selection keeps a project filter change from
// re-reading every rollout the previous selection had already cached.
const MAX_CACHED_TAILS = 200;

function itemsFromTail(bytes, fromStart) {
  const end = bytes.lastIndexOf(10);
  // A window opened mid-file starts on a partial record and a tail still being
  // written ends on one; neither is ever parsed.
  const first = fromStart ? 0 : bytes.indexOf(10) + 1;
  if (end < first) return { items: [], unknown: 0 };
  const items = [];
  let unknown = 0;
  for (const line of bytes.subarray(first, end).toString('utf8').split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'event_msg' || record.payload?.type !== 'item_completed') continue;
    const item = normalizeItem(record.payload.item);
    if (!item) continue;
    if (item.kind === 'unknown') {
      unknown++;
      continue;
    }
    const tool = item.kind === 'tool' ? item.tool : null;
    // A tool entry carries no prose of its own: what a reader wants to see is
    // what came back, and a call still running has only its input to show.
    const text = tool ? (typeof item.result?.content === 'string' ? item.result.content : JSON.stringify(tool.input)) : item.text;
    items.push({
      ordinal: Number.isSafeInteger(record.ordinal) ? record.ordinal : items.length,
      itemId: item.id,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
      kind: tool ? 'tool-use' : item.kind,
      role: item.kind === 'user' ? 'user' : 'assistant',
      title: tool ? tool.name : null,
      text: text.slice(0, MAX_TEXT),
      truncated: text.length > MAX_TEXT,
    });
  }
  return { items: items.slice(-MAX_ITEMS), unknown };
}

async function readTail(file, cachedRevision) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    const revision = `${info.mtimeMs}:${info.size}`;
    if (revision === cachedRevision) return null;
    const position = Math.max(0, info.size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(info.size, TAIL_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    return { revision, ...itemsFromTail(buffer.subarray(0, bytesRead), position === 0) };
  } finally {
    await handle.close();
  }
}

export class RolloutTails {
  constructor() {
    this.entries = new Map();
  }

  async read(threads) {
    const items = new Array(threads.length);
    let cursor = 0;
    let reads = 0;
    let readErrors = 0;
    let unknownItems = 0;
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, threads.length) }, async () => {
      while (cursor < threads.length) {
        const index = cursor++;
        const { path } = threads[index];
        const cached = this.entries.get(path);
        try {
          const fresh = await readTail(path, cached?.revision);
          if (fresh) {
            reads++;
            this.entries.delete(path);
            this.entries.set(path, fresh);
          }
          const tail = fresh ?? cached;
          items[index] = tail.items;
          unknownItems += tail.unknown;
        } catch {
          readErrors++;
          items[index] = cached?.items ?? [];
        }
      }
    }));
    for (const path of this.entries.keys()) {
      if (this.entries.size <= MAX_CACHED_TAILS) break;
      this.entries.delete(path);
    }
    return { items, reads, readErrors, unknownItems };
  }
}
