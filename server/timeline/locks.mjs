import { execFile } from 'node:child_process';
import path from 'node:path';

const CACHE_MS = 4_000;
const TIMEOUT_MS = 5_000;

/** Parse `lsof -F pn` field output: a `p` line opens a process, `n` lines name its files. */
export function parseLockTable(output) {
  const holders = new Map();
  let pid = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const value = Number(line.slice(1));
      pid = Number.isSafeInteger(value) && value > 0 ? value : null;
    } else if (line.startsWith('n') && pid !== null) {
      const name = path.basename(line.slice(1));
      if (!name.endsWith('.lock')) continue;
      const id = name.slice(0, -'.lock'.length);
      const pids = holders.get(id) ?? new Set();
      pids.add(pid);
      holders.set(id, pids);
    }
  }
  return new Map([...holders].map(([id, pids]) => [id, [...pids].sort((left, right) => left - right)]));
}

function readLockTable(execFileFn, directory) {
  return new Promise((resolve) => {
    // lsof exits 1 when nothing in the directory is open, which is the ordinary
    // "no live threads" answer. Anything else — no lsof on PATH, a timeout — is a
    // failure to observe liveness, and must not be reported as that same answer.
    execFileFn('lsof', ['-w', '-n', '-P', '-F', 'pn', '+D', directory], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: TIMEOUT_MS }, (error, stdout) => {
      resolve({ output: stdout || '', failed: Boolean(error) && !stdout && error.code !== 1 });
    });
  });
}

/**
 * A thread is live while its writer lock is held. The lock is an open flock, so
 * the holder set comes from the process table, never from file existence.
 */
export class LockWatcher {
  constructor({ directory, execFileFn = execFile, cacheMs = CACHE_MS, now = Date.now } = {}) {
    this.directory = directory;
    this.execFileFn = execFileFn;
    this.cacheMs = cacheMs;
    this.now = now;
    this.cached = new Map();
    this.cachedAt = Number.NEGATIVE_INFINITY;
    this.pending = null;
    // An empty holder map means "nothing is live" only while this is false;
    // otherwise liveness is unknown and callers must say so rather than draw
    // every thread as idle.
    this.readFailed = false;
  }

  async read() {
    if (this.now() - this.cachedAt < this.cacheMs) return this.cached;
    if (this.pending) return this.pending;
    this.pending = readLockTable(this.execFileFn, this.directory).then(({ output, failed }) => {
      this.cached = parseLockTable(output);
      this.readFailed = failed;
      this.cachedAt = this.now();
      this.pending = null;
      return this.cached;
    });
    return this.pending;
  }
}
