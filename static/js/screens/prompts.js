// Prompts screen — SPEC §3.
// Half config, half measurement: sizes come from the agent config, the money
// comes from the conversations.

import { isPerTurnKind, segColor } from '../derive.js';
import { avatarLegend } from '../models.js';
import { tokenizerExact, tokenizerLabel, tokenizerSource } from '../tokenizer.js';
import { h, int, num, pct, usd, versionSelect } from '../util.js';

// Sortable columns. `value` returns the number or string the column sorts on;
// `render` draws the cell. Composition has no meaningful ordering.
const COLUMNS = [
  { key: 'label', label: 'Node', sortOn: (a) => (a.label || '').toLowerCase() },
  { key: 'agentName', label: 'Agent', sortOn: (a) => (a.isPrimary ? '\u0000' : '') + String(a.agentName || a.agentId || '').toLowerCase() },
  { key: 'model', label: 'Model', sortOn: (a) => (a.model || '') },
  { key: 'composition', label: 'Composition', sortable: false },
  { key: 'measuredPerCall', label: 'Prompt', sub: 'tok/call', num: true, sortOn: (a) => a.measuredPerCall },
  { key: 'staticTokens', label: 'Static', num: true, sortOn: (a) => a.staticTokens },
  { key: 'perTurnTokens', label: 'Per turn', num: true, sortOn: (a) => a.perTurnTokens },
  { key: 'callsPerConv', label: 'Calls', sub: 'per conversation', num: true, sortOn: (a) => a.callsPerConv },
  { key: 'cacheReadPerCall', label: 'Cache read', sub: 'tok/call', num: true, sortOn: (a) => a.cacheReadPerCall },
  { key: 'residentTokens', label: 'Resident', sub: 'tok/window', num: true, sortOn: (a) => a.residentTokens },
  { key: 'listCost', label: 'At list', sub: 'no cache', num: true, sortOn: (a) => a.listCost },
  { key: 'promptCost', label: 'Prompt cost', sub: 'cache-aware', num: true, sortOn: (a) => a.promptCost },
];

/** Config-side figure: unknown when we lack the agent's definition, approximate
 *  when the heuristic tokenizer is in use. Never a bare number in either case. */
function cfg(value, render) {
  if (value == null) return '<span class="muted" title="This node belongs to an agent whose definition is not cached, so its config cannot be read.">—</span>';
  return (tokenizerExact() ? '' : '~') + render(value);
}

function compositionMeter(audit) {
  if (!audit.configKnown) {
    return '<span class="small muted">config not available</span>';
  }
  const total = audit.totalPerCall || 1;
  return `<div class="meter" style="height:10px">
    ${audit.segs.map((s) => `<i title="${h(s.kind)} — ${int(s.tokens)} tok/call"
      style="background:${segColor(s.kind)};width:${((s.tokens / total) * 100).toFixed(1)}%"></i>`).join('')}
  </div>`;
}

function tiles(model) {
  const p = model.prompts;
  const t = model.totals;
  const ratio = t.tout ? (p.promptTokens / t.tout).toFixed(1) + '× the completion tokens' : '—';
  const biggest = p.biggest;
  return `<div class="grid grid-5">
    <div class="tile tile--accent">
      <div class="tile__k">prompt tokens sent</div>
      <div class="tile__v">${num(p.promptTokens)}</div>
      <div class="tile__note">${h(ratio)} · ${usd(p.promptSpend)} · ${pct(p.promptShareOfWindow)} of window spend</div>
    </div>
    <div class="tile">
      <div class="tile__k">static, re-sent every call</div>
      <div class="tile__v">${tokenizerExact() ? '' : '~'}${usd(p.staticSpend)}</div>
      <div class="tile__note">${pct(p.staticShare)} of prompt spend · sized by ${h(tokenizerSource())},
        not measured</div>
    </div>
    <div class="tile">
      <div class="tile__k">saved by prompt cache</div>
      <div class="tile__v">${usd(p.cacheSaved)}</div>
      <div class="tile__note">${pct(t.tin ? t.cacheRead / t.tin : 0)} of input tokens read from cache</div>
    </div>
    <div class="tile">
      <div class="tile__k">largest prompt</div>
      <div class="tile__v">${biggest ? int(biggest.measuredPerCall) : '—'}<small> tok</small></div>
      <div class="tile__note">${biggest ? h(biggest.label) + (biggest.contextWindow
        ? ' · ' + pct(biggest.contextUsed) + ' of its ' + num(biggest.contextWindow) + ' window'
        : ' · context window unknown') : ''}</div>
    </div>
    <div class="tile">
      <div class="tile__k">duplicated text</div>
      <div class="tile__v">${usd(p.dupeCost)}</div>
      <div class="tile__note">${p.dupes.length} block${p.dupes.length === 1 ? '' : 's'} repeated across
        ${new Set(p.dupes.flatMap((d) => d.nodes.map((n) => n.id))).size} prompts</div>
    </div>
  </div>`;
}

function sortRows(rows, sort) {
  const col = COLUMNS.find((c) => c.key === sort.key);
  if (!col || !col.sortOn) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = col.sortOn(a);
    const y = col.sortOn(b);
    if (typeof x === 'string' || typeof y === 'string') {
      return String(x).localeCompare(String(y)) * dir;
    }
    return ((x || 0) - (y || 0)) * dir;
  });
}

function header(sort) {
  return `<thead><tr>${COLUMNS.map((c) => {
    const active = sort.key === c.key;
    const arrow = active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    const width = c.key === 'composition' ? ' style="min-width:170px"' : '';
    if (c.sortable === false) {
      return `<th class="${c.num ? 'num' : ''}"${width}>${h(c.label)}${c.sub ? `<span class="thn">${h(c.sub)}</span>` : ''}</th>`;
    }
    return `<th class="${c.num ? 'num ' : ''}th-sort${active ? ' th-sort--on' : ''}"${width}
      data-act="prompt-sort" data-id="${c.key}"
      title="Sort by ${h(c.label)}">${h(c.label)}${arrow}${c.sub ? `<span class="thn">${h(c.sub)}</span>` : ''}</th>`;
  }).join('')}</tr></thead>`;
}

function table(model, state) {
  const all = model.prompts.audits;
  if (!all.length) {
    return `<div class="empty">No node on this agent carries an authored prompt that resolved from the cached config.</div>`;
  }
  const sort = state.promptSort || { key: 'promptCost', dir: 'desc' };
  const rows = sortRows(all, sort);

  return `<table class="tbl tbl--tight">
    ${header(sort)}
    <tbody>
      ${rows.map((a) => `
      <tr class="is-click" data-act="open-node" data-id="${h(a.id)}">
        <td><div class="row" style="gap:7px">
          <div class="pm ${h(a.pmCls)}" title="${h(a.model || a.type || '')}">${h(a.ini)}</div>
          <div><div style="font-weight:500">${h(a.label)}${a.derivedLabel
            ? ` <span class="badge mono" style="font-size:9px" title="This node has no label in the agent config — the name is derived from its type and contents (SPEC §7.5).">derived</span>`
            : ''}</div>
            <div class="mono" style="font-size:9.5px;color:var(--ink-3)">vars: ${h(a.vars.length ? a.vars.join(', ') : 'none')}</div>
          </div></div></td>
        <td class="small">${a.isPrimary
          ? '<span class="muted">this agent</span>'
          : `<span class="badge badge--warn mono" title="This node belongs to another agent reached by a transfer. Its prompt is that agent's, not the selected one's.">${h(a.agentName || a.agentId)}</span>`}</td>
        <td class="mono small muted">${h(a.model || '—')}</td>
        <td>${compositionMeter(a)}</td>
        <td class="num" style="font-weight:500">${int(a.measuredPerCall)}</td>
        <td class="num">${cfg(a.staticTokens, int)}</td>
        <td class="num muted">${cfg(a.perTurnTokens, int)}</td>
        <td class="num">${a.callsPerConv.toFixed(2)}<span class="thn">${int(a.calls)} calls</span></td>
        <td class="num">${int(a.cacheReadPerCall)}<span class="thn">${pct(a.cachedShare)} of input</span></td>
        <td class="num">${cfg(a.residentTokens, num)}<span class="thn">${pct(a.hitRate)} of conversations</span></td>
        <td class="num muted">${usd(a.listCost)}<span class="thn" style="color:var(--ok)">${a.cacheSaved > 0.0005 ? '−' + usd(a.cacheSaved) : '—'}</span></td>
        <td class="num" style="font-weight:500">${usd(a.promptCost)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function legend(model) {
  const marks = avatarLegend(model.models, model.ledger);
  if (!marks.length) return '';
  return `<div class="card__foot" style="flex-wrap:wrap;gap:14px">
    <span class="field__k" style="flex:none">marks</span>
    ${marks.map((m) => `<span class="row" style="gap:6px;flex:none">
      <span class="pm ${h(m.cls)}">${h(m.ini)}</span>
      <span>${h(m.name)}</span></span>`).join('')}
  </div>`;
}

function fillCard(model) {
  const legend = model.prompts.segLegend;
  const max = Math.max(1e-9, ...legend.map((s) => s.share));
  return `<div class="card">
    <div class="card__head"><h3>What fills the context</h3><div class="sub">every prompt token in the window, by kind</div></div>
    <div class="card__body stack" style="gap:9px">
      ${legend.length ? legend.map((s) => `
        <div class="barrow">
          <div class="barrow__t">
            <i style="width:9px;height:9px;border-radius:2px;flex:none;background:${segColor(s.kind)}"></i>
            <span>${h(s.kind)}${isPerTurnKind(s.kind) ? '' : ' <span class="muted">· static</span>'}</span>
          </div>
          <div class="bartrack"><i class="bar" style="width:${((s.share / max) * 100).toFixed(1)}%;background:${segColor(s.kind)}"></i></div>
          <div class="barrow__v">${pct(s.share)}</div>
        </div>`).join('') : '<div class="empty">No prompt composition resolved.</div>'}
    </div>
    <div class="card__foot"><span>Static kinds — instructions, policy, few-shot, tool schemas — are counted with a local
      tokenizer and are estimates. The per-turn kinds are measured: <b>conversation history</b> is the gap between the
      tokens actually billed for input and the assembled config, which is exactly what the runtime injected.</span></div>
  </div>`;
}

function dupeCard(model) {
  const dupes = model.prompts.dupes;
  return `<div class="card">
    <div class="card__head"><h3>Duplicated blocks</h3><div class="sub">same text, several prompts</div></div>
    <div class="card__body stack" style="gap:10px">
      ${dupes.length ? dupes.slice(0, 6).map((d) => `
        <div class="note"><div style="min-width:0">
          <div class="row row--wrap" style="gap:8px">
            <span style="color:var(--ink);font-weight:500">${h(d.name)}</span>
            <span class="badge mono">${int(d.tokens)} tok</span>
            <span class="badge mono">×${d.count}</span>
          </div>
          <div class="row row--wrap" style="gap:5px;margin-top:6px">
            ${d.nodes.map((n) => `<span class="chip" style="padding:2px 8px;font-size:11px">${h(n.label)}</span>`).join('')}
          </div>
          <div class="mono small" style="color:var(--warn);margin-top:6px">${usd(d.cost)} / window paid for the repeats</div>
        </div></div>`).join('')
      : '<div class="empty">No block of 80+ characters appears in more than one node prompt.</div>'}
    </div>
    <div class="card__foot"><span>Blocks are matched on whitespace-normalised prompt sections. Cost is every repeat
      after the first, priced at each node's effective (cache-aware) input rate.</span></div>
  </div>`;
}

/**
 * Prompt audit for the printed report — the same renderers as the screen.
 *
 * The audit table carries no customer data: node names, model names, token
 * counts and money. It is the widest thing in the report, which is why the
 * report prints landscape (see `@media print` in kit.css).
 */
export function reportPrompts(model, state) {
  return `
    <section class="rpt__sec rpt__sec--break">
      <h2>Prompt audit</h2>
      <div class="rpt__lede">What each node sends to its model, split into what is resident on every
        call and what arrives per turn. Static prompt text is the part that shrinks without changing
        behaviour. Config-side sizes are estimates from <b>${h(tokenizerSource())}</b>${
        tokenizerExact() ? '' : ' and are prefixed <b>~</b>'}; runtime token counts are exact.</div>
      ${tiles(model)}
      ${model.prompts.unknownConfigAgents.length ? `<div class="note note--warn" style="margin-top:12px"><span>
        <b>${model.prompts.unknownConfigRows.length} node${model.prompts.unknownConfigRows.length === 1 ? '' : 's'}</b>
        belong to ${model.prompts.unknownConfigAgents.length} agent${model.prompts.unknownConfigAgents.length === 1 ? '' : 's'}
        whose definition was not cached when this was exported
        (${model.prompts.unknownConfigAgents.map((n) => h(n)).join(', ')}). Their config columns read
        <b>—</b> rather than borrowing another agent's prompt.</span></div>` : ''}
      <div style="margin-top:12px">${table(model, state)}</div>
      ${legend(model)}
    </section>
    <section class="rpt__sec rpt__sec--break">
      <h2>What fills the context</h2>
      ${fillCard(model)}
      <div style="margin-top:12px">${dupeCard(model)}</div>
    </section>`;
}

export function renderPrompts(model, state) {
  const src = tokenizerSource();
  const foreign = model.prompts.audits.filter((a) => !a.isPrimary);
  const foreignAgents = Array.from(new Set(foreign.map((a) => a.agentName || a.agentId)));
  return `
  <div class="page__head">
    <div>
      <h1>Prompt audit</h1>
      <div class="sub">What each node actually sends to its model, split into what is resident on every call and what
        arrives per turn. Static prompt text is the part you can shrink without changing behaviour.</div>
    </div>
    <div class="page__actions">
      ${versionSelect(state)}
      <span class="badge ${src === 'cl100k' ? 'badge--ok' : 'badge--warn'} mono"><i class="dot"></i>${src}</span>
    </div>
  </div>

  ${tiles(model)}

  ${model.prompts.unknownConfigAgents.length ? `<div class="note note--warn" style="margin-top:14px"><span>
    <b>${model.prompts.unknownConfigRows.length} node${model.prompts.unknownConfigRows.length === 1 ? '' : 's'}</b>
    belong to ${model.prompts.unknownConfigAgents.length} agent${model.prompts.unknownConfigAgents.length === 1 ? '' : 's'}
    whose definition is not cached (${model.prompts.unknownConfigAgents.map((n) => h(n)).join(', ')}).
    Their config columns read <b>—</b> rather than borrowing another agent's prompt. Re-sync, or call
    <span class="mono">POST /api/agents/&lt;id&gt;/backfill</span>, to pull those definitions in —
    the conversations already name every agent that ran.</span></div>` : ''}

  ${foreignAgents.length ? `<div class="note" style="margin-top:14px"><span>
    ${foreign.length} of these nodes belong to ${foreignAgents.length} other
    agent${foreignAgents.length === 1 ? '' : 's'} reached by a transfer
    (${foreignAgents.map((n) => h(n)).join(', ')}). Each is audited against <b>its own</b> agent's root
    prompt, not this one's — the <b>Agent</b> column says which.</span></div>` : ''}

  <div class="section">
    <div class="section__head"><h2>Per node</h2>
      <div class="sub">composition, context pressure, and what the prompt alone costs · click any column to sort</div></div>
    <div class="card">
      <div class="card__body" style="padding:4px 8px;overflow-x:auto;min-width:0">${table(model, state)}</div>
      ${legend(model)}
      <div class="card__foot"><span class="srcnote">tokenizer: ${h(tokenizerLabel())}</span></div>
    </div>
  </div>

  <div class="split" style="margin-top:12px">
    ${fillCard(model)}
    ${dupeCard(model)}
  </div>`;
}
