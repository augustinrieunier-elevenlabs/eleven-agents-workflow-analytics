// Node and conversation drawers — SPEC §2 / §4.

import {
  UNATTRIBUTED, collectModelUsage, ratePerMillion, usageCost, usageTokens,
} from '../derive.js';
import { contextWindow } from '../models.js';
import {
  barBg, dur, h, int, ms, num, pct, rate1k, spark, stampOf, sum, usd,
} from '../util.js';

function shell(inner) {
  return `<div class="scrim" data-act="close-drawer"></div><div class="drawer">${inner}</div>`;
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

  return shell(`
    <div class="row" style="align-items:flex-start;gap:10px">
      <div style="flex:1;min-width:0">
        <h2 style="font-family:var(--font-brand);font-size:21px">Conversation</h2>
        <div class="mono small muted" style="margin-top:4px">${h(conv.id)}</div>
        <div class="row row--wrap" style="gap:6px;margin-top:8px">
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

    <div class="grid grid-3" style="margin-top:16px">
      <div class="tile tile--accent"><div class="tile__k">llm cost</div><div class="tile__v">${usd(conv.cost)}</div>
        <div class="tile__note">${avg ? ((conv.cost / avg - 1) * 100).toFixed(0) + '% vs average' : ''}</div></div>
      <div class="tile"><div class="tile__k">tok in</div><div class="tile__v">${num(conv.tin)}</div></div>
      <div class="tile"><div class="tile__k">tok out</div><div class="tile__v">${num(conv.tout)}</div></div>
    </div>

    <div class="note" style="margin-top:10px"><span>
      All-in USD <b>${conv.costFiat == null ? 'not reported' : usd(conv.costFiat)}</b>
      ${conv.costCredits != null ? ' · ' + int(conv.costCredits) + ' credits' : ''}
      ${analysisCost != null ? ' · post-call analysis ' + usd(analysisCost) + ', kept out of the node ledger' : ''}.
      The cost tile above is LLM turn cost only, which is what the node ledger reconciles against.
    </span></div>

    <div class="card" style="margin-top:12px">
      <div class="card__head"><h3>Where the tokens went</h3><div class="sub">node path, in execution order</div></div>
      <div class="card__body" style="padding:4px 8px">
        <table class="tbl tbl--tight">
          <thead><tr><th class="rank">#</th><th>Node</th><th class="num">Tok in</th><th class="num">Tok out</th>
            <th style="width:90px">Share</th><th class="num">Cost</th></tr></thead>
          <tbody>${steps.map((s, i) => {
            const node = model.nodeById.get(s.nodeId) || {};
            return `<tr><td class="rank">${i + 1}</td>
              <td><div class="row" style="gap:7px">
                <div class="pm ${h(node.pmCls || 'pm--el')}">${h(node.ini || 'fn')}</div>
                <div><div style="font-weight:500">${h(s.label)}</div>
                  <div class="mono" style="font-size:9.5px;color:var(--ink-3)">${h(s.model || node.type || '—')}</div></div>
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

    <div class="card" style="margin-top:12px">
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
    </div>`);
}
