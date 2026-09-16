// Workflow screen — SPEC §2.
// The graph, the KPI tiles, and the node ledger with its reconciliation strip.

import { NODE_H, NODE_W, UNATTRIBUTED } from '../derive.js';
import { edgePath } from '../graph.js';
import {
  barBg, daysBetween, h, int, median, ms, num, pct, ramp, signedPct, usd,
} from '../util.js';

const ENCODINGS = [
  ['heat', 'Heat', 'Node fill = share of window spend.'],
  ['bar', 'Token bar', 'Bar length = tokens per call; split input / output.'],
  ['flow', 'Flow', 'Edge thickness = traffic through that transition.'],
];

export const encodingHint = (key) => (ENCODINGS.find((e) => e[0] === key) || ENCODINGS[0])[2];
export const encodingList = () => ENCODINGS;

function canvasBounds(nodes) {
  const xs = nodes.map((n) => (n.x || 0) + NODE_W);
  const ys = nodes.map((n) => (n.y || 0) + NODE_H);
  return {
    w: Math.max(1288, Math.max(0, ...xs) + 24),
    hh: Math.max(520, Math.max(0, ...ys) + 24),
  };
}

function edgeLayer(model, encoding) {
  const byId = model.nodeById;
  const flow = encoding === 'flow';
  const maxTraffic = Math.max(1, ...model.edges.map((e) => e.traffic));
  const parts = [];

  model.edges.forEach((edge, i) => {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b || a.x == null || b.x == null) return;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const d = edgePath(a.x, a.y, b.x, b.y);
    const key = 'e' + i;
    const width = flow ? 1 + (edge.traffic / maxTraffic) * 7 : 1.4;
    const failure = !!(edge.forward && edge.forward.failure);
    const dead = edge.traffic === 0;
    parts.push(`<path data-edge="${key}" data-source="${h(edge.source)}" data-target="${h(edge.target)}"
      d="${d}" fill="none" stroke="${edge.observed ? 'var(--warn)' : 'var(--ink)'}"
      stroke-opacity="${dead ? 0.12 : flow ? 0.28 : 0.22}" stroke-width="${width.toFixed(2)}"
      stroke-linecap="round" class="${failure ? 'edge-fail' : ''}">
      <title>${h(a.label)} → ${h(b.label)} · ${int(edge.traffic)} transitions${
        edge.forward && edge.forward.kind ? ' · ' + h(edge.forward.kind) : ''}${
        edge.forward && edge.forward.label ? ': ' + h(edge.forward.label) : ''}</title>
    </path>`);
    parts.push(`<circle data-edge-dot="${key}" cx="${x2 - 3}" cy="${y2}" r="2.6"
      fill="var(--ink)" fill-opacity="${dead ? 0.15 : 0.35}"></circle>`);
    if (flow && edge.traffic) {
      parts.push(`<text data-edge-label="${key}" x="${(a.x + NODE_W + x2) / 2}" y="${(y1 + y2) / 2 - 6}"
        text-anchor="middle" class="edge-label">${int(edge.traffic)}</text>`);
    }
  });
  return parts.join('');
}

function nodeBox(row, model, encoding, selected) {
  const maxTok = Math.max(1, ...model.ledger.map((r) => r.tinPerCall + r.toutPerCall));
  const scale = (row.tinPerCall + row.toutPerCall) / maxTok;
  const totalPerCall = row.tinPerCall + row.toutPerCall;
  const bg = encoding === 'heat' && row.cost > 0
    ? `color-mix(in srgb, ${ramp(row.share, model.maxShare)} ${(14 + (row.share / (model.maxShare || 1)) * 44).toFixed(0)}%, var(--bg-2))`
    : 'var(--bg-2)';

  let body = '';
  if (encoding === 'bar') {
    body = `<div style="margin-top:8px">
      <div class="meter" style="background:var(--bg-inset)">
        <i style="background:var(--q4);width:${totalPerCall ? ((row.tinPerCall / totalPerCall) * 100 * scale).toFixed(1) : 0}%"></i>
        <i style="background:var(--s2);width:${totalPerCall ? ((row.toutPerCall / totalPerCall) * 100 * scale).toFixed(1) : 0}%"></i>
      </div>
      <div class="row mono" style="font-size:9.5px;color:var(--ink-3);margin-top:4px">
        <span>↓${num(row.tinPerCall)}</span><span>↑${num(row.toutPerCall)}</span>
        <span class="spacer"></span><span style="color:var(--ink)">${row.cost ? usd(row.cost) : '—'}</span>
      </div></div>`;
  } else if (encoding === 'flow') {
    body = `<div class="row mono" style="font-size:9.5px;color:var(--ink-3);margin-top:8px">
      <span>${int(row.calls)} calls</span><span class="spacer"></span>
      <span style="color:var(--ink)">${row.cost ? usd(row.cost) : '—'}</span></div>`;
  } else {
    body = `<div class="row" style="margin-top:8px;align-items:baseline">
      <span class="mono" style="font-size:13px;font-variant-numeric:tabular-nums">${row.cost ? usd(row.cost) : '—'}</span>
      <span class="spacer"></span>
      <span class="mono" style="font-size:9.5px;color:var(--ink-3)">${pct(row.share)} of spend</span></div>`;
  }

  return `<button class="nd${selected ? ' nd--on' : ''}${row.offGraph ? ' nd--stray' : ''}"
    data-node-id="${h(row.id)}" data-x="${row.x}" data-y="${row.y}"
    title="${h(row.label)}${row.nodeId ? ' · ' + h(row.nodeId) : ''}${
      row.isPrimary === false ? ' · agent: ' + h(row.agentName || row.agentId) : ''}${
      row.offGraph ? ' · not in the pinned graph, observed in traffic' : ''}"
    style="left:${row.x}px;top:${row.y}px;width:${NODE_W}px;background:${bg}">
    <div class="row" style="gap:7px;align-items:flex-start">
      <div class="pm ${h(row.pmCls)}">${h(row.ini)}</div>
      <div style="min-width:0;flex:1">
        <div style="font-size:12.5px;font-weight:500;line-height:1.25">${h(row.label)}</div>
        <div class="mono" style="font-size:9.5px;color:var(--ink-3);margin-top:2px">${h(row.model || row.type)}</div>
      </div>
    </div>
    ${body}
  </button>`;
}

/**
 * Each agent's graph sits in its own horizontal band. Without a label the bands
 * are unexplained whitespace, and a node named the same on two agents gives no
 * clue which band it is in.
 */
function bandLabels(placed) {
  const byAgent = new Map();
  for (const row of placed) {
    if (!row.agentId) continue;
    const slot = byAgent.get(row.agentId) || { name: row.agentName || row.agentId, top: Infinity, isPrimary: row.isPrimary !== false };
    slot.top = Math.min(slot.top, row.y);
    byAgent.set(row.agentId, slot);
  }
  if (byAgent.size < 2) return '';
  return Array.from(byAgent.values()).map((a) => `<text x="8" y="${(a.top - 16).toFixed(0)}"
    style="font:500 12px Inter,system-ui;fill:var(--ink-3)">${h(a.name)}${a.isPrimary ? '' : ' ↗'}</text>`).join('');
}

function kpis(model, state) {
  const t = model.totals;
  const days = daysBetween(state.from, state.to);
  const convs = t.conversations || 1;
  const slowest = model.ledger.filter((r) => r.p95 != null).sort((a, b) => b.p95 - a.p95)[0];
  const ratio = t.tout ? (t.tin / t.tout).toFixed(1) + '×' : '—';

  return `<div class="grid grid-5">
    <div class="tile tile--accent">
      <div class="tile__k">window spend</div>
      <div class="tile__v">${usd(t.windowSpend)}</div>
      <div class="tile__note">${usd(t.windowSpend / days)} / day · ${usd(t.windowSpend / convs)} / conversation · LLM only</div>
    </div>
    <div class="tile">
      <div class="tile__k">cost / conversation</div>
      <div class="tile__v">${usd(t.windowSpend / convs)}</div>
      <div class="tile__note">median ${usd(median(t.costs))}</div>
    </div>
    <div class="tile">
      <div class="tile__k">tokens in / out</div>
      <div class="tile__v">${num(t.tin)}<small> / ${num(t.tout)}</small></div>
      <div class="tile__note">${ratio} read per written · ${pct(t.tin ? t.cacheRead / t.tin : 0)} of input from cache</div>
    </div>
    <div class="tile">
      <div class="tile__k">llm calls</div>
      <div class="tile__v">${num(t.llmCalls)}</div>
      <div class="tile__note">${(t.llmCalls / convs).toFixed(1)} per conversation</div>
    </div>
    <div class="tile">
      <div class="tile__k">turn latency p95</div>
      <div class="tile__v">${ms(t.latencyP95)}</div>
      <div class="tile__note">${slowest ? 'slowest node ' + h(slowest.label) : 'no turn metrics in this window'}</div>
    </div>
  </div>`;
}

function reconciliation(model) {
  const t = model.totals;
  if (!t.hasCharging) {
    return `<div class="card__foot" style="align-items:flex-start;gap:12px;flex-wrap:wrap">
      <span class="prov"><span>per-turn llm_usage <b style="color:var(--ink)">${usd(t.turnsTotal)}</b></span></span>
      <span class="badge badge--warn mono"><i class="dot"></i>no charging block</span>
      <span style="flex:1 1 320px;min-width:0">These conversations carry no <span class="mono">metadata.charging</span>,
        so totals fall back to the summed per-turn <span class="mono">llm_usage</span>. That figure excludes any cache
        accounting the biller applies, so treat it as a floor.</span>
    </div>`;
  }
  const within = Math.abs(t.drift) <= 0.01;
  const gap = t.unattributedSpend;
  const gapShare = t.windowSpend ? gap / t.windowSpend : 0;
  return `<div class="card__foot" style="align-items:flex-start;gap:12px;flex-wrap:wrap">
    <span class="prov">
      <span>per-turn llm_usage <b style="color:var(--ink)">${usd(t.turnsTotal)}</b></span><span class="sep"></span>
      <span>billed llm_price <b style="color:var(--ink)">${usd(t.chargingTotal)}</b></span><span class="sep"></span>
      <span>drift ${signedPct(t.drift)}</span>
    </span>
    <span class="badge ${within ? 'badge--ok' : 'badge--warn'} mono"><i class="dot"></i>${
      within ? 'within tolerance' : 'drift over 1%'}</span>
    <span style="flex:1 1 320px;min-width:0">Node rows come from per-turn <span class="mono">llm_usage</span>, the only
      source with node granularity; it sums to
      <span class="mono">charging.llm_usage.irreversible_generation</span> — the generations that completed. The billed
      figure is <span class="mono">charging.llm_price</span>, which matches
      <span class="mono">initiated_generation</span>: every generation that was <i>started</i>.
      ${gap > 0 ? `The ${usd(gap)} difference (${pct(gapShare)} of spend) is generations begun and then abandoned —
        on voice, interruptions. It is billed but has no node behind it.` : ''}
      Totals follow the billed figure; shares follow the turns, so each node's spend is its turn share scaled to
      what was actually charged.</span>
  </div>`;
}

function ledgerTable(model) {
  const rows = model.ledger;
  return `<table class="tbl tbl--tight">
    <thead><tr>
      <th class="rank">#</th><th>Node</th><th>Agent</th><th>Model</th><th class="num">Calls</th>
      <th class="num">Tok in<span class="thn">avg/call</span></th>
      <th class="num">Tok out<span class="thn">avg/call</span></th>
      <th class="num">p50</th><th>Share</th><th class="num">Spend</th>
    </tr></thead>
    <tbody>
      ${rows.map((r, i) => `
      <tr class="is-click" data-act="open-node" data-id="${h(r.id)}">
        <td class="rank">${i + 1}</td>
        <td><div class="row" style="gap:7px">
          <div class="pm ${h(r.pmCls)}">${h(r.ini)}</div>
          <span style="font-weight:500">${h(r.label)}</span>
          ${r.id === UNATTRIBUTED ? '<span class="badge badge--warn mono">no node id</span>' : ''}
        </div></td>
        <td class="small">${r.id === UNATTRIBUTED
          ? '<span class="muted">—</span>'
          : r.isPrimary === false
            ? `<span class="badge badge--warn mono" title="Reached by a transfer. Its prompt, tools and knowledge base belong to that agent.">${h(r.agentName || r.agentId)}</span>`
            : '<span class="muted">this agent</span>'}</td>
        <td class="mono small muted">${h(r.model || '—')}${r.modelOverridden
          ? `<span class="thn">config: ${h(r.configModel)}</span>` : ''}</td>
        <td class="num">${int(r.calls)}</td>
        <td class="num">${num(r.tin)}<span class="thn">${int(r.tinPerCall)}/call</span></td>
        <td class="num">${num(r.tout)}<span class="thn">${int(r.toutPerCall)}/call</span></td>
        <td class="num muted">${ms(r.p50)}</td>
        <td style="width:180px"><div class="bartrack">
          <i class="bar" style="width:${((r.share / (model.maxShare || 1)) * 100).toFixed(0)}%;background:${barBg(r.share / (model.maxShare || 1))}"></i>
        </div></td>
        <td class="num" style="font-weight:500">${r.cost ? usd(r.cost) : '—'}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

export function renderWorkflow(model, state) {
  const placed = model.ledger.filter((r) => r.x != null);
  const bounds = canvasBounds(placed);
  const strays = placed.filter((r) => r.offGraph);
  const view = (state.layout && state.layout.view) || null;

  return `
  <div class="page__head">
    <div>
      <h1>Workflow cost</h1>
      <div class="sub">Every node priced from the conversations in the window. Token counts are summed per node
        execution from <span class="mono">transcript[].llm_usage</span>, then priced with the rates the API returned
        alongside them — no allocation guesses, no hardcoded price table.</div>
    </div>
    <div class="page__actions">
      <span class="badge mono">${model.ledger.length} nodes</span>
      <span class="badge mono">${h(state.versionLabel || 'any version')}</span>
    </div>
  </div>

  ${kpis(model, state)}

  <div class="section">
    <div class="section__head">
      <h2>Graph</h2>
      <div class="sub">${h(encodingHint(state.encoding))}</div>
      <div class="right">
        <div class="seg">${ENCODINGS.map(([key, label]) =>
          `<button data-act="encoding" data-id="${key}" aria-pressed="${state.encoding === key}">${label}</button>`).join('')}</div>
        <div class="legend"><span><i style="background:var(--q5)"></i>higher share</span><span><i style="background:var(--q1)"></i>lower</span></div>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div class="cvs-wrap" id="cvs-wrap">
        <div class="cvs" id="cvs"
             data-zoom="${view ? view.zoom : 1}" data-pan-x="${view ? view.x : 0}" data-pan-y="${view ? view.y : 0}"
             style="width:${bounds.w}px;height:${bounds.hh}px">
          <svg viewBox="0 0 ${bounds.w} ${bounds.hh}" preserveAspectRatio="none">${
          bandLabels(placed)}${edgeLayer(model, state.encoding)}</svg>
          ${placed.map((r) => nodeBox(r, model, state.encoding, state.node === r.id)).join('')}
        </div>
        <div class="cvs-tools">
          <button class="btn btn--sm" data-zoom="out" title="Zoom out">−</button>
          <span class="badge mono" data-zoom-label style="min-width:46px;justify-content:center">100%</span>
          <button class="btn btn--sm" data-zoom="in" title="Zoom in">+</button>
          <button class="btn btn--sm" data-zoom="fit" title="Fit every node">Fit</button>
          <button class="btn btn--sm" data-zoom="reset" title="Back to 100%">1:1</button>
        </div>
        <div class="cvs-hint mono">drag a node to move it · drag the background to pan · scroll to zoom</div>
      </div>
    </div>
    <div class="row row--wrap" style="margin-top:10px;gap:10px">
      <span class="small muted" style="flex:1 1 320px">
        ${state.layoutSaved
          ? 'Layout saved for this agent and branch — it reloads with the window.'
          : 'Node positions come from the agent graph. Move one and the arrangement is saved.'}
      </span>
      <button class="btn btn--sm" data-act="layout-reset" ${state.layoutSaved ? '' : 'disabled'}>Reset positions</button>
    </div>
    ${strays.length ? `<div class="note" style="margin-top:10px">
      <span>${strays.length} node${strays.length === 1 ? '' : 's'} carried traffic but ${strays.length === 1 ? 'is' : 'are'} not
      in the pinned graph (${strays.map((r) => h(r.label)).join(', ')}). ${strays.length === 1 ? 'It is' : 'They are'}
      drawn with a dashed border in the spare column on the right — usually a mid-window commit changed the node set.</span>
    </div>` : ''}
  </div>

  <div class="section">
    <div class="section__head"><h2>Node ledger</h2><div class="sub">sorted by window spend</div></div>
    <div class="card">
      <div class="card__body" style="padding:4px 8px;overflow-x:auto;min-width:0">${ledgerTable(model)}</div>
      ${reconciliation(model)}
    </div>
  </div>`;
}
