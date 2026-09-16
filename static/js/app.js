// State, routing and the shell. Derivation lives in derive.js; each screen is a
// pure renderer. Every interactive element carries data-act and is handled by
// the delegated listener at the bottom of this file.

import * as api from './api.js';
import { buildModel, collectModelUsage, usageCost } from './derive.js';
import { attachGraph, detachGraph } from './graph.js';
import { renderAnalytics } from './screens/analytics.js';
import { renderConvDrawer, renderNodeDrawer } from './screens/drawers.js';
import { renderFit } from './screens/fit.js';
import { renderPrompts } from './screens/prompts.js';
import { renderOverview } from './screens/overview.js';
import { renderReport } from './screens/report.js';
import { TOOL_COLUMNS, renderTools } from './screens/tools.js';
import { LEDGER_COLUMNS, encodingList, renderWorkflow } from './screens/workflow.js';
import { CONV_COLUMNS, renderConversations } from './screens/conversations.js';
import {
  agentCountLabel, renderAgentList, renderAgentOptions, renderSetup,
} from './screens/setup.js';
import { upgrade } from './tokenizer.js';
import {
  $, daysBetween, h, int, longDate, nextSort, shiftDays, shortDate, today,
} from './util.js';

const SCREENS = {
  overview: 'Overview',
  workflow: 'Workflow cost',
  prompts: 'Prompt audit',
  fit: 'Model fit (wip, beta)',
  tools: 'Tool usage',
  conversations: 'Conversations',
  analytics: 'Token analytics',
  report: 'Cost report',
};

const state = {
  phase: 'setup',
  wizard: 'stepped',
  apiKeyDraft: '',
  hasKey: false,
  keyMask: null,
  region: 'global',
  regions: [],
  apiBase: '',
  keyError: null,
  savedKeys: [],
  activeAlias: null,
  // Which saved key is *selected in the picker*, and separately what alias the
  // save row would write under. One field served both, which is why choosing
  // from the list left the list showing its placeholder: the `<option selected>`
  // was bound to `activeAlias` while picking wrote the draft, so the select
  // snapped back while the save row filled in.
  aliasPick: null,
  aliasDraft: '',
  keyBackend: 'memory',
  // Set only by the demo action. The demo writes a window without a key, so it
  // is the one path besides connecting that opens steps 2 and 3.
  demoSeeded: false,
  // Windows already on disk, and whether the user asked to work from them
  // rather than sync. `/api/window` has always served a cached window without a
  // key; these two make that reachable and explicit.
  cacheWindows: [],
  cacheOnly: false,
  loadError: null,
  busy: false,

  agents: [],
  agentId: null,
  agentQuery: '',
  branches: [],
  branchIds: [],
  dependencies: null,
  depsLoading: false,
  branchTotal: 0,
  versions: [],
  versionId: null,
  versionLabel: null,
  versionTouched: false,

  to: today(),
  from: shiftDays(today(), -13),
  preset: '14d',

  job: null,
  bundle: null,
  model: null,
  previousSpend: null,

  // The landing screen. Workflow was the default before the Overview existed;
  // arriving on a summary rather than on a 75-node canvas is the point of it.
  screen: 'overview',
  encoding: 'heat',
  // Which Analytics layout is shown. Named apart from `layout` on purpose: that
  // one holds the saved graph positions, and the two shared a field. The
  // duplicate key meant this default was dead, clicking Ledger overwrote the
  // positions with the string 'ledger' (dropping every dragged node on the next
  // rebuild), and dragging a node made the toggle inert.
  analyticsView: 'overview',
  convFilter: 'All',
  convSort: { key: 'cost', dir: 'desc' },
  convPage: 1,
  ledgerSort: { key: 'rank', dir: 'asc' },
  ledgerPage: 1,
  toolSort: { key: 'calls', dir: 'desc' },
  toolPage: 1,
  toolOpen: null,
  promptSort: { key: 'promptCost', dir: 'desc' },
  node: null,
  conv: null,
  fitOpen: null,
  fitAgent: null,
  layout: null,
  layoutSaved: false,
};

let toastTimer = null;
function toast(message, ms = 4200) {
  const el = $('#toast');
  el.innerHTML = `<div class="toast">${h(message)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.innerHTML = ''; }, ms);
}

// ── rendering ─────────────────────────────────────────────────────────

function sidebar() {
  const model = state.model;
  const nav = [
    ['overview', 'Overview', ''],
    ['workflow', 'Workflow', model ? model.ledger.length : ''],
    ['prompts', 'Prompts', model ? model.prompts.audits.length : ''],
    ['fit', 'Model fit (wip, beta)', model ? (model.fit.totals.headroom + model.fit.totals.strained) || '' : ''],
    ['tools', 'Tools', model ? model.tools.totals.tools || '' : ''],
    ['conversations', 'Conversations', model ? int(model.totals.conversations) : ''],
    ['analytics', 'Analytics', model ? model.days.length + 'd' : ''],
  ];
  return `
    <div class="side__brand"><div class="side__mark">II</div><div class="side__name">Agent Costs</div>
      <div class="side__ver">v1.0</div></div>
    <div class="side__group">
      <div class="side__label">explore</div>
      ${nav.map(([key, label, tail]) => `<button class="nav-item${state.screen === key ? ' nav-item--on' : ''}"
        data-act="screen" data-id="${key}">${label}<span class="nav-item__tail">${h(tail)}</span></button>`).join('')}
    </div>
    <div class="side__group">
      <div class="side__label">context</div>
      <div class="stack" style="padding:2px 10px;gap:6px">
        <div style="font-size:12.5px;font-weight:500">${h(model ? model.agentName : state.agentId || '')}</div>
        <div class="row row--wrap" style="gap:5px">
          <span class="badge mono">${h(state.versionLabel || 'any version')}</span>
          <span class="badge mono">${h(branchSummary())}</span>
          <span class="badge mono">${daysBetween(state.from, state.to)}d to ${h(shortDate(state.to))}</span>
        </div>
        <div class="mono small muted">${h((state.keyMask || 'cached data · no key') + ' · ' + state.region)}</div>
      </div>
    </div>
    <div class="side__foot">
      <div class="side__label"${state.screen === 'report' ? ' hidden' : ''}>encoding</div>
      <div class="stack" style="gap:1px;padding:0 2px">
        ${encodingList().map(([key, label]) => `<button class="nav-item${state.encoding === key ? ' nav-item--on' : ''}"
          data-act="encoding" data-id="${key}">${label}</button>`).join('')}
      </div>
      <button class="btn btn--sm" data-act="screen" data-id="report"
        style="margin-top:10px;justify-content:flex-start"
        title="A printable cost report: analytics and the prompt audit, with provenance. No transcripts or conversation ids.">Export report</button>
      <button class="btn btn--ghost btn--sm" data-act="reset" style="margin-top:6px;justify-content:flex-start">Change connection</button>
    </div>`;
}

/**
 * Drop everything downstream of the key.
 *
 * A different key is a different account: its agent ids, branches, versions and
 * cached window have nothing to do with the previous one. Before this, only
 * `set-region` cleared any of it — pasting a replacement key kept the
 * previously selected agent, its branches, its versions, its dependency walk
 * and the built model, and `use-saved-key` only cleared them when the alias
 * happened to carry a *different* region, so switching between two aliases in
 * one region silently kept the old workspace's selection.
 *
 * Clears selection and derived data only. The caller owns region, key mask and
 * api base, because each entry path resolves those differently.
 */
function resetWorkspace() {
  state.agents = [];
  state.agentId = null;
  state.agentQuery = '';
  state.branches = [];
  state.branchIds = [];
  state.branchTotal = 0;
  state.versions = [];
  state.versionId = null;
  state.versionLabel = null;
  state.versionTouched = false;
  state.dependencies = null;
  state.depsLoading = false;
  state.bundle = null;
  state.model = null;
  state.previousSpend = null;
  state.layout = null;
  state.layoutSaved = false;
  state.job = null;
  state.loadError = null;
  state.node = null;
  state.conv = null;
  state.convPage = 1;
  state.ledgerPage = 1;
  state.toolPage = 1;
  state.toolOpen = null;
  // Demo data belongs to the demo region; a key change moves off it.
  state.demoSeeded = false;
  state.cacheOnly = false;
}

/** What is already on disk, so the setup screen can offer it. */
async function loadCacheWindows() {
  try {
    const res = await api.getCache();
    state.cacheWindows = (res.regions || []).flatMap((r) => r.windows || []);
  } catch (e) {
    state.cacheWindows = [];
  }
}

/** Short label for the branch selection, for the sidebar and topbar. */
function branchSummary() {
  const all = state.branches || [];
  const sel = state.branchIds || [];
  if (!all.length) return 'no branches';
  if (sel.length === all.length) return all.length === 1 ? all[0].name : 'all branches';
  if (!sel.length) return 'no branch';
  if (sel.length === 1) {
    const b = all.find((x) => x.id === sel[0]);
    return b ? b.name : sel[0];
  }
  return sel.length + ' branches';
}

function topbar() {
  return `
    <div class="crumbs"><span>${h(state.model ? state.model.agentName : '')}</span><span>/</span>
      <b>${h(SCREENS[state.screen])}</b></div>
    <div class="topbar__right">
      <label class="field"><span class="field__k">from</span>
        <input type="date" value="${h(state.from)}" data-act="set-from"
          style="border:0;background:none;color:var(--ink);font-family:var(--font-mono);font-size:12px"></label>
      <label class="field"><span class="field__k">to</span>
        <input type="date" value="${h(state.to)}" data-act="set-to"
          style="border:0;background:none;color:var(--ink);font-family:var(--font-mono);font-size:12px"></label>
      <span class="badge mono">${state.model ? int(state.model.totals.conversations) : 0} conversations</span>
      <button class="btn btn--sm" data-act="retrieve" ${state.busy ? 'disabled' : ''}>
        ${state.busy ? '<span class="spin"></span> Working' : 'Refresh'}</button>
    </div>`;
}

function warnings() {
  const list = state.model ? state.model.warnings : [];
  if (!list.length) return '';
  return `<div class="note note--warn" style="margin-bottom:16px;display:block">
    <b>Caveats on this window</b>
    <ul style="margin:6px 0 0;padding-left:18px">${list.map((w) => `<li>${h(w)}</li>`).join('')}</ul>
  </div>`;
}

function page() {
  const model = state.model;
  if (!model) return '<div class="empty">No window loaded.</div>';
  const meta = (state.bundle && state.bundle.meta) || {};
  const ctx = {
    ...state,
    rangeLong: longDate(state.from) + ' → ' + longDate(state.to),
    // Provenance for the printed report's cover — a cost figure with no window,
    // region or fetch time behind it cannot be checked by whoever receives it.
    branchLabel: branchSummary(),
    fetchedAt: meta.fetched_at || null,
    keyFingerprint: meta.key_fingerprint || null,
  };
  // The report is its own screen: one long static document, no chrome, printed
  // by the @media print block rather than by a second rendering path.
  if (state.screen === 'report') return renderReport(model, ctx);
  if (state.screen === 'overview') return warnings() + renderOverview(model, ctx);
  if (state.screen === 'prompts') return warnings() + renderPrompts(model, ctx);
  if (state.screen === 'fit') return warnings() + renderFit(model, ctx);
  if (state.screen === 'tools') return warnings() + renderTools(model, ctx);
  if (state.screen === 'conversations') return warnings() + renderConversations(model, ctx);
  if (state.screen === 'analytics') return warnings() + renderAnalytics(model, ctx);
  return warnings() + renderWorkflow(model, ctx);
}

function overlay() {
  if (state.node) return renderNodeDrawer(state.model, state.node);
  if (state.conv) return renderConvDrawer(state.model, state.conv);
  return '';
}

/**
 * Repaint only what the agent filter affects.
 *
 * Typing must not rebuild the search input: recreating it on each keystroke
 * loses focus and caret, resets the container's scroll position, and breaks
 * IME composition and the browser's own undo. So the list, the match count and
 * the compact picker's options are patched in place and nothing else moves.
 */
function patchAgentFilter() {
  const list = document.getElementById('agent-list');
  if (list) list.innerHTML = renderAgentList(state);
  const count = document.getElementById('agent-count');
  if (count) count.textContent = agentCountLabel(state);
  const select = document.getElementById('agent-select');
  if (select) {
    select.innerHTML = renderAgentOptions(state);
    select.value = state.agentId || '';
  }
  // The search label is never rebuilt, so the clear button is toggled here
  // rather than conditionally rendered — otherwise it could never appear.
  const clear = document.getElementById('agent-clear');
  if (clear) clear.hidden = !state.agentQuery;
}

/**
 * Put the viewport back at the top when the view changes.
 *
 * The document is the scroll container — nothing in the shell sets `overflow` —
 * so the browser keeps whatever offset the previous view had. The setup screen
 * is `min-height:100vh` and taller still once branches and dependencies are
 * listed, so reaching Retrieve means scrolling down; the phase then flips to
 * `ready` and the Overview renders with the viewport still halfway down it.
 * Moving between screens had the same effect in the other direction.
 *
 * Keyed on phase and screen **only**. Every other re-render must leave the
 * viewport alone: typing in the agent filter, sorting a column, paging a table,
 * opening or closing a drawer, dragging a node. Yanking the page to the top on
 * any of those would be a worse bug than the one this fixes.
 */
let lastView = null;

function resetScroll() {
  const view = state.phase + ':' + state.screen;
  if (view === lastView) return;
  lastView = view;
  // Guarded: this is a convenience, and `render()` runs inside the boot
  // sequence. A host without `scrollTo` — a test harness, an embedded view —
  // must still get a rendered page rather than a TypeError that takes the whole
  // app down before the first paint.
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    window.scrollTo(0, 0);
  }
}

function render() {
  const setupEl = $('#setup');
  const sideEl = $('#side');
  const mainEl = $('#main');

  if (state.phase === 'setup') {
    setupEl.hidden = false;
    sideEl.hidden = true;
    mainEl.hidden = true;
    setupEl.innerHTML = renderSetup(state);
    $('#overlay').innerHTML = '';
    resetScroll();
    return;
  }

  setupEl.hidden = true;
  setupEl.innerHTML = '';
  sideEl.hidden = false;
  mainEl.hidden = false;
  sideEl.innerHTML = sidebar();
  $('#topbar').innerHTML = topbar();
  $('#page').innerHTML = page();
  $('#overlay').innerHTML = overlay();

  // The page is re-rendered as a string, so canvas behaviour is re-bound each
  // time. Dragging then mutates the DOM directly instead of re-rendering.
  if (state.screen === 'workflow') {
    attachGraph({
      onLayout: persistLayout,
      onOpen: (nodeId) => { state.node = nodeId; state.conv = null; render(); },
    });
  } else {
    detachGraph();
  }

  // After the new markup is in the DOM, so the document has its new height.
  resetScroll();
}

/** The branch a layout belongs to — node sets differ between branches. */
const layoutBranch = () => (state.branchIds.length === 1 ? state.branchIds[0] : null);

let layoutTimer = null;
function persistLayout(nodes, view) {
  // Keep the in-memory view so a re-render (encoding switch, drawer) does not
  // snap the canvas back to where it started.
  state.layout = { ...(state.layout || {}), nodes, view };
  state.layoutSaved = true;
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    api.saveLayout(state.agentId, layoutBranch(), nodes, view).catch((e) => {
      toast('Could not save the layout: ' + e.message);
    });
  }, 500);
}

async function loadLayout() {
  try {
    const saved = await api.getLayout(state.agentId, layoutBranch());
    state.layout = saved && saved.nodes ? saved : null;
    state.layoutSaved = !!(saved && saved.nodes && Object.keys(saved.nodes).length);
  } catch (e) {
    state.layout = null;
    state.layoutSaved = false;
  }
}

// ── data loading ──────────────────────────────────────────────────────

async function refreshSession() {
  try {
    const session = await api.getSession();
    state.hasKey = session.has_key;
    state.keyMask = session.key_mask;
    state.activeAlias = session.active_alias || null;
    state.keyBackend = session.key_backend || 'memory';
    state.regions = session.regions || [];
    state.region = session.region || state.region;
    api.setRegion(state.region);
    state.apiBase = session.api_base || '';
    // Only adopt the demo window when this session is actually in the demo
    // namespace; otherwise it points at an agent the real workspace lacks.
    const demoRegion = session.demo && (session.demo.region || 'demo');
    if (session.demo && !state.agentId && session.region_slug === demoRegion) {
      state.agentId = session.demo.agent_id;
      state.from = session.demo.from;
      state.to = session.demo.to;
      state.preset = null;
    }
    return session;
  } catch (e) {
    return null;
  }
}

async function loadSavedKeys() {
  try {
    const res = await api.getKeys();
    state.savedKeys = res.keys || [];
    state.keyBackend = res.backend || state.keyBackend;
    state.activeAlias = res.active_alias || state.activeAlias;
  } catch (e) {
    state.savedKeys = [];
  }
}

async function loadAgents(refresh) {
  try {
    const res = await api.getAgents(refresh);
    state.agents = (res.data && res.data.agents) || [];
    const known = state.agents.some((a) => a.agent_id === state.agentId);
    if (!known && state.agents.length) {
      state.agentId = state.agents[0].agent_id;
      state.versionId = null;
      state.versionTouched = false;
      state.branchIds = [];
    } else if (!state.agents.length) {
      state.agentId = null;
    }
    if (state.agentId) { await loadBranches(); await loadDependencies(); }
  } catch (e) {
    if (e.status !== 401) state.loadError = { status: e.status, message: e.message };
  }
}

const dayMonth = (unixSecs) => (unixSecs
  ? new Date(unixSecs * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  : '');

/**
 * Load the agent's branches.
 *
 * GET /v1/convai/agents/{id}/branches returns `{results, meta}` — a page of
 * branch objects. It carries NO version identifiers, so versions cannot be
 * enumerated from here (SPEC.md §0 step 2 assumes a `most_recent_versions[]`
 * that this API does not return). Version ids are discovered from the
 * conversations that actually ran them, after the window loads.
 */
/**
 * Resolve the agent's transfer targets, transitively, before any conversation
 * work. A transferred conversation cannot be read without them: node ids repeat
 * across agents, and each transferred node carries its own agent's prompt.
 */
async function loadDependencies() {
  state.dependencies = null;
  if (!state.agentId) return;
  state.depsLoading = true;
  render();
  try {
    state.dependencies = await api.getDependencies(state.agentId);
  } catch (e) {
    state.dependencies = { error: e.message, agents: [], edges: [], problems: [] };
  } finally {
    state.depsLoading = false;
  }
}

async function loadBranches() {
  state.branches = [];
  try {
    const res = await api.getBranches(state.agentId);
    const data = res.data || {};
    const rows = data.results || data.branches || [];

    const declared = rows.map((b) => ({
      id: b.id || b.branch_id,
      name: b.name || b.id,
      description: b.description || '',
      // The root branch — no parent — is the agent's default.
      isDefault: b.parent_branch_id == null,
      parentId: b.parent_branch_id || null,
      livePercent: typeof b.current_live_percentage === 'number' ? b.current_live_percentage : null,
      calls7d: typeof b.calls_7d === 'number' ? b.calls_7d : null,
      lastCommittedAt: b.last_committed_at || null,
      lastCommitted: dayMonth(b.last_committed_at),
      archived: !!b.is_archived,
      draft: !!b.draft_exists,
      merged: !!b.merged_into_branch_id,
    })).filter((b) => b.id);

    // Live traffic first, then recency — the branch you want is usually on top.
    declared.sort((a, b) => (b.livePercent || 0) - (a.livePercent || 0)
      || (b.lastCommittedAt || 0) - (a.lastCommittedAt || 0));
    state.branches = declared;
    state.branchTotal = (data.meta && data.meta.total) || declared.length;

    // Default to every branch: narrowing the window is the user's call, not ours.
    const known = declared.map((b) => b.id);
    const kept = state.branchIds.filter((id) => known.indexOf(id) !== -1);
    state.branchIds = kept.length ? kept : known;
  } catch (e) {
    // No branches access, or nothing cached — an unscoped window still works.
    state.branchIds = [];
  }
  syncVersionPin();
}

/**
 * Versions observed in the loaded window.
 *
 * The API has no list-versions endpoint, so this is the only honest source: a
 * version existed in this window because a conversation ran it. Metadata for
 * each (description, seq number, branch) comes from
 * GET /v1/convai/agents/{id}/versions/{version_id}, which does exist.
 */
async function loadObservedVersions() {
  const seen = new Map();
  for (const conv of (state.model ? state.model.allConversations : [])) {
    if (!conv.version) continue;
    const row = seen.get(conv.version) || { id: conv.version, conversations: 0, branch: conv.branch };
    row.conversations += 1;
    seen.set(conv.version, row);
  }

  // Enrich the versions someone would plausibly pin — the ones carrying traffic.
  // Each is one cached-or-fetched request, so the cap is a first-load cost only;
  // beyond it a version still appears in the picker, labelled by its id suffix.
  const versions = Array.from(seen.values()).sort((a, b) => b.conversations - a.conversations);
  await Promise.all(versions.slice(0, 24).map(async (v) => {
    try {
      const res = await api.getVersion(state.agentId, v.id);
      const meta = res.data || {};
      v.seq = meta.seq_no_in_branch;
      v.description = meta.version_description || '';
      v.branchId = meta.branch_id || v.branch || null;
      v.committedAt = meta.time_committed_secs || null;
      v.parentId = meta.parents && meta.parents.in_branch_parent_id;
    } catch (e) { /* version metadata is an enrichment, never a requirement */ }
  }));

  state.versions = versions.map((v) => {
    const branch = state.branches.find((b) => b.id === v.branchId);
    return {
      id: v.id,
      label: v.seq != null ? 'v' + v.seq : v.id.slice(-6),
      branchId: v.branchId || null,
      branchName: branch ? branch.name : null,
      description: v.description || '',
      committedAt: v.committedAt || null,
      date: dayMonth(v.committedAt),
      conversations: v.conversations,
    };
  });
  syncVersionPin();
}

/** Versions on one branch, newest commit first. */
function versionsOnBranch(branchId) {
  return state.versions
    .filter((v) => v.branchId === branchId)
    .sort((a, b) => (b.committedAt || 0) - (a.committedAt || 0));
}

/**
 * Reconcile the version pin with the branch selection.
 *
 * Branch is the primary selector and version is a refinement inside it, so a
 * pin is only auto-applied when exactly one branch is selected. Pinning one
 * version while several branches are selected would silently exclude the other
 * branches and make the branch picker look inert — which is exactly the bug
 * this replaced. A pin the user set by hand is left alone unless it falls
 * outside the selection entirely.
 */
function syncVersionPin() {
  const sel = state.branchIds;
  const picked = state.versions.find((v) => v.id === state.versionId);

  if (picked && picked.branchId && sel.length && sel.indexOf(picked.branchId) === -1) {
    state.versionId = null;          // the pin is off-branch now — drop it
  } else if (!state.versionTouched) {
    if (sel.length === 1) {
      const onBranch = versionsOnBranch(sel[0]);
      const valid = onBranch.some((v) => v.id === state.versionId);
      state.versionId = valid ? state.versionId : (onBranch.length ? onBranch[0].id : null);
    } else {
      state.versionId = null;        // several branches — no single shape to pin
    }
  }

  const now = state.versions.find((v) => v.id === state.versionId);
  state.versionLabel = now ? now.label : null;
}

/** Spend of a window without building the full model — used for the trend only. */
function quickSpend(bundle) {
  let total = 0;
  for (const detail of bundle.conversations || []) {
    const charging = detail.metadata && detail.metadata.charging && detail.metadata.charging.llm_usage;
    if (charging) { total += usageCost(collectModelUsage(charging)); continue; }
    for (const turn of detail.transcript || []) total += usageCost(collectModelUsage(turn.llm_usage));
  }
  return total;
}

async function loadWindow() {
  // A single selected branch pins the graph to that branch's node set.
  const soleBranch = layoutBranch();
  await loadLayout();
  const bundle = await api.getWindow(state.agentId, state.from, state.to, state.versionId, soleBranch);
  state.bundle = bundle;

  let previousSpend = null;
  const span = daysBetween(state.from, state.to);
  try {
    const prev = await api.getWindow(
      state.agentId, shiftDays(state.from, -span), shiftDays(state.from, -1), state.versionId, soleBranch,
    );
    previousSpend = quickSpend(prev);
  } catch (e) { /* previous window simply is not cached */ }
  state.previousSpend = previousSpend;

  state.model = buildModel(bundle, {
    pinnedVersion: state.versionId,
    branchIds: state.branchIds,
    agentId: state.agentId,
    from: state.from,
    to: state.to,
    previousSpend,
    layout: state.layout,
  });
  if (bundle.missing && bundle.missing.length) {
    state.model.warnings.push(bundle.missing.length
      + ' conversation(s) in the index have no cached detail and are excluded. Run a sync to fill them.');
  }
  if (bundle.meta && bundle.meta.stale_workspace) {
    state.model.warnings.push('The cache was written with a different API key than the one held now — it may be from another workspace.');
  }
  state.phase = 'ready';
  // A fresh window invalidates any page position in either table.
  state.convPage = 1;
  state.ledgerPage = 1;
  state.toolPage = 1;
  await loadObservedVersions();
}

async function pollSync(jobId) {
  for (;;) {
    const job = await api.syncStatus(jobId);
    state.job = job;
    render();
    if (job.state === 'done' || job.state === 'error') return job;
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function retrieve() {
  if (!state.agentId || state.busy) return;
  if (state.branches.length && !state.branchIds.length) {
    state.loadError = { status: '', message: 'Select at least one branch to pull data from.' };
    state.phase = 'setup';
    render();
    return;
  }
  state.busy = true;
  state.loadError = null;
  state.node = null;
  state.conv = null;
  render();

  try {
    // `cacheOnly` is the user's explicit "do not call the API". Without it a
    // held key always syncs, which is the whole reason a window already on disk
    // could not simply be opened.
    if (state.hasKey && !state.cacheOnly) {
      const job = await api.startSync(state.agentId, state.from, state.to, false, state.branchIds);
      const finished = await pollSync(job.job_id);
      if (finished.state === 'error') {
        state.loadError = { status: '', message: finished.message };
        state.phase = 'setup';
        return;
      }
      await loadBranches();
    }
    await loadWindow();
    state.job = null;
  } catch (e) {
    state.loadError = { status: e.status, message: e.message };
    if (e.status === 409) {
      state.loadError.message = (state.hasKey && !state.cacheOnly)
        ? e.message
        : 'This window is not on disk. Untick “cached files only” and connect a key to fetch it, '
          + 'or pick one of the cached windows listed in step 1.';
    }
    state.phase = 'setup';
  } finally {
    state.busy = false;
    render();
  }
}

// ── actions ───────────────────────────────────────────────────────────

const actions = {
  'toggle-wizard': () => { state.wizard = state.wizard === 'stepped' ? 'compact' : 'stepped'; },

  'set-key': (el) => { state.apiKeyDraft = el.value; return false; },

  // Returns false: no full re-render, so the input the user is typing in survives.
  'agent-search': (el) => { state.agentQuery = el.value; patchAgentFilter(); return false; },
  'agent-search-clear': () => {
    state.agentQuery = '';
    const input = document.querySelector('[data-act="agent-search"]');
    if (input) { input.value = ''; input.focus(); }
    patchAgentFilter();
    return false;
  },

  'set-alias': (el) => { state.aliasDraft = el.value; return false; },
  'pick-saved-key': (el) => { state.aliasPick = el.value || null; },

  'save-key': async () => {
    state.keyError = null;
    const alias = (state.aliasDraft || '').trim();
    if (!alias) { state.keyError = { message: 'Give the key an alias first.' }; return; }
    state.busy = true; render();
    try {
      const res = await api.saveKey(alias, (state.apiKeyDraft || '').trim(), state.region);
      // Saving also activates the key, so the same reset applies.
      resetWorkspace();
      state.savedKeys = res.keys || [];
      state.keyBackend = res.backend || state.keyBackend;
      state.activeAlias = alias;
      state.apiKeyDraft = '';
      state.hasKey = true;
      await refreshSession();
      await loadAgents(true);
      toast(`Key saved as “${alias}” in ${state.keyBackend === 'memory' ? 'process memory' : 'the OS keychain'}.`);
    } catch (e) {
      state.keyError = { status: e.status, message: e.message };
    } finally { state.busy = false; }
  },

  'use-saved-key': async () => {
    const alias = (state.aliasPick || state.activeAlias || '').trim();
    if (!alias) return;
    state.keyError = null;
    state.busy = true; render();
    try {
      const res = await api.activateKey(alias);
      // Unconditionally: two aliases in the *same* region are still two
      // accounts with two sets of agent ids. Gating this on a region change
      // kept the previous selection whenever the regions happened to match.
      resetWorkspace();
      state.activeAlias = alias;
      state.aliasPick = alias;
      state.keyMask = res.key_mask;
      state.hasKey = true;
      // A saved key carries its own region: switching key switches workspace.
      if (res.region && res.region !== state.region) {
        state.region = res.region;
        api.setRegion(state.region);
      }
      state.apiBase = res.api_base || state.apiBase;
      await loadAgents(true);
      toast(`Using “${alias}” · ${res.region} · ${res.key_mask}`);
    } catch (e) {
      state.keyError = { status: e.status, message: e.message };
    } finally { state.busy = false; }
  },

  'forget-saved-key': async () => {
    const alias = (state.aliasPick || state.activeAlias || '').trim();
    if (!alias) return;
    try {
      const res = await api.forgetKey(alias);
      state.savedKeys = res.keys || [];
      if (state.activeAlias === alias) state.activeAlias = null;
      // Clears the selection, not the save row's alias input.
      state.aliasPick = null;
      toast(`Forgot “${alias}”.`);
    } catch (e) {
      state.keyError = { status: e.status, message: e.message };
    }
  },

  'set-region': async (el) => {
    if (el.dataset.id === state.region) return;
    // A different residency is a different account: nothing downstream carries over.
    state.region = el.dataset.id;
    api.setRegion(state.region);
    const picked = (state.regions || []).find((r) => r.id === state.region);
    state.apiBase = picked ? picked.base : '';
    state.hasKey = false;
    state.keyMask = null;
    state.keyError = null;
    state.loadError = null;
    state.activeAlias = null;
    state.aliasPick = null;
    // Was an inline list that had drifted: it never cleared the dependency walk
    // or the saved layout.
    resetWorkspace();
    await refreshSession();
    await loadAgents();
  },

  'submit-key': async () => {
    state.keyError = null;
    if (!state.apiKeyDraft.trim()) { state.keyError = { message: 'Paste a key first.' }; return; }
    state.busy = true; render();
    try {
      const res = await api.postKey(state.apiKeyDraft.trim(), state.region);
      // The key just changed, so nothing the previous one selected still applies.
      resetWorkspace();
      state.activeAlias = null;
      state.aliasPick = null;
      state.hasKey = true;
      state.keyMask = res.key_mask;
      state.region = res.region || state.region;
      api.setRegion(state.region);
      state.apiBase = res.api_base || state.apiBase;
      state.apiKeyDraft = '';
      await loadSavedKeys();
      await loadAgents(true);
      toast(`Key accepted for ${state.region} (${state.apiBase}) and held server-side.`);
    } catch (e) {
      state.keyError = { status: e.status, message: e.message };
      state.hasKey = false;
    } finally { state.busy = false; }
  },

  'seed-demo': async () => {
    state.busy = true; render();
    try {
      const res = await api.seedDemo(14, 44);
      state.demoSeeded = true;
      state.agentId = res.agent_id;
      state.from = res.from;
      state.to = res.to;
      state.preset = null;
      state.agents = [];
      state.branchIds = [];
      state.versionId = null;
      state.versionTouched = false;
      await loadAgents();
      toast(`Demo window written: ${res.conversations} conversations across ${state.branches.length} branch`
        + `${state.branches.length === 1 ? '' : 'es'} in ${res.elapsed_secs}s. Pick your branches, then Retrieve.`);
    } catch (e) {
      state.loadError = { status: e.status, message: e.message };
    } finally { state.busy = false; }
  },

  // Open a window straight from disk: it already carries its agent and dates,
  // so there is nothing left to choose.
  'load-cached': async (el) => {
    const w = (state.cacheWindows || []).find((x) => x.key === el.dataset.id);
    if (!w || state.busy) return;
    resetWorkspace();
    state.cacheOnly = true;
    state.loadError = null;
    if (w.region !== state.region) {
      state.region = w.region;
      api.setRegion(state.region);
    }
    state.agentId = w.agent_id;
    state.from = w.from;
    state.to = w.to;
    state.preset = null;
    state.busy = true; render();
    try {
      await loadAgents();
      await loadBranches();
      await loadDependencies();
    } catch (e) { /* the window read below is what matters */ }
    state.busy = false;
    await retrieve();
  },

  'toggle-cache-only': () => { state.cacheOnly = !state.cacheOnly; },

  'reload-agents': async () => { state.busy = true; render(); await loadAgents(true); state.busy = false; },

  'pick-agent': async (el) => {
    state.agentId = el.dataset.id; state.versionId = null; state.versionTouched = false;
    state.branchIds = []; await loadBranches(); await loadDependencies();
  },
  'pick-agent-select': async (el) => {
    state.agentId = el.value; state.versionId = null; state.versionTouched = false;
    state.branchIds = []; await loadBranches(); await loadDependencies();
  },
  'reload-deps': async () => { await loadDependencies(); },
  'pick-version': (el) => {
    state.versionId = el.dataset.id || null; state.versionTouched = true; syncVersionPin();
  },
  'pick-version-select': (el) => {
    state.versionId = el.value || null; state.versionTouched = true; syncVersionPin();
  },

  // The same pin, changed from an analysis header after the window is loaded.
  // Version scope is applied in buildModel, not by the fetch, so this re-derives
  // from the conversations already in hand — no sync, no request. The observed
  // version list is built from model.allConversations, which is never narrowed
  // by the pin, so switching back to "any version" always remains possible.
  'pick-version-window': (el) => {
    state.versionId = el.value || null;
    state.versionTouched = true;
    // An open drawer may be for a node that this version never ran.
    state.node = null;
    state.conv = null;
    // The pin reorders and resizes both lists; page 1 is the only safe landing.
    state.convPage = 1;
    state.ledgerPage = 1;
    syncVersionPin();
    rebuild();
  },

  'toggle-branch': (el) => {
    const id = el.dataset.id;
    const at = state.branchIds.indexOf(id);
    if (at === -1) state.branchIds = state.branchIds.concat([id]);
    else state.branchIds = state.branchIds.filter((x) => x !== id);
    syncVersionPin();
  },
  'branches-all': () => {
    const all = state.branches.map((b) => b.id);
    state.branchIds = state.branchIds.length === all.length ? [] : all;
    syncVersionPin();
  },

  'set-from': (el) => { if (el.value) { state.from = el.value; state.preset = null; } },
  'set-to': (el) => { if (el.value) { state.to = el.value; state.preset = null; } },
  'preset': (el) => {
    const n = Number(el.dataset.n);
    state.preset = el.dataset.label;
    state.to = today();
    state.from = shiftDays(state.to, -(n - 1));
  },

  'retrieve': () => retrieve(),
  'reset': () => {
    state.phase = 'setup'; state.job = null; state.node = null; state.conv = null;
    state.screen = 'overview';
  },

  'screen': (el) => { state.screen = el.dataset.id; state.node = null; state.conv = null; },

  // Hand off to the browser's own PDF engine. No library, no headless browser,
  // and the figures are the ones already on screen.
  'print-report': () => { window.print(); return false; },
  'encoding': (el) => { state.encoding = el.dataset.id; },
  'analytics-view': (el) => { state.analyticsView = el.dataset.id; },
  'conv-filter': (el) => { state.convFilter = el.dataset.id; state.convPage = 1; },

  // Click a header to sort; click the active header again to flip direction.
  'prompt-sort': (el) => {
    const key = el.dataset.id;
    const cur = state.promptSort;
    state.promptSort = (cur && cur.key === key)
      ? { key, dir: cur.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: key === 'label' || key === 'model' ? 'asc' : 'desc' };
  },

  // Re-sorting reorders the whole list, so page 1 is the only page that still
  // means anything afterwards.
  'conv-sort': (el) => {
    state.convSort = nextSort(CONV_COLUMNS, state.convSort, el.dataset.id);
    state.convPage = 1;
  },
  'conv-page': (el) => { state.convPage = Number(el.dataset.id) || 1; },
  'ledger-sort': (el) => {
    state.ledgerSort = nextSort(LEDGER_COLUMNS, state.ledgerSort, el.dataset.id);
    state.ledgerPage = 1;
  },
  'ledger-page': (el) => { state.ledgerPage = Number(el.dataset.id) || 1; },
  'tool-sort': (el) => {
    state.toolSort = nextSort(TOOL_COLUMNS, state.toolSort, el.dataset.id);
    state.toolPage = 1;
  },
  'tool-page': (el) => { state.toolPage = Number(el.dataset.id) || 1; },
  'tool-open': (el) => { state.toolOpen = state.toolOpen === el.dataset.id ? null : el.dataset.id; },

  'fit-toggle': (el) => { state.fitOpen = state.fitOpen === el.dataset.id ? null : el.dataset.id; },
  'fit-agent': (el) => { state.fitAgent = el.dataset.id || null; state.fitOpen = null; },

  'layout-reset': async () => {
    await api.resetLayout(state.agentId, layoutBranch());
    state.layout = null;
    state.layoutSaved = false;
    rebuild();
    toast('Positions reset to the agent graph.');
  },

  'open-node': (el) => { state.node = el.dataset.id; state.conv = null; },
  'open-conv': (el) => { state.conv = el.dataset.id; state.node = null; },
  'close-drawer': () => { state.node = null; state.conv = null; },
};

function dispatch(event, el) {
  const act = el.dataset.act;
  const fn = actions[act];
  if (!fn) return;
  const result = fn(el, event);
  if (result === false) return;               // input handlers that must not re-render
  if (result && typeof result.then === 'function') result.then(render).catch((e) => {
    state.loadError = { status: e.status, message: e.message };
    render();
  });
  else render();
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
  event.preventDefault();
  dispatch(event, el);
});

document.addEventListener('change', (event) => {
  const el = event.target.closest('[data-act]');
  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'SELECT')) return;
  dispatch(event, el);
});

document.addEventListener('input', (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'set-key') { state.apiKeyDraft = el.value; return; }
  if (el.dataset.act === 'agent-search') dispatch(event, el);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (state.node || state.conv)) {
    state.node = null;
    state.conv = null;
    render();
  }
});

// ── boot ──────────────────────────────────────────────────────────────

(async function boot() {
  render();
  await refreshSession();
  await loadSavedKeys();
  await loadCacheWindows();
  // Only once something is connected. `/api/agents` is a cache read, so calling
  // it cold returns whatever a previous sync left on disk and pulls a whole
  // agent list into memory before the user has chosen anything. Every path that
  // connects a key calls loadAgents itself.
  if (state.hasKey) await loadAgents();
  render();
  // A real tokenizer improves the config-side estimates on the Prompts screen.
  upgrade().then((ok) => { if (ok && state.phase === 'ready') { rebuild(); render(); } });
})();

function rebuild() {
  if (!state.bundle) return;
  state.model = buildModel(state.bundle, {
    pinnedVersion: state.versionId,
    branchIds: state.branchIds,
    agentId: state.agentId,
    from: state.from,
    to: state.to,
    previousSpend: state.previousSpend,
    layout: state.layout,
  });
}
