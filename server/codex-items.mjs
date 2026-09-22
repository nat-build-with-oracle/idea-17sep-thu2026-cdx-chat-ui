import { fileURLToPath } from 'node:url';

// Rollout records spell item types in PascalCase, the exec transport in snake_case, the
// app-server in camelCase. An unmapped spelling is not a cosmetic miss: the item drops out
// of the transcript as an unreadable type.
const canonical = (value) => (typeof value === 'string' && value
  ? `${value[0].toLowerCase()}${value.slice(1)}`.replace(/_(.)/g, (_, char) => char.toUpperCase())
  : '');

const NON_CHAT_ITEM_TYPES = new Set([
  'reasoning',
  'contextCompaction',
  'hookPrompt',
  'subAgentActivity',
  'collabAgentToolCall',
  'enteredReviewMode',
  'exitedReviewMode',
]);

const FILE_CHANGE_NAMES = { add: 'Write', delete: 'Delete', update: 'Edit' };
const FAILED_STATUSES = new Set(['failed', 'declined']);

// Measured under workspace-write with approvalPolicy "never": the MCP server is never
// reached and this sentence is the whole of what the refused call reports back.
const MCP_REFUSAL = 'MCP tool call requires approval, but approval policy is never';
// codex-runner.mjs states this same copy on the live tool card. A rollout keeps only the
// sentence above, so history that repeats it verbatim shows the app's own refusal as an
// upstream error nobody can act on — keep the two wordings identical.
export const MCP_DENIED = 'Denied: MCP tools are unavailable with Default permissions. Switch this conversation to Full access to allow them.';

export const isMcpApprovalRefusal = (content) => typeof content === 'string' && content.includes(MCP_REFUSAL);

// Both the sync path and the load-older-history path rebuild blocks from the rollout, and a
// message can pass through both, so the prefix has to be idempotent or it stacks.
export const withMcpDenial = (block) => (block.type === 'toolResult' && isMcpApprovalRefusal(block.content) && !String(block.content).startsWith(MCP_DENIED)
  ? { ...block, content: `${MCP_DENIED}\n\n${block.content}`, isError: true }
  : block);

// A turn completes one agentMessage item per reply fragment and the live turn joins them
// with a blank line, so anything that rebuilds that turn from records has to join them the
// same way or the sentence before a tool call abuts the one after it.
export const joinTurnText = (parts) => parts.filter(Boolean).join('\n\n');

function text(value) {
  return typeof value === 'string' ? value : '';
}

function partsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => canonical(part?.type) === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function localPath(value) {
  const source = text(value);
  if (!source.startsWith('file://')) return source;
  try { return fileURLToPath(source); }
  catch { return source; }
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function commandText(item) {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : item.parsed_cmd;
  const parsed = (Array.isArray(actions) ? actions : [])
    .map((action) => text(action?.command) || text(action?.cmd))
    .filter(Boolean);
  if (parsed.length) return parsed.join('\n');
  return Array.isArray(item.command) ? item.command.join(' ') : text(item.command);
}

function commandOutput(item) {
  const aggregated = text(item.aggregatedOutput) || text(item.aggregated_output) || text(item.formatted_output);
  return aggregated || [text(item.stdout), text(item.stderr)].filter(Boolean).join('\n');
}

function fileChanges(changes) {
  if (Array.isArray(changes)) {
    return changes.map((change) => ({
      path: localPath(change?.path),
      kind: canonical(change?.kind?.type),
      diff: text(change?.diff),
    }));
  }
  if (!changes || typeof changes !== 'object') return [];
  return Object.entries(changes).map(([file, change]) => ({
    path: localPath(file),
    kind: canonical(change?.type),
    diff: text(change?.unified_diff) || text(change?.content),
  }));
}

function mcpOutput(item) {
  const failure = text(item.error?.message);
  if (failure) return failure;
  const content = Array.isArray(item.result?.content) ? item.result.content : [];
  return partsText(content) || item.result?.structuredContent || content;
}

function toolEntry(type, item) {
  if (type === 'commandExecution') {
    const cwd = localPath(item.cwd);
    const exitCode = item.exitCode ?? item.exit_code;
    return {
      name: 'Bash',
      input: { command: commandText(item), ...(cwd ? { cwd } : {}) },
      output: commandOutput(item),
      isError: FAILED_STATUSES.has(item.status) || (Number.isFinite(exitCode) && exitCode !== 0),
    };
  }
  if (type === 'fileChange') {
    const changes = fileChanges(item.changes).filter((change) => change.path);
    const kinds = new Set(changes.map((change) => change.kind));
    const paths = changes.map((change) => change.path);
    return {
      name: (kinds.size === 1 && FILE_CHANGE_NAMES[[...kinds][0]]) || 'Edit',
      input: { path: paths[0] ?? '', ...(paths.length > 1 ? { paths } : {}) },
      output: changes.map((change) => (change.diff ? `${change.path}\n${change.diff}` : change.path)).join('\n\n'),
      isError: FAILED_STATUSES.has(item.status),
    };
  }
  if (type === 'mcpToolCall') {
    return {
      name: `${text(item.server) || 'mcp'}.${text(item.tool) || 'tool'}`,
      input: item.arguments ?? {},
      output: mcpOutput(item),
      isError: FAILED_STATUSES.has(item.status) || Boolean(item.error),
    };
  }
  if (type === 'webSearch' || (type === 'extension' && item.kind === 'web.search')) {
    return { name: 'WebSearch', input: { query: text(item.query) }, output: item.results ?? '', isError: false };
  }
  if (type === 'imageView') {
    return { name: 'Read', input: { path: localPath(item.path) }, output: '', isError: false };
  }
  if (type === 'imageGeneration' || (type === 'extension' && item.kind === 'image_gen.generation')) {
    return {
      name: 'ImageGeneration',
      input: text(item.revisedPrompt),
      output: text(item.savedPath) || text(item.failure),
      isError: FAILED_STATUSES.has(item.status) || Boolean(item.failure),
    };
  }
  if (type === 'sleep' || (type === 'extension' && item.kind === 'clock.sleep')) {
    return { name: 'Sleep', input: { durationMs: item.durationMs ?? null }, output: '', isError: false };
  }
  if (type === 'plan') {
    return { name: 'Plan', input: text(item.text), output: '', isError: false };
  }
  return null;
}

export function normalizeItem(item) {
  const type = canonical(item?.type);
  const id = text(item?.id);
  if (!type || !id || NON_CHAT_ITEM_TYPES.has(type)) return null;
  if (type === 'userMessage') return { kind: 'user', id, text: partsText(item.content) };
  if (type === 'agentMessage') {
    // Models do not emit the phase consistently, so only an explicit preamble is
    // held back from the reply.
    return { kind: 'assistant', id, text: text(item.text) || partsText(item.content), final: item.phase !== 'commentary' };
  }
  const shape = toolEntry(type, item);
  // A type Codex adds later is neither chat nor tool here, and returning null would
  // erase it from the transcript with no trace. The sentinel lets a caller skip the
  // content it cannot render while still reporting that something went unread.
  if (!shape) return { kind: 'unknown', id, type };
  const running = item.status === 'inProgress';
  return {
    kind: 'tool',
    id,
    tool: { id, name: shape.name, input: shape.input, status: running ? 'running' : 'complete' },
    result: running ? null : { content: shape.output, isError: shape.isError },
  };
}

export function normalizeRolloutRecord(record) {
  if (record?.type !== 'event_msg' || record.payload?.type !== 'item_completed') return null;
  const entry = normalizeItem(record.payload.item);
  return entry ? { ...entry, createdAt: text(record.timestamp) || null } : null;
}

function tokenTotals(counts, scope) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  const inputTokens = nonnegativeInteger(counts.inputTokens ?? counts.input_tokens);
  const outputTokens = nonnegativeInteger(counts.outputTokens ?? counts.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const cacheReadInputTokens = nonnegativeInteger(counts.cachedInputTokens ?? counts.cached_input_tokens);
  const cacheCreationInputTokens = nonnegativeInteger(counts.cacheWriteInputTokens ?? counts.cache_write_input_tokens);
  // Codex counts cached and cache-write tokens inside inputTokens; the app adds
  // the three back together when it renders one input total.
  const uncached = inputTokens - (cacheReadInputTokens ?? 0) - (cacheCreationInputTokens ?? 0);
  if (uncached < 0) return null;
  return {
    inputTokens: uncached,
    outputTokens,
    ...(cacheReadInputTokens === null ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === null ? {} : { cacheCreationInputTokens }),
    scope,
  };
}

export function normalizeThreadUsage(tokenUsage) {
  // Both figures restate an absolute count on every update, so a caller that adds
  // them together double-counts. Assign either one, never accumulate it.
  const threadTotal = tokenTotals(tokenUsage?.total ?? tokenUsage?.thread_token_usage ?? tokenUsage?.info?.total_token_usage ?? tokenUsage?.total_token_usage, 'threadTotal');
  // `total` is the whole thread's running sum, so stamping it on a message makes
  // identical turns look ever more expensive. `last` is the turn, the analogue of
  // Claude's per-run figure, and 'mainAgent' is the scope the frozen UI knows.
  const turnTotal = tokenTotals(tokenUsage?.last ?? tokenUsage?.info?.last_token_usage, 'mainAgent');
  if (!threadTotal && !turnTotal) return null;
  return { ...(threadTotal ? { threadTotal } : {}), ...(turnTotal ? { turnTotal } : {}) };
}
