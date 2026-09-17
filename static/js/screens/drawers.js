// Node and conversation drawers — SPEC §2 / §4.

import {
  UNATTRIBUTED, collectModelUsage, ratePerMillion, splitKey, usageCost, usageTokens,
} from '../derive.js';
import { contextWindow } from '../models.js';
import {
  attr, barBg, dur, h, int, ms, num, pct, rate1k, spark, stampOf, sum, usd,
} from '../util.js';

function shell(inner, variant) {
  const cls = variant ? ' drawer--' + variant : '';
  return `<div class="scrim" data-act="close-drawer"></div>`
    + `<div class="drawer${cls}">${inner}</div>`;
}

/**
 * Display name for one step of a conversation path.
 *
 * derive falls back to the node's own key when it can find no definition for it,
 * and that key is `agentId::nodeId`. On a real window 34% of steps hit that
 * fallback — a transferred agent's nodes are only named when that agent's
 * document is cached *and* the node carries a label — so the raw key was
 * reaching the screen as if it were a name. It is not one. Show the bare node
 * id and name the owning agent separately, the way the node drawer does.
 */
function stepName(model, step) {
  const node = model.nodeById.get(step.nodeId);
  const parts = splitKey(step.nodeId);
  const label = (node && node.label) || step.label || parts.nodeId;
  const agentId = (node && node.agentId) || parts.agentId;
  return {
    label,
    // Only worth the badge when it is not the agent the whole screen is about.
    agent: agentId && agentId !== model.agentId
      ? ((node && node.agentName) || agentNameOf(model, agentId) || agentId)
      : null,
    // The text on screen is the node's own id rather than a name someone wrote:
    // either the graph has no node under this key at all, or it has one whose
    // label derive had to invent from the id.
    unnamed: !node || label === parts.nodeId,
  };
}

/** Agent display name from any ledger row belonging to it. */
function agentNameOf(model, agentId) {
  for (const row of model.ledger) if (row.agentId === agentId && row.agentName) return row.agentName;
  return null;
}

// Input and output are plotted on their own axes once they differ by more than
// this, because they routinely differ by two or three orders of magnitude — a
// conversation resends its whole prompt on every call but emits a sentence.
// Below the threshold one shared axis is strictly better: no second scale to
// read, and the gap between the lines is then literally the gap in tokens.
const DUAL_AXIS_RATIO = 4;

const IN_COLOR = 'var(--q4)';
const OUT_COLOR = 'var(--s2)';

/**
 * Cumulative token growth across one conversation's node path.
 *
 * x is the step index, matching the `#` column of the table below it, so a
 * bend in the line can be traced to a named node execution. y is tokens
 * consumed *so far* — the question being answered is "where in the call did
 * this conversation get expensive", which a per-step chart answers worse
 * because a single 121k-token step dwarfs everything and hides the ramp.
 *
 * The scale is stated rather than implied: both axis maxima are labelled and
 * the footer says the ratio, because a dual axis can otherwise be misread as
 * the two series crossing.
 */
function tokenGrowthChart(steps, names) {
  const W = 470;
  const H = 208;
  const padL = 46;
  const padR = 46;
  const padT = 12;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Cumulative from a zero origin: the first segment is the first step's cost,
  // not a jump out of nowhere.
  const cin = [0];
  const cout = [0];
  for (const s of steps) {
    cin.push(cin[cin.length - 1] + (s.tin || 0));
    cout.push(cout[cout.length - 1] + (s.tout || 0));
  }
  const totalIn = cin[cin.length - 1];
  const totalOut = cout[cout.length - 1];
  const n = cin.length - 1;
  if (!n || (!totalIn && !totalOut)) {
    return '<div class="ph">No token usage on this conversation\'s steps — nothing to plot.</div>';
  }

  const ratio = totalOut > 0 ? totalIn / totalOut : Infinity;
  const dual = !(ratio <= DUAL_AXIS_RATIO && ratio >= 1 / DUAL_AXIS_RATIO);
  const shared = Math.max(totalIn, totalOut, 1);
  const maxIn = dual ? Math.max(totalIn, 1) : shared;
  const maxOut = dual ? Math.max(totalOut, 1) : shared;

  const x = (i) => padL + (n === 0 ? plotW / 2 : (i / n) * plotW);
  const y = (v, max) => padT + plotH - (v / max) * plotH;
  const path = (vals, max) => vals
    .map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v, max).toFixed(1)).join(' ');

  // Only label a few x positions, or a 90-step path turns the axis into a smear.
  const every = Math.max(1, Math.ceil(n / 8));
  const xTicks = [];
  for (let i = 1; i <= n; i += every) xTicks.push(i);
  if (xTicks[xTicks.length - 1] !== n) xTicks.push(n);

  const yTick = (frac, max, side, color) => {
    const vy = y(frac * max, max);
    return `<text x="${side === 'left' ? padL - 6 : W - padR + 6}" y="${(vy + 3).toFixed(1)}"
      text-anchor="${side === 'left' ? 'end' : 'start'}" fill="${color}"
      style="font-family:var(--font-mono);font-size:8.5px">${h(num(frac * max))}</text>`;
  };

  // One dot per step, each carrying its own tooltip: the chart is the index into
  // the table, so hovering a bend has to name the node that caused it.
  const marks = (vals, max, color, label) => vals.map((v, i) => {
    if (i === 0) return '';
    const name = (names || [])[i - 1] || {};
    const delta = v - vals[i - 1];
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(v, max).toFixed(1)}" r="${n > 40 ? 1.5 : 2.4}"
      fill="${color}"><title>step ${i} · ${h(name.label || '')}${name.agent ? ' (' + h(name.agent) + ')' : ''}`
      + ` — ${label} ${int(v)} cumulative (+${int(delta)} this step)</title></circle>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible"
         role="img" aria-label="Cumulative input and output tokens across ${n} conversation steps">
      ${[0, 0.5, 1].map((f) => {
        const gy = padT + plotH - f * plotH;
        return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}"
          stroke="var(--line)" stroke-width="1" ${f === 0 ? '' : 'stroke-dasharray="2 3"'}></line>`;
      }).join('')}
      ${xTicks.map((i) => `<text x="${x(i).toFixed(1)}" y="${H - padB + 14}" text-anchor="middle"
        fill="var(--ink-3)" style="font-family:var(--font-mono);font-size:8.5px">${i}</text>`).join('')}
      <text x="${(padL + plotW / 2).toFixed(0)}" y="${H - 2}" text-anchor="middle" fill="var(--ink-3)"
        style="font-family:var(--font-mono);font-size:8.5px;letter-spacing:.08em">STEP</text>

      ${[0.5, 1].map((f) => yTick(f, maxIn, 'left', dual ? IN_COLOR : 'var(--ink-3)')).join('')}
      ${dual ? [0.5, 1].map((f) => yTick(f, maxOut, 'right', OUT_COLOR)).join('') : ''}
      <text x="${padL - 6}" y="${padT + plotH + 3}" text-anchor="end" fill="var(--ink-3)"
        style="font-family:var(--font-mono);font-size:8.5px">0</text>

      <path d="${path(cin, maxIn)}" fill="none" stroke="${IN_COLOR}" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round"></path>
      <path d="${path(cout, maxOut)}" fill="none" stroke="${OUT_COLOR}" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round"></path>
      ${marks(cin, maxIn, IN_COLOR, 'input')}
      ${marks(cout, maxOut, OUT_COLOR, 'output')}
    </svg>
    <div class="row row--wrap" style="gap:10px;margin-top:8px;align-items:baseline">
      <span class="legend"><span><i style="background:${IN_COLOR}"></i>input ${num(totalIn)}</span>
        <span><i style="background:${OUT_COLOR}"></i>output ${num(totalOut)}</span></span>
      <span class="spacer"></span>
      <span class="mono small muted">${dual
        ? 'separate y axes — input runs ' + (isFinite(ratio) ? ratio.toFixed(0) + '×' : '∞') + ' output, '
          + 'so one shared scale would flatten the output line onto the floor'
        : 'one shared y axis'}</span>
    </div>`;
}

export function renderNodeDrawer(model, nodeId) {
  const row = model.nodeById.get(nodeId);
  if (!row) return '';
  const audit = model.prompts.audits.find((a) => a.id === nodeId);
  const convs = model.totals.conversations || 1;
  const vals = model.days.map((d) => (row.byDay.get(d.key) || 0) * model.totals.scale);
  const sp = spark(vals, 300, 60);
  const ctx = contextWindow(row.model);

  const units = row.usage[row.model];
  const priceNote = units
    ? `${rate1k(ratePerMillion(units.input))} / 1k in · ${rate1k(ratePerMillion(units.output))} / 1k out`
      + (units.cacheRead.tokens ? ` · ${rate1k(ratePerMillion(units.cacheRead))} / 1k cache read` : '')
    : 'no token pricing on this node';

  return shell(`
    <div class="row" style="align-items:flex-start;gap:10px">
      <div class="pm ${h(row.pmCls)} pm--lg">${h(row.ini)}</div>
      <div style="flex:1;min-width:0">
        <h2 style="font-family:var(--font-brand);font-size:21px">${h(row.label)}</h2>
        <div class="row row--wrap" style="gap:6px;margin-top:6px">
          <span class="badge mono">${h(row.type)}</span>
          <span class="badge mono">${h(row.model || 'no model')}</span>
          <span class="badge mono" title="node id">${h(row.nodeId || row.id)}</span>
          ${row.agentId ? `<span class="badge ${row.isPrimary === false ? 'badge--warn' : ''} mono"
            title="${row.isPrimary === false
              ? 'Reached by a transfer — this node belongs to that agent.'
              : 'The selected agent.'}">${h(row.agentName || row.agentId)}</span>` : ''}
          ${row.modelOverridden ? `<span class="badge badge--warn mono">override — config says ${h(row.configModel)}</span>` : ''}
        </div>
      </div>
      <button class="btn btn--ghost btn--sm" data-act="close-drawer">Close</button>
    </div>

    <div class="grid grid-2" style="margin-top:16px">
      <div class="tile tile--accent"><div class="tile__k">window spend</div>
        <div class="tile__v">${row.cost ? usd(row.cost) : '$0.00'}</div>
        <div class="tile__note">${pct(row.share)} of agent spend</div></div>
      <div class="tile"><div class="tile__k">per conversation</div>
        <div class="tile__v">${usd(row.cost / convs)}</div>
        <div class="tile__note">hit in ${pct(row.hitRate)} of conversations</div></div>
    </div>

    <div class="grid grid-2" style="margin-top:10px">
      <div class="tile"><div class="tile__k">tokens in / call</div>
        <div class="tile__v">${int(row.tinPerCall)}</div>
        <div class="tile__note">${num(row.tin)} total · ${row.inCost ? usd(row.inCost) + ' in' : 'no input cost'}
          · ${pct(row.tin ? row.cacheRead / row.tin : 0)} cache read</div></div>
      <div class="tile"><div class="tile__k">tokens out / call</div>
        <div class="tile__v">${int(row.toutPerCall)}</div>
        <div class="tile__note">${num(row.tout)} total · ${row.outCost ? usd(row.outCost) + ' out' : 'no output cost'}</div></div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card__head"><h3>Daily spend</h3>
        <div class="sub">${model.days.length} days · ${row.cost ? usd(row.cost / model.days.length) + '/day avg' : 'no spend'}</div></div>
      <div class="card__body">
        <svg class="spark" viewBox="0 0 300 60" preserveAspectRatio="none" style="height:56px">
          <path class="area" d="${sp.areaD}"></path><path d="${sp.lineD}"></path></svg></div>
    </div>

    ${audit ? `<div class="card" style="margin-top:12px">
      <div class="card__head"><h3>Composition</h3><div class="sub">tokens per call, by kind</div></div>
      <div class="card__body" style="padding:8px 14px">
        ${audit.segs.map((s) => `<div class="protorow" style="grid-template-columns:170px 1fr 1fr">
          <div class="k">${h(s.kind)}</div><div class="mono">${int(s.tokens)}</div>
          <div class="small muted">${pct(audit.totalPerCall ? s.tokens / audit.totalPerCall : 0)} of the call</div>
        </div>`).join('')}
      </div>
      <div class="card__foot"><span>Static ${int(audit.staticTokens)} · per-turn ${int(audit.perTurnTokens)}
        ${ctx ? ' · ' + pct(audit.contextUsed) + ' of the ' + num(ctx) + ' context window' : ''}</span></div>
    </div>` : ''}

    <div class="card" style="margin-top:12px">
      <div class="card__head"><h3>Prompt</h3>
        <div class="sub">${row.prompt ? 'authored override, ' + int(row.tinPerCall) + ' tok resolved at runtime'
          : row.type === 'tool' ? 'tool node — no authored prompt' : 'no node-level prompt in the pinned config'}</div></div>
      <div class="card__body"><div class="ph" style="white-space:pre-wrap;color:var(--ink-2);font-size:11.5px;line-height:1.6">${
        h(row.prompt || (row.toolIds || []).join(', ') || '—')}</div></div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card__head"><h3>Timing &amp; volume</h3></div>
      <div class="card__body" style="padding:8px 14px">
        <div class="protorow"><div class="k">calls</div><div class="mono">${int(row.calls)}</div>
          <div class="small muted">${(row.calls / convs).toFixed(2)} per conversation, ${int(row.turnCount)} turns touched</div></div>
        <div class="protorow"><div class="k">latency p50 / p95</div>
          <div class="mono">${ms(row.p50)} / ${ms(row.p95)}</div>
          <div class="small muted">${row.p95 == null ? 'no turn metrics' : row.p95 > 1500 ? 'tail is user-visible on voice' : 'within voice budget'}</div></div>
        <div class="protorow"><div class="k">pricing</div><div class="mono">${h(priceNote)}</div>
          <div class="small muted">as returned with these conversations</div></div>
        <div class="protorow"><div class="k">cache attribution</div>
          <div class="mono">${pct(row.tin ? row.cacheRead / row.tin : 0)}</div>
          <div class="small muted">cache accounting is per conversation per model, not per node — this split is an
            approximation (SPEC §6.5)</div></div>
      </div>
    </div>`);
}

function turnFlags(turn) {
  const flags = [];
  if (turn.interrupted) flags.push('interrupted');
  if (turn.ignored_as_backchannel) flags.push('backchannel');
  if (turn.triggered_guardrails) flags.push('guardrail');
  if (turn.reasoned) flags.push('reasoning');
  if (turn.tool_calls && turn.tool_calls.length) {
    for (const call of turn.tool_calls) flags.push('tool: ' + (call.tool_name || call.tool_id || 'call'));
  }
  if (turn.tool_results && turn.tool_results.length) {
    for (const res of turn.tool_results) if (res.is_error) flags.push('tool failed');
  }
  if (turn.rag_retrieval_info) flags.push('rag');
  return flags;
}

/** Categorical ramp for the node breakdown, plus a neutral for the tail. */
const SLICE_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)',
  'var(--s5)', 'var(--s6)', 'var(--s7)'];
const TAIL_COLOR = 'var(--ink-3)';

/** How many nodes get their own slice before the rest become "other". */
const SLICE_TOP = 7;

/**
 * Tokens per *node*, not per step.
 *
 * The path table lists executions — `Evaluar y Responder` appears five separate
 * times in one real conversation — so reading "which node consumed the tokens"
 * off it means adding rows up by eye. This regroups repeated executions under
 * one node and keeps the execution count, because a node that cost a lot over
 * eight visits is a different finding from one that cost it in a single call.
 */
function nodeTokenBreakdown(steps, names) {
  const byNode = new Map();
  steps.forEach((step, i) => {
    const name = names[i] || {};
    const key = step.nodeId;
    if (!byNode.has(key)) {
      byNode.set(key, { key, label: name.label || step.nodeId, agent: name.agent || null,
        tin: 0, tout: 0, cost: 0, executions: 0 });
    }
    const row = byNode.get(key);
    row.tin += step.tin || 0;
    row.tout += step.tout || 0;
    row.cost += step.cost || 0;
    row.executions += 1;
  });
  return Array.from(byNode.values());
}

/**
 * Donut of one measure across nodes, with its own legend.
 *
 * A slice per node down to `SLICE_TOP`, then one grouped tail — a 40-node
 * conversation rendered as 40 slices is a colour wheel, not a finding. Nodes
 * that contributed nothing to *this* measure are left out entirely rather than
 * drawn as zero-width slices: on a voice agent most nodes emit no output
 * tokens, and they would otherwise fill the legend with noise.
 */
function tokenDonut(rows, measure, title, note) {
  const contributing = rows
    .filter((r) => (r[measure] || 0) > 0)
    .sort((a, b) => b[measure] - a[measure]);
  const total = contributing.reduce((a, r) => a + r[measure], 0);
  if (!total) {
    return `<div class="card" style="flex:1 1 260px;min-width:0">
      <div class="card__head"><h3>${h(title)}</h3></div>
      <div class="card__body"><div class="ph">No ${h(measure === 'tin' ? 'input' : 'output')}
        tokens on this conversation's steps.</div></div>
    </div>`;
  }

  const head = contributing.slice(0, SLICE_TOP);
  const tail = contributing.slice(SLICE_TOP);
  const slices = head.map((r, i) => ({
    label: r.label, agent: r.agent, value: r[measure], executions: r.executions,
    color: SLICE_COLORS[i % SLICE_COLORS.length],
  }));
  if (tail.length) {
    slices.push({
      label: tail.length + ' other node' + (tail.length === 1 ? '' : 's'),
      agent: null,
      value: tail.reduce((a, r) => a + r[measure], 0),
      executions: tail.reduce((a, r) => a + r.executions, 0),
      color: TAIL_COLOR,
    });
  }

  const R = 54;
  const RI = 32;
  const C = 60;
  const pt = (angle, radius) => [
    (C + radius * Math.cos(angle)).toFixed(2),
    (C + radius * Math.sin(angle)).toFixed(2),
  ];
  let start = -Math.PI / 2;
  const arcs = slices.map((sl) => {
    const sweep = (sl.value / total) * Math.PI * 2;
    const end = start + sweep;
    // A slice at 100% is a full turn, and an arc of exactly 2π draws nothing —
    // the start and end points coincide. One conversation can easily run a
    // single node, so this is reached in practice, not in theory.
    if (sl.value === total) {
      start = end;
      return `<circle cx="${C}" cy="${C}" r="${(R + RI) / 2}" fill="none"
        stroke="${sl.color}" stroke-width="${R - RI}"><title>${h(sl.label)} — 100%</title></circle>`;
    }
    const large = sweep > Math.PI ? 1 : 0;
    const [x1, y1] = pt(start, R);
    const [x2, y2] = pt(end, R);
    const [x3, y3] = pt(end, RI);
    const [x4, y4] = pt(start, RI);
    start = end;
    return `<path d="M${x1} ${y1} A${R} ${R} 0 ${large} 1 ${x2} ${y2} L${x3} ${y3}`
      + ` A${RI} ${RI} 0 ${large} 0 ${x4} ${y4} Z" fill="${sl.color}">`
      + `<title>${h(sl.label)} — ${int(sl.value)} tokens, ${pct(sl.value / total)}</title></path>`;
  }).join('');

  return `<div class="card" style="flex:1 1 260px;min-width:0">
    <div class="card__head"><h3>${h(title)}</h3>
      <div class="sub">${h(note)}</div></div>
    <div class="card__body">
      <div class="row row--wrap" style="gap:14px;align-items:center">
        <svg viewBox="0 0 120 120" width="120" height="120" style="flex:none"
             role="img" aria-label="${attr(title)} across ${slices.length} groups">
          ${arcs}
          <text x="${C}" y="${C - 2}" text-anchor="middle"
            style="font-family:var(--font-brand);font-size:15px;fill:var(--ink)">${h(num(total))}</text>
          <text x="${C}" y="${C + 11}" text-anchor="middle"
            style="font-family:var(--font-mono);font-size:7.5px;fill:var(--ink-3);letter-spacing:.1em">TOKENS</text>
        </svg>
        <div class="stack" style="flex:1 1 150px;min-width:0;gap:4px">
          ${slices.map((sl) => `
            <div class="row" style="gap:7px;align-items:baseline;min-width:0">
              <i style="width:9px;height:9px;border-radius:2px;background:${sl.color};flex:none"></i>
              <span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
                white-space:nowrap;font-size:11.5px">${h(sl.label)}${sl.executions > 1
                  ? `<span class="muted"> ×${sl.executions}</span>` : ''}</span>
              <span class="mono" style="flex:none;font-size:10.5px;color:var(--ink-3)">${pct(sl.value / total)}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

export function renderConvDrawer(model, convId) {
  const conv = model.allConversations.find((c) => c.id === convId);
  if (!conv) return '';
  const avg = model.totals.conversations ? model.totals.windowSpend / model.totals.conversations : 0;
  // A turn with neither a workflow node nor any token usage adds a row that says
  // nothing — on a real agent that is every caller turn, which buried the nodes.
  const steps = conv.steps.filter((s) => s.nodeId !== UNATTRIBUTED || s.tin || s.tout || s.cost);
  const hiddenSteps = conv.steps.length - steps.length;
  const maxStep = Math.max(1e-9, ...steps.map((s) => s.cost));
  const transcript = conv.detail.transcript || [];
  // Live shape: charging.analysis.total.price. Kept out of the node ledger
  // entirely (SPEC §6.8) and shown here only for context.
  const analysis = (((conv.detail.metadata || {}).charging || {}).analysis) || {};
  const analysisCost = (analysis.total && typeof analysis.total.price === 'number')
    ? analysis.total.price
    : (typeof analysis.cost_fiat === 'number' ? analysis.cost_fiat : null);
  // One pass, shared by the chart's tooltips and the path table below it, so the
  // two can never disagree about what a step is called.
  const stepNames = steps.map((s) => stepName(model, s));
  // Grouped by node, so the pies answer "which node consumed this" without a
  // reader adding up repeated executions in the path table below.
  const nodeBreakdown = nodeTokenBreakdown(steps, stepNames);
  // Two bases, exactly as at window level (§7.2d): the tiles report what was
  // billed out of `metadata.charging`, while the growth chart, the donuts and
  // the path table all sum `transcript[].llm_usage`. The difference is
  // generation begun and then abandoned, which no turn recorded — so it has no
  // step to sit on and cannot appear in a per-node breakdown.
  const perTurnIn = steps.reduce((a, s) => a + (s.tin || 0), 0);
  const perTurnOut = steps.reduce((a, s) => a + (s.tout || 0), 0);
  const unrecordedIn = Math.max(0, conv.tin - perTurnIn);

  return shell(`
    <div class="cvd__head row" style="align-items:flex-start;gap:10px;padding-bottom:12px">
      <div style="flex:1;min-width:0">
        <h2 style="font-family:var(--font-brand);font-size:21px">Conversation</h2>
        <div class="row row--wrap" style="gap:6px;margin-top:6px">
          <span class="mono small muted">${h(conv.id)}</span>
          <span class="${h(conv.outcome.cls)}">${h(conv.outcome.label)}</span>
          <span class="badge mono">${h(stampOf(conv.startedAt, conv.timezone))}</span>
          <span class="badge mono">${dur(conv.duration)}</span>
          <span class="badge mono">${int(conv.turns)} turns</span>
          ${conv.queueWait ? `<span class="badge mono">${conv.queueWait}s queue (unbilled)</span>` : ''}
          ${conv.onVersion ? '' : '<span class="badge badge--warn mono">other version</span>'}
        </div>
      </div>
      <button class="btn btn--ghost btn--sm" data-act="close-drawer">Close</button>
    </div>

    <div class="cvd">
    <div class="cvd__col cvd__left">

    <div class="card">
      <div class="card__head"><h3>Token growth</h3>
        <div class="sub">cumulative, by step — step numbers match the path on the right</div></div>
      <div class="card__body" style="padding:10px 12px 8px">${tokenGrowthChart(steps, stepNames)}</div>
    </div>

    <div class="row row--wrap" style="gap:12px;align-items:stretch">
      ${tokenDonut(nodeBreakdown, 'tin', 'Input tokens by node',
        'per turn · repeat executions grouped')}
      ${tokenDonut(nodeBreakdown, 'tout', 'Output tokens by node',
        'per turn · what the model wrote')}
    </div>

    <!-- The totals sit under the graphs, on one line: three tiles and the
         all-in note sharing a row, so the left column ends with the summary
         rather than opening on it. -->
    <div class="row row--wrap" style="gap:10px;align-items:stretch">
      <div class="tile tile--accent" style="flex:1 1 130px;min-width:0">
        <div class="tile__k">llm cost</div><div class="tile__v">${usd(conv.cost)}</div>
        <div class="tile__note">${avg ? ((conv.cost / avg - 1) * 100).toFixed(0) + '% vs average' : ''}</div></div>
      <div class="tile" style="flex:1 1 120px;min-width:0">
        <div class="tile__k">tok in</div><div class="tile__v">${num(conv.tin)}</div>
        <div class="tile__note">billed${unrecordedIn > 0
          ? ` · ${num(perTurnIn)} on turns` : ''}</div></div>
      <div class="tile" style="flex:1 1 120px;min-width:0">
        <div class="tile__k">tok out</div><div class="tile__v">${num(conv.tout)}</div>
        <div class="tile__note">billed</div></div>
      <div class="note" style="margin:0;flex:2 1 260px;min-width:0"><span>
        All-in USD <b>${conv.costFiat == null ? 'not reported' : usd(conv.costFiat)}</b>
        ${conv.costCredits != null ? ' · ' + int(conv.costCredits) + ' credits' : ''}
        ${analysisCost != null ? ' · post-call analysis ' + usd(analysisCost) + ', kept out of the node ledger' : ''}.
        The cost tile is LLM turn cost only, which is what the node ledger reconciles against.${
        unrecordedIn > 0 ? ` The graphs above sum <span class="mono">transcript[].llm_usage</span>
        and total ${num(perTurnIn)} input tokens against the ${num(conv.tin)} billed; the
        ${num(unrecordedIn)}-token difference is generation begun and then abandoned, which no turn
        recorded and no node can own.` : ''}
      </span></div>
    </div>

    </div><div class="cvd__col cvd__right">

    <div class="card">
      <div class="card__head"><h3>Where the tokens went</h3><div class="sub">node path, in execution order</div></div>
      <div class="card__body" style="padding:4px 8px">
        <table class="tbl tbl--tight">
          <thead><tr><th class="rank">#</th><th>Node</th><th class="num">Tok in</th><th class="num">Tok out</th>
            <th style="width:90px">Share</th><th class="num">Cost</th></tr></thead>
          <tbody>${steps.map((s, i) => {
            const node = model.nodeById.get(s.nodeId) || {};
            const name = stepNames[i];
            return `<tr><td class="rank">${i + 1}</td>
              <td><div class="row" style="gap:7px">
                <div class="pm ${h(node.pmCls || 'pm--el')}">${h(node.ini || 'fn')}</div>
                <div style="min-width:0">
                  <div class="row" style="gap:5px;align-items:baseline">
                    <span style="font-weight:500"${name.unnamed ? ' class="mono"' : ''}>${h(name.label)}</span>
                    ${name.unnamed ? '<span class="badge mono" style="font-size:9px" title="This node has no authored name and no cached definition, so its id is shown.">unnamed</span>' : ''}
                  </div>
                  <div class="mono" style="font-size:9.5px;color:var(--ink-3)">${h(s.model || node.type || '—')}${
                    name.agent ? ' · ' + h(name.agent) : ''}</div>
                </div>
              </div></td>
              <td class="num">${int(s.tin)}</td><td class="num">${int(s.tout)}</td>
              <td><div class="bartrack"><i class="bar" style="width:${((s.cost / maxStep) * 100).toFixed(0)}%;background:${barBg(s.cost / maxStep)}"></i></div></td>
              <td class="num" style="font-weight:500">${s.cost ? usd(s.cost) : '—'}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      <div class="card__foot"><span>${steps.length} node execution${steps.length === 1 ? '' : 's'}${
        hiddenSteps ? ` · ${hiddenSteps} turn${hiddenSteps === 1 ? '' : 's'} with no node attribution and no tokens hidden` : ''} · input tokens are
        ${pct(conv.tin + conv.tout ? conv.tin / (conv.tin + conv.tout) : 0)} of the volume.
        ${conv.costSource === 'charging'
          ? 'Step costs are per-turn usage; the total above is the billed charging figure.'
          : 'No charging block on this conversation — both figures are per-turn usage.'}</span></div>
    </div>

    <div class="card">
      <div class="card__head"><h3>Transcript</h3><div class="sub">token cost attributed per turn</div></div>
      <div class="card__body stack" style="gap:8px">
        ${transcript.map((turn) => {
          const usage = collectModelUsage(turn.llm_usage);
          const cost = usageCost(usage);
          const tokens = usageTokens(usage);
          const flags = turnFlags(turn);
          return `<div class="row" style="align-items:flex-start;gap:9px">
            <span class="badge mono" style="flex:none">${h(turn.role || '?')}</span>
            <div style="flex:1;min-width:0;font-size:12.5px;color:var(--ink-2)">
              ${h(turn.message || '—')}
              ${flags.length ? `<div class="row row--wrap" style="gap:4px;margin-top:4px">${flags.map((f) =>
                `<span class="badge mono" style="font-size:9.5px">${h(f)}</span>`).join('')}</div>` : ''}
            </div>
            <span class="mono small muted" style="flex:none;text-align:right">
              ${cost ? usd(cost) : '—'}${tokens.input + tokens.output
                ? `<br><span style="font-size:9.5px">↓${int(tokens.input)} ↑${int(tokens.output)}</span>` : ''}
            </span>
          </div>`;
        }).join('')}
      </div>
      <div class="card__foot"><span>Turn costs sum to ${usd(sum(transcript.map((t) => usageCost(collectModelUsage(t.llm_usage)))))} —
        the per-turn view. Billed total is ${usd(conv.cost)}.</span></div>
    </div>

    </div></div>`, 'full');
}
