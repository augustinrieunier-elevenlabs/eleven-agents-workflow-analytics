// Fit screen — Phase A: what the data can say about model fit on its own.
//
// Nothing here is a capability judgement. Gates are hard constraints read off
// the traffic, signals are observations, waste is arithmetic. Whether a model is
// *capable enough* for a node is deliberately left unanswered — that is the
// assessment step, and this screen is the evidence it would be built on.

import { alignedUsd, barBg, h, int, num, pct, rate1m, usd, versionSelect } from '../util.js';

const VERDICT = {
  headroom: ['badge badge--ok', 'looks over-provisioned', 'Headroom signals and no strain.'],
  headroom_blocked: ['badge badge--warn', 'headroom, but gated', 'Looks over-provisioned, but a hard constraint forbids a smaller model.'],
  strained: ['badge badge--fail', 'looks under-provisioned', 'Strain signals and no headroom.'],
  mixed: ['badge badge--warn', 'mixed', 'Both headroom and strain — read the signals, they are pulling in different directions.'],
  balanced: ['badge badge--ok', 'no signal either way', 'Enough traffic to judge, and nothing stands out.'],
  insufficient_evidence: ['badge mono', 'not enough traffic', 'Too few calls in this window to say anything.'],
};

const GATE_STATE = {
  block: ['badge badge--fail', 'blocks'],
  constraint: ['badge badge--warn', 'constrains'],
  pass: ['badge badge--ok', 'clear'],
  unknown: ['badge mono', 'unknown'],
};

function tiles(model) {
  const f = model.fit;
  const t = f.totals;
  return `<div class="grid grid-4">
    <div class="tile tile--accent">
      <div class="tile__k">tool schemas never called</div>
      <div class="tile__v">${usd(t.unusedToolCost)}</div>
      <div class="tile__note">${int(t.unusedToolCount)} attached tool${t.unusedToolCount === 1 ? '' : 's'}
        never invoked, still sent every call</div></div>
    <div class="tile"><div class="tile__k">retrieval</div>
      <div class="tile__v">${usd(t.retrievalCost)}</div>
      <div class="tile__note">what retrieved chunks cost as input across the window</div></div>
    <div class="tile"><div class="tile__k">looks over-provisioned</div>
      <div class="tile__v">${int(t.headroom)}</div>
      <div class="tile__note">of ${int(f.nodes.length)} nodes, on observed signals alone</div></div>
    <div class="tile"><div class="tile__k">looks under-provisioned</div>
      <div class="tile__v">${int(t.strained)}</div>
      <div class="tile__note">${int(t.blocked)} node${t.blocked === 1 ? '' : 's'} hard-gated against any downgrade</div></div>
  </div>`;
}

/**
 * Per-agent breakdown and filter.
 *
 * A node is only identified by its id together with its owning agent, and names
 * repeat across agents — one real coordinator has `start`, `say_espera` and
 * `say_espera_base` on two agents each, with very different call volumes. Without
 * the agent on screen those rows read as duplicates.
 */
function agentFilter(model, state) {
  const agents = model.fit.agents || [];
  if (agents.length < 2) return '';
  const active = state.fitAgent || null;
  const chip = (id, label, tail, on) => `<button data-act="fit-agent" data-id="${h(id || '')}"
    class="chip" style="${on
      ? 'background:var(--ink);color:var(--ink-inv);border-color:var(--ink)'
      : 'background:var(--bg-2);color:var(--ink-2);border-color:var(--line)'}">
    ${h(label)}<span class="mono small" style="opacity:.6">${h(tail)}</span></button>`;
  return `<div class="row row--wrap" style="gap:8px;margin-bottom:12px">
    <span class="field__k">agent</span>
    ${chip('', 'all', model.fit.nodes.length + ' nodes', !active)}
    ${agents.map((a) => chip(a.agentId, (a.name || a.agentId) + (a.isPrimary ? '' : ' ↗'),
      `${a.nodes} · ${usd(a.cost)}`, active === a.agentId)).join('')}
  </div>`;
}

function agentBadge(node) {
  if (node.isPrimary) return '';
  return `<span class="badge badge--warn mono"
    title="This node belongs to another agent reached by a transfer. Its prompt, tools and knowledge base are that agent's.">
    ${h(node.agentName || node.agentId || 'other agent')}</span>`;
}

function gateRow(gate) {
  const [cls, word] = GATE_STATE[gate.state] || GATE_STATE.unknown;
  return `<span style="display:block;margin-bottom:5px">
    <span class="row" style="gap:7px;align-items:baseline">
      <span class="${cls} mono" style="flex:none">${word}</span>
      <span style="font-weight:500;flex:none">${h(gate.label)}</span>
    </span>
    <span class="small muted" style="display:block;margin-left:2px">${h(gate.detail)}</span>
  </span>`;
}

function signalList(rows, tone) {
  if (!rows.length) return `<div class="small muted">none</div>`;
  return rows.map((r) => `<div style="margin-bottom:6px">
    <div class="row" style="gap:7px;align-items:baseline">
      <i style="width:7px;height:7px;border-radius:2px;flex:none;background:${tone}"></i>
      <span style="font-weight:500">${h(r.label)}</span>
      ${r.severity ? `<span class="badge mono" style="font-size:9.5px">${h(r.severity)}</span>` : ''}
    </div>
    <div class="small muted" style="margin-left:14px">${h(r.detail)}</div>
  </div>`).join('');
}

function candidateTable(node) {
  if (!node.clearsGates.length) {
    return `<div class="small muted">No other model in this window is both cheaper and wide enough for
      ${int(node.requiredContext)} tokens.</div>`;
  }
  const money = alignedUsd(node.clearsGates.map((c) => c.delta));
  return `<table class="tbl tbl--tight">
    <thead><tr><th>Model in the mix</th><th class="num">$/1M in</th><th class="num">$/1M out</th>
      <th class="num">Context</th><th class="num">If this node ran there</th></tr></thead>
    <tbody>${node.clearsGates.slice(0, 5).map((c) => `<tr>
      <td class="mono" style="font-size:11.5px">${h(c.name)}</td>
      <td class="num muted">${rate1m(c.priceIn)}</td>
      <td class="num muted">${rate1m(c.priceOut)}</td>
      <td class="num muted">${c.contextWindow ? num(c.contextWindow) : 'unknown'}</td>
      <td class="num" style="font-weight:500;color:var(--ok)">−${money(c.delta)}</td>
    </tr>`).join('')}</tbody>
  </table>
  <div class="small muted" style="margin-top:8px">Clearing the context gate is not the same as being
    capable enough — these are the arithmetic candidates, not recommendations.</div>`;
}

function toolTable(node) {
  const rows = node.tools.attached;
  if (!rows.length) return '';
  return `<table class="tbl tbl--tight">
    <thead><tr><th>Tool</th><th class="num">Schema tok</th><th class="num">Calls</th>
      <th class="num">Errors</th><th>Verdict</th></tr></thead>
    <tbody>${rows.map((t) => `<tr>
      <td class="mono" style="font-size:11.5px">${h(t.name)}</td>
      <td class="num muted">${t.known ? int(t.schemaTokens) : '—'}</td>
      <td class="num">${int(t.calls)}</td>
      <td class="num ${t.errors ? '' : 'muted'}">${int(t.errors)}</td>
      <td>${!t.known ? '<span class="badge mono">schema not cached</span>'
        : t.calls === 0 ? '<span class="badge badge--warn mono">never called</span>'
        : t.errors ? '<span class="badge badge--fail mono">failing</span>'
        : '<span class="badge badge--ok mono">in use</span>'}</td>
    </tr>`).join('')}</tbody>
  </table>
  ${node.tools.unusedTools.length ? `<div class="note note--warn" style="margin-top:10px"><span>
    ${int(node.tools.unusedToolTokens)} tokens of schema for
    ${node.tools.unusedTools.length} never-called tool${node.tools.unusedTools.length === 1 ? '' : 's'},
    sent on every one of ${int(node.calls)} calls — ${usd(node.tools.unusedToolCost)} over the window.
    Detaching them changes no behaviour that was ever exercised.</span></div>` : ''}`;
}

function kbBlock(node) {
  const kb = node.kb;
  if (!kb.ragCalls && !kb.docs.length) {
    return `<div class="small muted">No retrieval and no resident knowledge-base documents on this node.</div>`;
  }
  return `<div class="card__body" style="padding:8px 14px">
    <div class="protorow"><div class="k">retrieval</div>
      <div class="mono">${pct(kb.ragShare)} of calls</div>
      <div class="small muted">${int(kb.retrievedPerCall)} retrieved tokens per call
        · ${usd(kb.retrievalCost)} over the window</div></div>
    <div class="protorow"><div class="k">match quality</div>
      <div class="mono">${kb.meanDistance ? kb.meanDistance.toFixed(3) : '—'}</div>
      <div class="small muted">${kb.meanDistance
        ? 'mean vector distance across retrieved chunks — higher means weaker matches, and weak matches still cost input tokens'
        : 'no vector distances reported'}</div></div>
    <div class="protorow"><div class="k">resident documents</div>
      <div class="mono">${int(kb.docs.length)}</div>
      <div class="small muted">${kb.docs.length
        ? 'seen in used_static_kb_document_ids on turns for this node'
        : 'none were resident on any turn here'}</div></div>
  </div>`;
}

function nodeCard(node, open) {
  const [vCls, vWord, vWhy] = VERDICT[node.verdict] || VERDICT.insufficient_evidence;
  return `<div class="card" style="margin-bottom:12px">
    <div class="card__head" style="flex-wrap:wrap;gap:8px">
      <div class="pm ${h(node.pmCls)}">${h(node.ini)}</div>
      <h3 style="white-space:normal">${h(node.label)}</h3>
      ${agentBadge(node)}
      <div class="sub mono" title="node id: ${h(node.nodeId || '')}">${h(node.model || node.type)}</div>
      <div class="right" style="flex-wrap:wrap">
        ${node.configKnown ? '' : '<span class="badge mono" title="This node\'s owning agent definition is not cached, so its prompt, tools and knowledge base cannot be read — only its billed traffic.">config unavailable</span>'}
        <span class="${vCls} mono" title="${h(vWhy)}">${vWord}</span>
        <span class="badge mono">${int(node.calls)} calls</span>
        <span class="badge mono">${usd(node.cost)} · ${pct(node.share)}</span>
        <button class="btn btn--sm" data-act="fit-toggle" data-id="${h(node.id)}">${open ? 'Hide' : 'Evidence'}</button>
      </div>
    </div>
    ${open ? `<div class="card__body stack" style="gap:14px">
      <div class="split">
        <div>
          <div class="side__label" style="padding-left:0">constraints</div>
          ${node.gates.map(gateRow).join('')}
        </div>
        <div class="stack" style="gap:12px">
          <div>
            <div class="side__label" style="padding-left:0">headroom</div>
            ${signalList(node.headroom, 'var(--ok)')}
          </div>
          <div>
            <div class="side__label" style="padding-left:0">strain</div>
            ${signalList(node.strain, 'var(--fail)')}
          </div>
        </div>
      </div>
      <div>
        <div class="side__label" style="padding-left:0">tools attached vs used</div>
        ${toolTable(node) || '<div class="small muted">No tools attached.</div>'}
      </div>
      <div>
        <div class="side__label" style="padding-left:0">knowledge base</div>
        ${kbBlock(node)}
      </div>
      <div>
        <div class="side__label" style="padding-left:0">cheaper models already in this window</div>
        ${candidateTable(node)}
      </div>
    </div>` : ''}
  </div>`;
}

export function renderFit(model, state) {
  const all = model.fit.nodes;
  const nodes = state.fitAgent ? all.filter((n) => n.agentId === state.fitAgent) : all;
  const openId = state.fitOpen;
  const agents = model.fit.agents || [];
  const missingConfig = all.filter((n) => !n.configKnown);
  return `
  <div class="page__head">
    <div>
      <h1>Model fit <span style="font-size:0.45em;font-family:var(--font-mono);letter-spacing:.06em;
        color:var(--warn);vertical-align:0.55em">WIP · BETA</span></h1>
      <div class="sub">What the traffic can say on its own about whether each node's model is the right size.
        Constraints are read off observed behaviour and <b>forbid</b> a downgrade; signals are evidence of
        headroom or strain; the waste figures are arithmetic. Judging whether a given model is capable
        enough is not attempted here.</div>
    </div>
    <div class="page__actions">
      <span class="badge mono">${int(nodes.length)}${state.fitAgent ? ' of ' + int(all.length) : ''} nodes</span>
      ${agents.length > 1 ? `<span class="badge mono">${agents.length} agents</span>` : ''}
      ${versionSelect(state)}
    </div>
  </div>

  ${tiles(model)}

  ${missingConfig.length ? `<div class="note note--warn" style="margin-top:14px"><span>
    ${int(missingConfig.length)} node${missingConfig.length === 1 ? '' : 's'} belong to an agent whose
    definition is not cached, so only their billed traffic is assessed — prompt size, tool surface and
    knowledge-base signals are unavailable for them. Re-sync, or call
    <span class="mono">POST /api/agents/&lt;id&gt;/backfill</span>, to pull those definitions in.</span></div>` : ''}

  <div class="section">
    <div class="section__head"><h2>Per node</h2>
      <div class="sub">sorted by window spend · open one for the evidence behind its verdict</div></div>
    ${agentFilter(model, state)}
    ${nodes.length
      ? nodes.map((n) => nodeCard(n, n.id === openId)).join('')
      : `<div class="empty">${state.fitAgent
          ? 'No node from that agent carries traffic in this window.'
          : 'No node in this window carries LLM traffic or an authored prompt.'}</div>`}
  </div>

  <div class="note" style="margin-top:14px"><span>
    Every figure above comes from this window's cached responses — no model was asked for an opinion.
    Sample floor is 30 calls; below that a node reads <b>not enough traffic</b> rather than guessing.
  </span></div>`;
}
