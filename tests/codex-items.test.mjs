import assert from 'node:assert/strict';
import test from 'node:test';
import { MCP_DENIED, isMcpApprovalRefusal, joinTurnText, normalizeItem, normalizeRolloutRecord, normalizeThreadUsage, withMcpDenial } from '../server/codex-items.mjs';

// One normalizer serves three dialects: the app-server wire spells an item
// {type:"agentMessage", aggregatedOutput}, the rollout on disk spells the same item
// {type:"AgentMessage", aggregated_output}, and the exec transport {type:"agent_message"}.
// Every case below is asserted in all three.
function everyDialect(camel) {
  return [
    ['app-server', camel],
    ['rollout', { ...camel, type: `${camel.type[0].toUpperCase()}${camel.type.slice(1)}` }],
    ['exec', { ...camel, type: camel.type.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`) }],
  ];
}

test('agent and user messages normalize identically in every dialect', () => {
  for (const [dialect, item] of everyDialect({ type: 'agentMessage', id: 'a1', text: 'Hello' })) {
    assert.deepEqual(normalizeItem(item), { kind: 'assistant', id: 'a1', text: 'Hello', final: true }, dialect);
  }
  for (const [dialect, item] of everyDialect({ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'first' }, { type: 'image', url: 'x' }, { type: 'Text', text: 'second' }] })) {
    assert.deepEqual(normalizeItem(item), { kind: 'user', id: 'u1', text: 'first\nsecond' }, dialect);
  }
});

test('an agent message falls back to its content parts and marks an explicit preamble non-final', () => {
  assert.equal(normalizeItem({ type: 'agentMessage', id: 'a1', content: [{ type: 'text', text: 'from parts' }] }).text, 'from parts');
  assert.equal(normalizeItem({ type: 'agentMessage', id: 'a1', text: 'x', phase: 'commentary' }).final, false);
  // Models do not emit the phase consistently, so anything but an explicit preamble is final.
  assert.equal(normalizeItem({ type: 'agentMessage', id: 'a1', text: 'x' }).final, true);
  assert.equal(normalizeItem({ type: 'agentMessage', id: 'a1', text: 'x', phase: 'final' }).final, true);
});

test('a command execution becomes a Bash tool in both dialects, including its parsed command and output', () => {
  const wire = normalizeItem({
    type: 'commandExecution', id: 'c1', status: 'completed', exitCode: 0,
    commandActions: [{ command: 'rg needle' }], cwd: 'file:///work/repo', aggregatedOutput: 'hit',
  });
  assert.deepEqual(wire, {
    kind: 'tool', id: 'c1',
    tool: { id: 'c1', name: 'Bash', input: { command: 'rg needle', cwd: '/work/repo' }, status: 'complete' },
    result: { content: 'hit', isError: false },
  });
  const disk = normalizeItem({
    type: 'CommandExecution', id: 'c1', status: 'completed', exit_code: 0,
    parsed_cmd: [{ cmd: 'rg needle' }], cwd: 'file:///work/repo', aggregated_output: 'hit',
  });
  assert.deepEqual(disk, wire);
});

test('a command is an error when it failed or exited non-zero, and falls back to raw argv and streams', () => {
  const item = normalizeItem({ type: 'commandExecution', id: 'c1', status: 'completed', exitCode: 2, command: ['ls', '-la'], stdout: 'out', stderr: 'err' });
  assert.equal(item.tool.input.command, 'ls -la');
  assert.equal(item.result.content, 'out\nerr');
  assert.equal(item.result.isError, true);
  assert.equal(normalizeItem({ type: 'commandExecution', id: 'c1', status: 'declined', command: 'x' }).result.isError, true);
  // A call still running has no result yet, so its card stays open rather than showing "".
  const running = normalizeItem({ type: 'commandExecution', id: 'c1', status: 'inProgress', command: 'x' });
  assert.equal(running.tool.status, 'running');
  assert.equal(running.result, null);
});

test('file changes name themselves after the single edit kind and list every path', () => {
  const wire = normalizeItem({
    type: 'fileChange', id: 'f1', status: 'completed',
    changes: [{ path: 'file:///work/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }],
  });
  assert.equal(wire.tool.name, 'Edit');
  assert.deepEqual(wire.tool.input, { path: '/work/a.ts' });
  assert.equal(wire.result.content, '/work/a.ts\n@@ -1 +1 @@');

  const disk = normalizeItem({
    type: 'FileChange', id: 'f1', status: 'completed',
    changes: { '/work/a.ts': { type: 'add', unified_diff: '+new' }, '/work/b.ts': { type: 'add', unified_diff: '+more' } },
  });
  assert.equal(disk.tool.name, 'Write');
  assert.deepEqual(disk.tool.input, { path: '/work/a.ts', paths: ['/work/a.ts', '/work/b.ts'] });

  // Mixed kinds have no single honest name, so the generic one is used.
  const mixed = normalizeItem({ type: 'fileChange', id: 'f1', changes: [{ path: '/a', kind: { type: 'add' } }, { path: '/b', kind: { type: 'delete' } }] });
  assert.equal(mixed.tool.name, 'Edit');
});

test('an MCP call is named server.tool and reports its failure message as the output', () => {
  const ok = normalizeItem({ type: 'mcpToolCall', id: 'm1', status: 'completed', server: 'memory', tool: 'recall', arguments: { q: 'x' }, result: { content: [{ type: 'text', text: 'found' }] } });
  assert.equal(ok.tool.name, 'memory.recall');
  assert.deepEqual(ok.tool.input, { q: 'x' });
  assert.equal(ok.result.content, 'found');
  assert.equal(ok.result.isError, false);

  const failed = normalizeItem({ type: 'McpToolCall', id: 'm1', status: 'failed', server: 'memory', tool: 'recall', error: { message: 'MCP tool call requires approval, but approval policy is never' } });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content, /approval policy is never/);
  // A nameless call still renders rather than disappearing.
  assert.equal(normalizeItem({ type: 'mcpToolCall', id: 'm1' }).tool.name, 'mcp.tool');
});

// Default permissions refuse every MCP call before it runs. An unmapped spelling drops that
// refusal out of the transcript, which is how a denied call comes back looking like a result.
test('the approval-policy refusal is recognised as a failed MCP call in every dialect', () => {
  const refusal = 'MCP tool call requires approval, but approval policy is never';
  const denied = { type: 'mcpToolCall', id: 'm1', status: 'failed', server: 'arra-oracle', tool: 'oracle_concepts', arguments: { limit: 2 }, error: { message: refusal } };
  for (const [dialect, item] of everyDialect(denied)) {
    const entry = normalizeItem(item);
    assert.equal(entry.kind, 'tool', dialect);
    assert.equal(entry.tool.name, 'arra-oracle.oracle_concepts', dialect);
    assert.equal(entry.result.isError, true, dialect);
    assert.equal(isMcpApprovalRefusal(entry.result.content), true, dialect);
  }
  // A genuine tool failure is not the sandbox refusing the call, and must not be relabelled.
  assert.equal(isMcpApprovalRefusal('upstream timeout'), false);
  assert.equal(isMcpApprovalRefusal(undefined), false);
});

// The live turn joins its agentMessage items with a blank line; transcript-sync rebuilds the
// same turn from records and has to reach the same text.
test('turn text keeps a blank line between messages and ignores the empty tool records', () => {
  assert.equal(joinTurnText(['first', '', 'second']), 'first\n\nsecond');
  assert.equal(joinTurnText(['only']), 'only');
  assert.equal(joinTurnText([]), '');
});

test('web search, image view, image generation, sleep and plan all map onto tool cards', () => {
  assert.equal(normalizeItem({ type: 'webSearch', id: 'w1', query: 'codex' }).tool.name, 'WebSearch');
  assert.equal(normalizeItem({ type: 'extension', id: 'w2', kind: 'web.search', query: 'codex' }).tool.name, 'WebSearch');
  assert.deepEqual(normalizeItem({ type: 'imageView', id: 'i1', path: 'file:///work/a.png' }).tool.input, { path: '/work/a.png' });
  assert.equal(normalizeItem({ type: 'imageGeneration', id: 'g1', revisedPrompt: 'a cat', savedPath: '/tmp/cat.png' }).result.content, '/tmp/cat.png');
  assert.equal(normalizeItem({ type: 'extension', id: 'g2', kind: 'image_gen.generation', failure: 'refused' }).result.isError, true);
  assert.deepEqual(normalizeItem({ type: 'sleep', id: 's1', durationMs: 50 }).tool.input, { durationMs: 50 });
  assert.equal(normalizeItem({ type: 'plan', id: 'p1', text: 'do the thing' }).tool.input, 'do the thing');
});

test('reasoning and other non-chat machinery are dropped outright, not reported as unreadable', () => {
  for (const type of ['reasoning', 'contextCompaction', 'hookPrompt', 'subAgentActivity', 'collabAgentToolCall', 'enteredReviewMode', 'exitedReviewMode']) {
    for (const [dialect, item] of everyDialect({ type, id: 'x1' })) assert.equal(normalizeItem(item), null, `${dialect} ${type}`);
  }
  assert.equal(normalizeItem(null), null);
  assert.equal(normalizeItem({ type: 'agentMessage' }), null, 'an item with no id cannot be matched to anything');
  assert.equal(normalizeItem({ id: 'a1' }), null);
});

// Returning null for an unrecognised type would erase it from the transcript with no
// trace. The sentinel lets a caller skip what it cannot render and still say so.
test('an item type this build has never seen is flagged rather than silently dropped', () => {
  assert.deepEqual(normalizeItem({ type: 'holographicProjection', id: 'x1' }), { kind: 'unknown', id: 'x1', type: 'holographicProjection' });
  assert.deepEqual(normalizeItem({ type: 'HolographicProjection', id: 'x1' }), { kind: 'unknown', id: 'x1', type: 'holographicProjection' });
});

test('only a completed rollout event becomes a record, and it carries the record timestamp', () => {
  const record = { type: 'event_msg', timestamp: '2026-09-17T08:05:08.708Z', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', text: 'done' } } };
  assert.deepEqual(normalizeRolloutRecord(record), { kind: 'assistant', id: 'a1', text: 'done', final: true, createdAt: '2026-09-17T08:05:08.708Z' });
  assert.equal(normalizeRolloutRecord({ ...record, type: 'turn_context' }), null);
  assert.equal(normalizeRolloutRecord({ ...record, payload: { type: 'item_started', item: record.payload.item } }), null);
  assert.equal(normalizeRolloutRecord({ ...record, timestamp: 42 }).createdAt, null);
});

// Both figures restate an absolute count on every update. `total` is the whole thread's
// running sum; `last` is this turn — the analogue of Claude's per-run figure.
test('thread usage separates the thread total from the turn total and never mixes their scopes', () => {
  const usage = normalizeThreadUsage({
    total: { inputTokens: 59_976, outputTokens: 21, cachedInputTokens: 33_408, cacheWriteInputTokens: 0 },
    last: { inputTokens: 19_992, outputTokens: 7, cachedInputTokens: 11_136, cacheWriteInputTokens: 0 },
  });
  assert.equal(usage.threadTotal.scope, 'threadTotal');
  assert.equal(usage.turnTotal.scope, 'mainAgent');
  // Codex counts cached tokens inside inputTokens; the app re-adds the three when it renders.
  assert.equal(usage.threadTotal.inputTokens, 26_568);
  assert.equal(usage.turnTotal.inputTokens, 8_856);
  assert.equal(usage.turnTotal.cacheReadInputTokens, 11_136);
});

test('thread usage accepts the snake_case rollout spellings and the nested info envelope', () => {
  const nested = normalizeThreadUsage({ info: { total_token_usage: { input_tokens: 10, output_tokens: 2 }, last_token_usage: { input_tokens: 4, output_tokens: 1 } } });
  assert.deepEqual(nested.threadTotal, { inputTokens: 10, outputTokens: 2, scope: 'threadTotal' });
  assert.deepEqual(nested.turnTotal, { inputTokens: 4, outputTokens: 1, scope: 'mainAgent' });
  assert.deepEqual(normalizeThreadUsage({ thread_token_usage: { input_tokens: 3, output_tokens: 1 } }), { threadTotal: { inputTokens: 3, outputTokens: 1, scope: 'threadTotal' } });
});

test('incomplete or impossible token counts are refused rather than partially reported', () => {
  assert.equal(normalizeThreadUsage(undefined), null);
  assert.equal(normalizeThreadUsage({ last: { inputTokens: 5 } }), null, 'output is required');
  assert.equal(normalizeThreadUsage({ last: { inputTokens: 1.5, outputTokens: 2 } }), null, 'counts must be integers');
  assert.equal(normalizeThreadUsage({ last: { inputTokens: -1, outputTokens: 2 } }), null);
  assert.equal(normalizeThreadUsage({ last: { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 2 } }), null);
  // Cache counts larger than the input total would render as a negative uncached figure.
  assert.equal(normalizeThreadUsage({ last: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 20 } }), null);
  assert.equal(normalizeThreadUsage({ last: [] }), null);
  // A zero turn is a real measurement, unlike a missing one.
  assert.deepEqual(normalizeThreadUsage({ last: { inputTokens: 0, outputTokens: 0 } }).turnTotal, { inputTokens: 0, outputTokens: 0, scope: 'mainAgent' });
});

// A denied call reaches the UI through the live turn, a transcript sync and the load-older
// path, and a message can pass through more than one of them, so the prefix has to stick once.
test('a refused MCP call is labelled for the user exactly once, however the history was loaded', () => {
  const refused = { type: 'toolResult', toolUseId: 'm-2', content: 'MCP tool call requires approval, but approval policy is never', isError: false };

  const once = withMcpDenial(refused);
  assert.ok(once.content.startsWith(MCP_DENIED));
  assert.ok(once.content.includes('approval policy is never'));
  assert.equal(once.isError, true);

  assert.deepEqual(withMcpDenial(once), once);

  const ordinary = { type: 'toolResult', toolUseId: 'm-3', content: 'ordinary output', isError: false };
  assert.deepEqual(withMcpDenial(ordinary), ordinary);
});
