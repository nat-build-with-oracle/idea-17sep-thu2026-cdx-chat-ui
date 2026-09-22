// Palette values are copied from src/styles.css rather than imported: this page
// is served straight from the backend and never goes through the Vite build.
const STYLE = `
:root, :root[data-theme="pop"] { color-scheme: light;
  --canvas: #f5f5fc; --panel: #fff; --surface: #fff; --raised: #eeeafb; --selected: #d8ccff;
  --ink: #25243b; --muted: #5d6076; --line: #dcddeb; --accent: #6842d8; --accent-ink: #fff; --danger: #a32c39; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark;
  --canvas: #171923; --panel: #262a39; --surface: #202330; --raised: #2d3244; --selected: #514773;
  --ink: #f2f3fc; --muted: #bec3d6; --line: #464d65; --accent: #bba5ff; --accent-ink: #241840; --danger: #ffb3bd; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--canvas); color: var(--ink); font-size: 15px; line-height: 1.6;
  font-family: "Avenir Next", Avenir, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
h2 { margin: 0; font-size: 19px; font-weight: 600; }
p { margin: 4px 0 0; }
.muted { color: var(--muted); font-size: 13px; }
.head { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.controls { display: flex; flex-wrap: wrap; align-items: end; gap: 14px; margin-bottom: 14px; }
label { display: block; font-size: 12px; font-weight: 500; }
input, select { display: block; margin-top: 6px; width: 100%; padding: 7px 11px; font: inherit; font-size: 14px;
  color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 7px; }
button { padding: 7px 12px; font: inherit; font-size: 13px; color: inherit; background: var(--panel);
  border: 1px solid var(--line); border-radius: 7px; cursor: pointer; }
button:hover { background: var(--selected); }
button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.timeline-grid { width: 100%; table-layout: fixed; border-collapse: collapse; text-align: left; font-size: 14px; }
.timeline-grid th, .timeline-grid td { border: 1px solid var(--line); padding: 14px; overflow-wrap: anywhere; vertical-align: top; }
.timeline-grid thead { background: var(--raised); font-size: 12px; }
.timeline-grid tbody tr { --row-bg: var(--surface); background: var(--row-bg); }
.timeline-grid tbody tr:nth-child(even) { --row-bg: var(--panel); }
@keyframes timeline-arrival { 0%, 100% { background: var(--row-bg); } 25%, 55% { background: var(--selected); } }
.timeline-grid tr[data-new="true"] { animation: timeline-arrival 1.5s ease-in-out; }
@media (prefers-reduced-motion: reduce) { .timeline-grid tr[data-new="true"] { animation: none; background: var(--selected); } }
.timeline-event-scroll { max-height: 18rem; overflow: auto; }
.timeline-grid pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.7; }
.timeline-grid pre.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.event-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-bottom: 8px; font-size: 12px; }
.event-head b { color: var(--accent); font-weight: 500; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.live { display: inline-block; margin-left: 6px; padding: 0 7px; border-radius: 999px; font-size: 11px;
  background: var(--accent); color: var(--accent-ink); }
.foot { position: sticky; bottom: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 12px; margin-top: 12px; padding: 12px 0; border-top: 1px solid var(--line); background: var(--canvas); }
.empty { padding: 48px; text-align: center; }
.error { color: var(--danger); }
@media (max-width: 767px) { .timeline-grid, .timeline-grid tbody { display: block; }
  .timeline-grid colgroup, .timeline-grid thead { display: none; }
  .timeline-grid tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .timeline-grid td { min-width: 0; margin-top: -1px; }
  .timeline-grid td:nth-child(3), .timeline-grid td:nth-child(4) { grid-column: 1 / -1; } }
`;

const SCRIPT = `
const state = { limit: 100, direction: "top", query: "", following: true, paused: false, seen: new Set(), fresh: new Set(), rows: [], data: null };
const $ = (id) => document.getElementById(id);
const localTime = (value) => value ? new Date(value).toLocaleString() : "Not recorded";
const shortProject = (value) => String(value || "").split("/").filter(Boolean).slice(-2).join("/") || "unknown";

function cell(row, ...children) { const td = document.createElement("td"); for (const child of children) td.append(child); row.append(td); return td; }
function div(className, text) { const node = document.createElement("div"); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }

function render() {
  const query = state.query.toLocaleLowerCase();
  const rows = state.rows.filter((row) => \`\${row.project} \${row.threadId} \${row.name ?? ""} \${row.title ?? ""} \${row.text}\`.toLocaleLowerCase().includes(query));
  const visible = state.direction === "bottom" ? rows.toReversed() : rows;
  const body = $("timeline-rows");
  body.replaceChildren();
  for (const row of visible) {
    const tr = document.createElement("tr");
    if (state.fresh.has(row.id)) tr.dataset.new = "true";
    cell(tr, div("", shortProject(row.project)), div("muted", row.project));
    cell(tr, div("muted", localTime(row.timestamp)));
    const identity = cell(tr, div("mono", row.threadId));
    if (row.name) identity.append(div("", row.name));
    identity.append(div("muted", row.tier + (row.originator ? " · " + row.originator : "")));
    if (row.live) { const badge = div("live", "live"); identity.append(badge); }
    const head = div("event-head");
    const title = document.createElement("b");
    title.textContent = row.title || row.role;
    head.append(title, div("muted", row.text.split(/\\r?\\n/).length + " lines"));
    const scroll = div("timeline-event-scroll");
    const pre = document.createElement("pre");
    if (row.kind === "tool-use") pre.className = "mono";
    pre.textContent = row.text;
    scroll.append(pre);
    if (row.truncated) scroll.append(div("muted", "Excerpt shortened to keep the live table responsive"));
    cell(tr, head, scroll);
    body.append(tr);
  }
  $("timeline-empty").hidden = visible.length > 0;
  const data = state.data;
  $("timeline-count").textContent = data
    ? \`\${visible.length} / \${state.limit} events · \${data.filesConsidered} threads read · \${data.lockReadFailed ? "liveness unknown, lsof did not answer" : data.liveThreads + " live of " + data.threads}\`
    : "Waiting for events…";
  $("timeline-limits").textContent = data
    ? \`Last \${state.limit} events · up to \${data.maxSessions} threads · \${Math.round(data.tailBytes / 1024)} KiB tail each · tick \${data.tickMs} ms\${data.readErrors ? " · " + data.readErrors + " rollouts could not be read" : ""}\${data.unknownItems ? " · " + data.unknownItems + " items of an unknown type skipped" : ""}\`
    : "";
  if (state.following) window.scrollTo({ top: state.direction === "bottom" ? document.documentElement.scrollHeight : 0, behavior: "instant" });
}

async function tick() {
  if (state.paused) return;
  $("timeline-live").textContent = "Updating…";
  try {
    const response = await fetch(\`/api/timeline?limit=\${state.limit}\`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(\`backend \${response.status}\`);
    const data = await response.json();
    state.fresh = new Set(data.rows.filter((row) => !state.seen.has(row.id)).map((row) => row.id));
    for (const row of data.rows) state.seen.add(row.id);
    state.data = data;
    state.rows = data.rows;
    $("timeline-error").textContent = "";
    render();
  } catch (failure) {
    $("timeline-error").textContent = \`Timeline unavailable: \${failure.message}. Check the backend, then Refresh.\`;
  } finally {
    $("timeline-live").textContent = state.paused ? "Paused" : "Following complete events";
  }
}

function follow(value) { state.following = value; $("timeline-follow").setAttribute("aria-pressed", String(value)); $("timeline-follow").textContent = value ? "Following latest" : "Follow latest"; }

$("timeline-search").addEventListener("input", (event) => { state.query = event.target.value; follow(false); render(); });
$("timeline-limit").addEventListener("change", (event) => { state.limit = Number(event.target.value); state.seen = new Set(); follow(true); void tick(); });
$("timeline-direction").addEventListener("change", (event) => { state.direction = event.target.value; follow(true); render(); });
$("timeline-pause").addEventListener("click", () => { state.paused = !state.paused; $("timeline-pause").setAttribute("aria-pressed", String(state.paused)); $("timeline-pause").textContent = state.paused ? "Resume" : "Pause"; $("timeline-live").textContent = state.paused ? "Paused" : "Following complete events"; });
$("timeline-refresh").addEventListener("click", () => { state.seen = new Set(); void tick(); });
$("timeline-follow").addEventListener("click", () => follow(!state.following));
$("timeline-top").addEventListener("click", () => { follow(false); window.scrollTo({ top: 0, behavior: "instant" }); });
window.addEventListener("scroll", () => { const away = state.direction === "bottom" ? document.documentElement.scrollHeight - window.innerHeight - window.scrollY > 100 : window.scrollY > 100; if (away) follow(false); }, { passive: true });

void tick();
setInterval(() => void tick(), 2000);
`;

export function timelinePage() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Live Timeline</title><style>${STYLE}</style></head>
<body>
<section id="timeline" aria-label="Live event timeline">
  <div class="head">
    <div><h2>Timeline</h2><p class="muted">New events append at the chosen end every 2 seconds. Times are recorded in the rollout, not file touches. A thread is live while its writer lock is claimed.</p></div>
    <span id="timeline-live" class="muted">Following complete events</span>
  </div>
  <div class="controls">
    <label style="flex:2 1 20rem">Search this timeline<input id="timeline-search" type="search" placeholder="Message, directory, name or thread ID"></label>
    <label>Events<select id="timeline-limit"><option value="20">20 events</option><option value="50">50 events</option><option value="100" selected>100 events</option><option value="200">200 events</option></select></label>
    <label>New events<select id="timeline-direction"><option value="top">At the top &uarr;</option><option value="bottom">At the bottom &darr;</option></select></label>
  </div>
  <div class="actions">
    <button id="timeline-pause" aria-pressed="false">Pause</button>
    <button id="timeline-refresh">Refresh</button>
    <button id="timeline-follow" aria-pressed="true">Following latest</button>
    <span id="timeline-count" class="muted" role="status">Waiting for events&hellip;</span>
  </div>
  <p id="timeline-error" class="error" role="alert"></p>
  <table class="timeline-grid">
    <colgroup><col style="width:20%"><col style="width:15%"><col style="width:20%"><col style="width:45%"></colgroup>
    <thead><tr><th>Working directory</th><th>Date / time</th><th>Thread</th><th>Stream &middot; multiline event</th></tr></thead>
    <tbody id="timeline-rows"></tbody>
  </table>
  <p id="timeline-empty" class="empty muted" hidden>No matching events. Adjust the search, or wait for a thread to write.</p>
  <div class="foot"><span id="timeline-limits" class="muted"></span><button id="timeline-top">Back to controls &uarr;</button></div>
</section>
<script src="/api/timeline/view.js"></script>
</body></html>`;
}

export function timelineScript() {
  return SCRIPT;
}
