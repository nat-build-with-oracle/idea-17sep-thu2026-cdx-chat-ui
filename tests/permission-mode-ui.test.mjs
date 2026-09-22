import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = () => readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

// Two permission values, and no approval prompts anywhere: approvalPolicy is always
// "never", so Default permissions cannot fall back to asking.
test('the permission picker offers exactly Full access and Default permissions', async () => {
  const source = await app();
  const options = [...source.matchAll(/<option value="(bypassPermissions|default)">([^<]+)<\/option>/g)];
  assert.deepEqual(options.map(([, value, label]) => [value, label]), [
    ['bypassPermissions', 'Full access'],
    ['default', 'Default permissions'],
  ]);
  assert.doesNotMatch(source, /acceptEdits|Allow once|Deny once/i);
  // The copy may name approval prompts, but only to say they never appear.
  assert.match(source, /Approval prompts are never shown here/);
});

// Decision 4: Default permissions must carry a visible warning that MCP tools are
// unavailable in that mode. Silently refusing them would read as a broken MCP server.
// It has to be a painted text node: a `title` needs a ~1s hover, never appears on touch,
// and is not an accessible warning. It is driven by the picker rather than the transcript
// because transcript sync deletes any message content the rollout cannot account for.
test('Default permissions warn beside the picker, in text, for as long as the mode is on', async () => {
  const source = await app();
  const toolbar = source.slice(source.indexOf('className="composer-toolbar"'), source.indexOf('className="composer-spacer"'));
  const warning = toolbar.match(/\{currentPermission !== 'bypassPermissions' && <span[^>]*>([^<{]+)<\/span>\}/);
  assert.ok(warning, 'the composer toolbar renders the warning beside the permission picker');
  assert.match(warning[1], /MCP tools are refused/);
  assert.doesNotMatch(warning[0], /title=/);
  // Full access is not sandboxed, so it must not carry the warning.
  assert.doesNotMatch(source.replace(warning[0], ''), /MCP tools are refused in this mode/);
});

test('each permission mode still explains itself on hover and in settings', async () => {
  const source = await app();
  const tooltip = source.match(/title=\{currentPermission === 'bypassPermissions' \? '([^']+)' : '([^']+)'\}/);
  assert.ok(tooltip, 'the permission picker still carries a tooltip for each mode');
  assert.match(tooltip[2], /workspace-write/);
  assert.match(tooltip[2], /MCP tools are refused/);
  assert.match(tooltip[1], /Full access/);
  assert.match(tooltip[1], /without a sandbox/);

  // The settings panel says the same thing in full, including the way out.
  const settings = source.slice(source.indexOf("modal === 'settings'"), source.indexOf("modal === 'settings'") + 3_000);
  assert.match(settings, /workspace-write/);
  assert.match(settings, /every MCP tool call is refused before it runs/);
  assert.match(settings, /switch a conversation to Full access to use MCP tools/);
  assert.match(settings, /danger-full-access/);
});

test('the runner, the composer warning and the settings panel all name the same two sandboxes', async () => {
  const runner = await readFile(new URL('../server/codex-runner.mjs', import.meta.url), 'utf8');
  assert.match(runner, /danger-full-access/);
  assert.match(runner, /workspace-write/);
  // The standing warning is UI state; a transcript notice does not survive the next sync.
  assert.doesNotMatch(runner, /stream\.notice\(|mcpNoticed|config\/read/);
  // approvalPolicy is never anything else, in either mode.
  assert.equal([...runner.matchAll(/approvalPolicy: '([^']+)'/g)].every(([, value]) => value === 'never'), true);
  assert.doesNotMatch(runner, /approvalPolicy: 'on-request'|approvalPolicy: 'untrusted'/);
});
