// Setup screen — SPEC §1.
// The key is forwarded to the backend and never persisted client-side.

import { h, daysBetween, shortDate } from '../util.js';

const chipStyle = (on) => (on
  ? 'background:var(--ink);color:var(--ink-inv);border-color:var(--ink)'
  : 'background:var(--bg-2);color:var(--ink-2);border-color:var(--line)');

/**
 * Data residency. Each region is an isolated environment: a different host, a
 * different account, a different workspace, and a key that only works against
 * its own region. Picking the wrong one is the most likely cause of a 401, so
 * the host in use is always shown.
 */
function regionPicker(state) {
  const regions = state.regions || [];
  if (!regions.length) return '';
  const current = regions.find((r) => r.id === state.region);
  return `
    <div class="row row--wrap" style="gap:8px">
      <span class="field__k">residency</span>
      ${regions.map((r) => `<button class="chip" data-act="set-region" data-id="${h(r.id)}"
        style="${chipStyle(r.id === state.region)}" title="${h(r.base)}">${h(r.label)}</button>`).join('')}
    </div>
    <div class="mono small muted" style="margin-top:6px">${h(current ? current.base : '')}</div>`;
}

/**
 * Saved keys, by alias. Values live in the OS keychain server-side; the browser
 * only ever sees the alias, its region and a masked hint.
 */
function keyPicker(state) {
  const keys = state.savedKeys || [];
  const memoryOnly = state.keyBackend === 'memory';
  if (!keys.length) {
    return `<div class="small muted" style="margin-top:8px">
      No saved keys yet. Connect one below, give it an alias, and it is stored in
      ${memoryOnly ? 'this process only (no keychain on this platform)' : 'your OS keychain'}
      so you can pick it from here next time.</div>`;
  }
  return `
    <div class="row row--wrap" style="gap:8px;margin-bottom:10px">
      <span class="field__k">saved key</span>
      <select class="field" data-act="pick-saved-key" style="flex:1 1 220px;height:30px">
        <option value="">— choose an alias —</option>
        ${keys.map((k) => `<option value="${h(k.alias)}" ${k.alias === state.activeAlias ? 'selected' : ''}>
          ${h(k.alias)} · ${h(k.region || '?')} · ${h(k.mask || '')}${k.available ? '' : ' (missing)'}
        </option>`).join('')}
      </select>
      <button class="btn btn--sm" data-act="use-saved-key" ${state.aliasDraft || state.activeAlias ? '' : 'disabled'}>Use</button>
      <button class="btn btn--ghost btn--sm" data-act="forget-saved-key">Forget</button>
    </div>
    ${memoryOnly ? `<div class="note note--warn" style="margin-bottom:10px"><span>No OS keychain here —
      saved keys last only until the server restarts.</span></div>` : ''}`;
}

function keySaveRow(state) {
  const can = (state.apiKeyDraft && state.apiKeyDraft.trim()) || state.hasKey;
  return `
    <div class="row row--wrap" style="gap:8px;margin-top:8px">
      <label class="field" style="flex:1 1 200px">
        <span class="field__k">alias</span>
        <input data-act="set-alias" value="${h(state.aliasDraft || '')}" spellcheck="false"
               placeholder="e.g. eu-prod" autocomplete="off"
               style="flex:1;min-width:0;border:0;background:none;color:var(--ink);font-size:12.5px">
      </label>
      <button class="btn btn--sm" data-act="save-key" ${can ? '' : 'disabled'}>
        Save ${state.hasKey && !(state.apiKeyDraft || '').trim() ? 'current key' : 'key'} under this alias</button>
    </div>
    <div class="small muted" style="margin-top:6px">
      Stored in ${state.keyBackend === 'memory' ? 'process memory' : 'your OS keychain'}, never in the
      browser and never in <span class="mono">data/</span>. Only the alias and a masked hint reach this page.
    </div>`;
}

function branchMeta(b) {
  const bits = [];
  if (b.isDefault) bits.push('default');
  if (b.livePercent != null && b.livePercent > 0) bits.push(b.livePercent.toFixed(0) + '% live');
  if (b.calls7d != null) bits.push(b.calls7d.toLocaleString() + ' calls/7d');
  if (b.lastCommitted) bits.push(b.lastCommitted);
  if (b.draft) bits.push('draft');
  if (b.merged) bits.push('merged');
  return bits.join(' · ');
}

/**
 * Branch picker. Multi-select, because a workspace can run several branches of
 * the same agent over one window and the answer to "which of these am I costing"
 * is the user's, not ours. All branches start selected so nothing is dropped
 * without the user saying so.
 */
/**
 * Transfer targets. Shown as soon as an agent is picked, because the reachable
 * set determines what the conversation data can even be read against.
 */
function dependencyCard(state) {
  if (state.depsLoading) {
    return `<div class="small muted" style="padding-top:2px"><span class="spin"></span>
      Resolving transfer targets…</div>`;
  }
  const deps = state.dependencies;
  if (!deps) return '';
  if (deps.error) {
    return `<div class="note note--warn" style="margin-top:6px"><span>Could not resolve transfer
      targets: ${h(deps.error)}</span></div>`;
  }
  const others = (deps.agents || []).filter((a) => !a.is_root);
  if (!others.length && !(deps.problems || []).length) {
    return `<div class="small muted" style="padding-top:2px">No transfer nodes — this agent handles
      conversations on its own.</div>`;
  }
  return `
    <div class="row row--wrap" style="gap:8px;padding-top:2px">
      <span class="field__k">transfers to</span>
      ${others.map((a) => `<span class="chip" title="${h(a.agent_id)}">
        ${h(a.name || a.agent_id)}<span class="mono small" style="opacity:.6">${a.nodes} nodes</span>
      </span>`).join('') || '<span class="small muted">none resolved</span>'}
      <button class="btn btn--ghost btn--sm" data-act="reload-deps">Re-resolve</button>
    </div>
    <div class="small muted">
      ${others.length ? `${others.length} other agent${others.length === 1 ? '' : 's'} pulled in, `
        + `${(deps.edges || []).length} transfer edge${(deps.edges || []).length === 1 ? '' : 's'}`
        + `${deps.tools_fetched ? `, ${deps.tools_fetched} extra tool schema${deps.tools_fetched === 1 ? '' : 's'}` : ''}. `
        : ''}Their definitions are needed to name transferred nodes and audit them against the right
      prompt — node ids repeat across agents.
    </div>
    ${(deps.problems || []).length ? `<div class="note note--warn" style="margin-top:6px"><span>
      ${deps.problems.length} transfer target${deps.problems.length === 1 ? '' : 's'} could not be fetched
      (${deps.problems.map((p) => h((p.agent_id || '').slice(-8) + ': ' + p.error)).join('; ')}).
      Their nodes will show ids rather than names.</span></div>` : ''}`;
}

function branchChips(state) {
  const branches = state.branches || [];
  if (!branches.length) {
    return `<div class="small muted" style="padding-top:2px">
      No branches returned for this agent — the whole window will be costed together.</div>`;
  }
  const selected = state.branchIds || [];
  const all = selected.length === branches.length;
  return `
    <div class="row row--wrap" style="gap:8px;padding-top:2px">
      <span class="field__k">branches</span>
      ${branches.map((b) => {
        const on = selected.indexOf(b.id) !== -1;
        return `<button class="chip" data-act="toggle-branch" data-id="${h(b.id)}" style="${chipStyle(on)}"
          title="${h(b.description || b.id)}">
          ${on ? '✓ ' : ''}${h(b.name)}
          <span class="mono small" style="opacity:.6">${h(branchMeta(b))}</span>
        </button>`;
      }).join('')}
      ${branches.length > 1 ? `<button class="chip" data-act="branches-all" style="${chipStyle(all)}">
        ${all ? '✓ ' : ''}all<span class="mono small" style="opacity:.6">${branches.length}</span>
      </button>` : ''}
    </div>
    ${selected.length ? '' : `<div class="note note--warn" style="margin-top:6px">
      <span>No branch selected — pick at least one to pull data from.</span></div>`}`;
}

/**
 * Versions cannot be listed before retrieval: the branches response carries no
 * version ids and the API has no list-versions endpoint. What is offered here
 * are the versions actually observed in the last window that was loaded.
 */
function versionChips(state) {
  const selected = state.branchIds || [];
  const versions = (state.versions || []).filter(
    (v) => !v.branchId || !selected.length || selected.indexOf(v.branchId) !== -1,
  );
  if (!versions.length) {
    return `<div class="small muted" style="padding-top:2px">
      Versions are not listable from the API — they appear here once a window is retrieved,
      taken from the conversations that ran them.</div>`;
  }
  return `
    <div class="row row--wrap" style="gap:8px;padding-top:2px">
      <span class="field__k">version</span>
      ${versions.map((v) => `
        <button class="chip" data-act="pick-version" data-id="${h(v.id)}" style="${chipStyle(v.id === state.versionId)}"
          title="${h(v.description || v.id)}">
          ${h(v.label)}<span class="mono small" style="opacity:.6">${h(
            (v.branchName && state.branches.length > 1 ? v.branchName + ' · ' : '')
            + (v.conversations ? v.conversations + ' convs' : v.date))}</span>
        </button>`).join('')}
      <button class="chip" data-act="pick-version" data-id="" style="${chipStyle(!state.versionId)}">
        any<span class="mono small" style="opacity:.6">no pin</span>
      </button>
    </div>
    <div class="small muted">Observed in the last retrieved window — the API exposes no list-versions
      endpoint, so these are the versions that actually ran.</div>`;
}

const AGENT_PAGE = 40;

/** Match on name and id, all words must appear. */
export function matchAgents(agents, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return agents;
  return agents.filter((a) => {
    const hay = ((a.name || '') + ' ' + (a.agent_id || '')).toLowerCase();
    return words.every((w) => hay.indexOf(w) !== -1);
  });
}

export function agentCountLabel(state) {
  const total = state.agents.length;
  if (!state.agentQuery) return String(total);
  return matchAgents(state.agents, state.agentQuery).length + '/' + total;
}

function agentSearch(state, compact) {
  const total = state.agents.length;
  if (total <= 1) return '';
  return `
    <label class="field" style="${compact ? 'flex:1 1 200px;height:30px' : 'width:100%'}">
      <span class="field__k">find</span>
      <input data-act="agent-search" value="${h(state.agentQuery || '')}" spellcheck="false"
             placeholder="name or agent_id" autocomplete="off"
             style="flex:1;min-width:0;border:0;background:none;color:var(--ink);font-size:12.5px">
      <span class="mono small muted" id="agent-count" style="flex:none">${agentCountLabel(state)}</span>
      <button class="chip__x" id="agent-clear" data-act="agent-search-clear" title="Clear"
              ${state.agentQuery ? '' : 'hidden'}>×</button>
    </label>`;
}

function agentCards(state) {
  return agentSearch(state, false)
    + `<div id="agent-list" class="stack" style="gap:10px">${renderAgentList(state)}</div>`;
}

/** Just the filtered cards — patched in place while the search input keeps focus. */
export function renderAgentList(state) {
  if (!state.agents.length) {
    return `<div class="empty">No agents loaded yet. Connect a key, or seed the demo window below.</div>`;
  }

  const matches = matchAgents(state.agents, state.agentQuery);
  const shown = matches.slice(0, AGENT_PAGE);
  // Keep the selected agent on screen even when the query excludes it, so it is
  // never a mystery which agent Retrieve will actually use. It is pinned above
  // the results rather than counted as one, so "no match" still gets said.
  const selected = state.agents.find((a) => a.agent_id === state.agentId);
  const pinned = selected && !shown.some((a) => a.agent_id === selected.agent_id) ? selected : null;

  const card = (a) => {
    const on = a.agent_id === state.agentId;
    const calls = typeof a.last_7_day_call_count === 'number' ? a.last_7_day_call_count : null;
    return `
    <button data-act="pick-agent" data-id="${h(a.agent_id)}" class="card"
      style="display:flex;align-items:center;gap:12px;padding:10px 12px;text-align:left;
             background:${on ? 'var(--bg-3)' : 'var(--bg-2)'};border-color:${on ? 'var(--ink)' : 'var(--line)'}">
      <div class="pm pm--el pm--lg">${h((a.name || a.agent_id).slice(0, 2).toUpperCase())}</div>
      <div style="min-width:0;flex:1">
        <div style="font-size:13.5px;font-weight:500">${h(a.name || a.agent_id)}</div>
        <div class="mono small muted">${h(a.agent_id)}${
          calls != null ? ' · ' + calls.toLocaleString() + ' calls/7d' : ''}</div>
      </div>
      ${on ? '<span class="badge badge--solid mono" style="flex:none">selected</span>' : ''}
    </button>`;
  };

  const body = shown.length
    ? shown.map(card).join('')
    : `<div class="empty">No agent matches “${h(state.agentQuery)}”.</div>`;

  const more = matches.length - shown.length;
  return (pinned ? card(pinned) + '<div class="small muted" style="margin-top:-4px">'
        + 'Still selected, though it is outside the current search.</div>' : '')
    + body + (more > 0
    ? `<div class="small muted">${more.toLocaleString()} more match${more === 1 ? '' : 'es'} —
        narrow the search to see ${more === 1 ? 'it' : 'them'}.</div>`
    : '');
}

/** Options for the compact picker, filtered by the same query. */
export function renderAgentOptions(state) {
  const matches = matchAgents(state.agents, state.agentQuery);
  const selected = state.agents.find((a) => a.agent_id === state.agentId);
  const rows = selected && !matches.some((a) => a.agent_id === selected.agent_id)
    ? [selected].concat(matches) : matches;
  if (!rows.length) return '<option value="">no match</option>';
  return rows.slice(0, 200).map((a) => `<option value="${h(a.agent_id)}"
    ${a.agent_id === state.agentId ? 'selected' : ''}>${h(a.name || a.agent_id)}</option>`).join('');
}

function windowCard(state) {
  const presets = [['24h', 1], ['7d', 7], ['14d', 14], ['30d', 30]];
  return `
    <div class="row row--wrap">
      <label class="field"><span class="field__k">from</span>
        <input type="date" value="${h(state.from)}" data-act="set-from"
               style="border:0;background:none;color:var(--ink);font-family:var(--font-mono);font-size:12px"></label>
      <label class="field"><span class="field__k">to</span>
        <input type="date" value="${h(state.to)}" data-act="set-to"
               style="border:0;background:none;color:var(--ink);font-family:var(--font-mono);font-size:12px"></label>
      <div class="seg">
        ${presets.map(([label, n]) => `<button data-act="preset" data-n="${n}" data-label="${label}"
          aria-pressed="${state.preset === label}">${label}</button>`).join('')}
      </div>
    </div>`;
}

function progressPanel(state) {
  const job = state.job;
  if (!job) return '';
  const pct = job.total ? Math.round((job.done / job.total) * 100) : (job.state === 'listing' ? 6 : 0);
  const tone = job.state === 'error' ? 'note--warn' : 'note--info';
  return `
    <div class="note ${tone}" style="margin-top:14px;display:block">
      <div class="row" style="gap:8px">
        ${job.state === 'done' || job.state === 'error' ? '' : '<span class="spin"></span>'}
        <b>${h(job.state)}</b>
        <span>${h(job.message || '')}</span>
      </div>
      <div class="progress" style="margin-top:9px"><i style="width:${pct}%"></i></div>
      <div class="row mono small" style="margin-top:6px;gap:10px;color:var(--ink-2)">
        <span>${job.done}/${job.total || job.listed || 0} details</span>
        <span>${job.fetched} fetched</span>
        <span>${job.cached} already immutable</span>
        ${job.errors && job.errors.length ? `<span style="color:var(--warn)">${job.errors.length} errors</span>` : ''}
      </div>
      ${job.errors && job.errors.length ? `<div class="mono small" style="margin-top:6px;color:var(--warn)">
        ${h(job.errors[0].subject)}: ${h(job.errors[0].message)}</div>` : ''}
    </div>`;
}

function readyNote(state) {
  const days = daysBetween(state.from, state.to);
  const agent = state.agents.find((a) => a.agent_id === state.agentId);
  if (!state.agentId) return 'Pick an agent to cost.';
  const branches = state.branches || [];
  const selected = state.branchIds || [];
  if (branches.length && !selected.length) return 'Select at least one branch to pull data from.';
  const version = state.versions.find((v) => v.id === state.versionId);
  const branchNote = !branches.length ? ''
    : selected.length === branches.length
      ? ' · all ' + branches.length + ' branch' + (branches.length === 1 ? '' : 'es')
      : ' · branch ' + selected.map((id) => {
        const b = branches.find((x) => x.id === id);
        return b ? b.name : id;
      }).join(', ');
  return 'Ready — ' + (agent ? agent.name || agent.agent_id : state.agentId)
    + (version ? ' ' + version.label : ' (no version pin)')
    + branchNote
    + ' over ' + days + ' days, ' + shortDate(state.from) + ' → ' + shortDate(state.to) + '.'
    + (state.hasKey ? '' : ' No key held: only an already-cached window can be opened.');
}

export function renderSetup(state) {
  const brand = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:26px">
      <div class="side__mark" style="width:26px;height:26px;font-size:11px">II</div>
      <div>
        <div style="font-family:var(--font-brand);font-size:20px;letter-spacing:-.02em">Agent Cost Explorer</div>
        <div class="mono small muted">elevenlabs · conversational ai · token ledger</div>
      </div>
    </div>`;

  const stepped = `
    <div class="stack">
      <div class="card">
        <div class="card__head">
          <div class="badge badge--solid mono">1</div><h3>Connect</h3>
          <div class="sub">xi-api-key, kept in this session only</div>
          <div class="right">${state.hasKey
            ? `<span class="badge badge--ok mono"><i class="dot"></i>${h(state.keyMask || 'valid')}</span>`
            : ''}</div>
        </div>
        <div class="card__body">
          ${regionPicker(state)}
          <div style="margin-top:10px">${keyPicker(state)}</div>
          <div class="row">
            <input class="keyinput" id="apikey" type="password" value="${h(state.apiKeyDraft)}" data-act="set-key"
                   placeholder="sk_••••••••••••••••••••••••••••" spellcheck="false" autocomplete="off" style="flex:1">
            <button class="btn" data-act="submit-key">${state.hasKey ? 'Replace' : 'Connect'}</button>
            <button class="btn btn--ghost" data-act="seed-demo">Use demo data</button>
          </div>
          <div class="small muted" style="margin-top:8px">
            Sent to the backend only; never stored in the browser and never written into the JSON store.
            Read scope: <span class="mono">convai_read</span>. A residency environment is a separate
            account with its own key and its own workspace, so the cache is kept separate per region.
          </div>
          ${keySaveRow(state)}
          ${state.keyError ? `<div class="note note--warn" style="margin-top:10px"><b>${h(state.keyError.status || '')}</b>
            <span>${h(state.keyError.message)}</span></div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card__head">
          <div class="badge badge--solid mono">2</div><h3>Agent, branch &amp; version</h3>
          <div class="sub">pinned so costs map to one graph</div>
          <div class="right"><button class="btn btn--ghost btn--sm" data-act="reload-agents">Reload</button></div>
        </div>
        <div class="card__body stack" style="gap:10px">
          ${agentCards(state)}
          ${dependencyCard(state)}
          ${branchChips(state)}
          ${versionChips(state)}
        </div>
      </div>

      <div class="card">
        <div class="card__head">
          <div class="badge badge--solid mono">3</div><h3>Window</h3>
          <div class="sub">conversations to cost</div>
        </div>
        <div class="card__body">${windowCard(state)}</div>
      </div>

      <div class="row row--wrap" style="margin-top:4px">
        <div class="small muted" style="flex:1 1 240px">${h(readyNote(state))}</div>
        <button class="btn btn--ghost" data-act="toggle-wizard">Compact entry</button>
        <button class="btn btn--primary" data-act="retrieve" style="height:34px" ${state.agentId ? '' : 'disabled'}>
          Retrieve agent &amp; conversations</button>
      </div>
    </div>`;

  const compact = `
    <div class="card">
      <div class="card__head"><h3>Connect</h3><div class="sub">one line, then go</div>
        <div class="right"><button class="btn btn--ghost btn--sm" data-act="toggle-wizard">Stepped entry</button></div>
      </div>
      <div class="card__body stack" style="gap:10px">
        ${regionPicker(state)}
        ${keyPicker(state)}
        ${dependencyCard(state)}
        <div class="row row--wrap" style="gap:8px">
          ${agentSearch(state, true)}
        </div>
        <div class="row row--wrap" style="gap:8px">
          <input class="keyinput" type="password" value="${h(state.apiKeyDraft)}" data-act="set-key"
                 placeholder="xi-api-key" spellcheck="false" autocomplete="off" style="flex:2 1 220px;height:30px">
          <button class="btn btn--sm" data-act="submit-key">Connect</button>
          <select class="field" id="agent-select" data-act="pick-agent-select" style="flex:1 1 180px;height:30px">
            ${renderAgentOptions(state)}
          </select>
          <select class="field" data-act="pick-version-select" style="height:30px">
            <option value="">any version</option>
            ${state.versions
              .filter((v) => !v.branchId || !(state.branchIds || []).length
                || (state.branchIds || []).indexOf(v.branchId) !== -1)
              .map((v) => `<option value="${h(v.id)}" ${v.id === state.versionId ? 'selected' : ''}>
              ${h(v.label)} · ${h(v.date)}</option>`).join('')}
          </select>
        </div>
        ${branchChips(state)}
        <div class="row row--wrap" style="gap:8px">
          ${windowCard(state)}
          <div class="spacer"></div>
          <button class="btn btn--primary" data-act="retrieve" ${state.agentId ? '' : 'disabled'}>Retrieve</button>
        </div>
        <div class="small muted">${h(readyNote(state))}</div>
      </div>
    </div>`;

  return `<div class="setup-inner">
    ${brand}
    ${state.wizard === 'compact' ? compact : stepped}
    ${progressPanel(state)}
    ${state.loadError ? `<div class="note note--warn" style="margin-top:14px"><b>${h(state.loadError.status || '')}</b>
      <span>${h(state.loadError.message)}</span></div>` : ''}
  </div>`;
}
