// Analytics screen — SPEC §5. All aggregation over the same fetched set.

import { levers } from '../derive.js';
import {
  alignedUsd, barBg, h, int, num, pct, rate1m, shortDate, signedPct, spark, sum, usd, usd6,
} from '../util.js';

function tiles(model) {
  const t = model.totals;
  const tokens = t.tin + t.tout;
  const effIn = t.tin ? t.inSpend / t.tin : 0;
  const effOut = t.tout ? t.outSpend / t.tout : 0;
  const mult = effIn ? (effOut / effIn).toFixed(0) + '×' : '—';

  return `<div class="grid grid-4">
    <div class="tile tile--accent"><div class="tile__k">spend</div>
      <div class="tile__v">${usd(t.windowSpend)}</div>
      <div class="tile__note">${model.trend == null
        ? 'previous window not cached — sync it to get a trend'
        : signedPct(model.trend) + ' vs previous window'}</div></div>
    <div class="tile"><div class="tile__k">tokens</div><div class="tile__v">${num(tokens)}</div>
      <div class="tile__note">${num(t.tin)} in · ${num(t.tout)} out</div></div>
    <div class="tile"><div class="tile__k">cost / 1k tokens</div>
      <div class="tile__v">${tokens ? usd6(t.windowSpend / (tokens / 1000)) : '—'}</div>
      <div class="tile__note">blended across ${model.models.length} model${model.models.length === 1 ? '' : 's'}</div></div>
    <div class="tile"><div class="tile__k">output share of spend</div>
      <div class="tile__v">${pct(t.inSpend + t.outSpend ? t.outSpend / (t.inSpend + t.outSpend) : 0)}</div>
      <div class="tile__note">output priced ${mult} input, blended · ${pct(tokens ? t.tout / tokens : 0)} of tokens</div></div>
  </div>`;
}

function dailyCard(model) {
  const days = model.days;
  const max = Math.max(1e-9, ...days.map((d) => d.cost));
  const peak = days.slice().sort((a, b) => b.cost - a.cost)[0];
  const weekday = days.filter((d) => {
    const dow = new Date(d.key + 'T00:00:00Z').getUTCDay();
    return dow >= 1 && dow <= 5;
  });
  const weekend = days.filter((d) => !weekday.includes(d));
  const wdAvg = weekday.length ? sum(weekday.map((d) => d.cost)) / weekday.length : 0;
  const weAvg = weekend.length ? sum(weekend.map((d) => d.cost)) / weekend.length : 0;

  return `<div class="card">
    <div class="card__head"><h3>Daily spend</h3><div class="sub">bars split input / output</div>
      <div class="right legend"><span><i style="background:var(--q4)"></i>input</span>
        <span><i style="background:var(--s2)"></i>output</span></div></div>
    <div class="card__body">
      <div style="display:flex;align-items:flex-end;gap:6px;height:190px">
        ${days.map((d) => {
          const hgt = (d.cost / max) * 148;
          const total = d.inCost + d.outCost || 1;
          return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:5px;min-width:0"
            title="${h(d.key)} — ${usd(d.cost)} over ${int(d.count)} conversations">
            <div style="display:flex;flex-direction:column;justify-content:flex-end;height:150px">
              <div style="background:var(--s2);height:${Math.max(d.cost ? 2 : 0, hgt * (d.outCost / total)).toFixed(1)}px;border-radius:3px 3px 0 0"></div>
              <div style="background:var(--q4);height:${Math.max(d.cost ? 2 : 0, hgt * (d.inCost / total)).toFixed(1)}px"></div>
            </div>
            <div class="mono" style="font-size:8.5px;color:var(--ink-3);text-align:center;white-space:nowrap">${h(shortDate(d.key).replace(' ', ' '))}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="card__foot">
      <span class="mono">peak ${peak ? h(shortDate(peak.key)) + ' · ' + usd(peak.cost) : '—'}</span>
      <span class="prov"><span class="sep"></span></span>
      <span>${weAvg > 0 ? 'weekday volume runs ' + (wdAvg / weAvg).toFixed(1) + '× weekend'
        : 'bucketed on start_time_unix_secs in ' + h(model.timezone)}</span>
    </div>
  </div>`;
}

function driversCard(model) {
  const drivers = model.ledger.filter((r) => r.cost > 0).slice(0, 6);
  const max = Math.max(1e-9, ...drivers.map((r) => r.share));
  const top2 = model.ledger.slice(0, 2);
  const conc = top2.length >= 2
    ? top2.map((r) => r.label).join(' + ') + ' carry ' + pct(top2[0].share + top2[1].share) + ' of window spend'
    : 'one node carries the window';

  return `<div class="card">
    <div class="card__head"><h3>Cost drivers</h3><div class="sub">node share of window spend</div></div>
    <div class="card__body stack" style="gap:9px">
      ${drivers.length ? drivers.map((r) => `
        <div class="barrow">
          <div class="barrow__t"><div class="pm ${h(r.pmCls)}">${h(r.ini)}</div><span>${h(r.label)}</span></div>
          <div class="bartrack"><i class="bar" style="width:${((r.share / max) * 100).toFixed(0)}%;background:${barBg(r.share / max)}"></i></div>
          <div class="barrow__v">${usd(r.cost)}</div>
        </div>`).join('') : '<div class="empty">No priced node traffic in this window.</div>'}
    </div>
    <div class="card__foot"><span>${h(conc)}</span></div>
  </div>`;
}

function modelTable(model, compact) {
  if (!model.models.length) return '<div class="empty">No model usage in this window.</div>';
  return `<table class="tbl tbl--tight">
    <thead><tr><th>Model</th><th class="num">Calls</th><th class="num">Tok in</th><th class="num">Tok out</th>
      ${compact ? '' : '<th class="num">$/1M in</th><th class="num">$/1M out</th>'}<th class="num">Spend</th></tr></thead>
    <tbody>${model.models.map((m) => `
      <tr><td><div class="row" style="gap:7px">${compact ? '' : `<div class="pm ${h(m.pmCls)}">${h(m.ini)}</div>`}
        <span class="mono" style="font-size:11.5px">${h(m.name)}</span></div></td>
        <td class="num">${int(m.calls)}</td><td class="num">${num(m.tin)}</td><td class="num">${num(m.tout)}</td>
        ${compact ? '' : `<td class="num muted">${rate1m(m.priceIn)}</td><td class="num muted">${rate1m(m.priceOut)}</td>`}
        <td class="num" style="font-weight:500">${usd(m.cost)}</td></tr>`).join('')}
    </tbody></table>`;
}

/** Format one input of a lever's derivation according to its kind. */
function termValue(term) {
  if (term.kind === 'int') return int(term.value);
  if (term.kind === 'rate') return rate1m(term.value) + ' / 1M';
  if (term.kind === 'pct') return pct(term.value);
  if (term.kind === 'usd') return usd(term.value);
  return String(term.value);
}

/**
 * The derivation, in the product rather than only in the README. Uses the
 * design system's explainer component: the formula is always visible, the
 * inputs and their provenance open on hover or keyboard focus.
 */
function leverExplainer(lever) {
  return `<span class="why" tabindex="0" style="display:inline-block;margin-top:6px">
    <span class="mono" style="font-size:10.5px;color:var(--ink-3)">${h(lever.formula)}</span>
    <span class="why__pop">
      <span style="display:block;color:var(--ink);font-weight:500">How this number is built</span>
      <span class="formula">${h(lever.formula)}</span>
      ${lever.terms.map((t) => `<span style="display:block;margin-bottom:6px">
        <span class="row" style="gap:8px;align-items:baseline">
          <span class="mono small" style="flex:1;min-width:0;color:var(--ink-3)">${h(t.label)}</span>
          <b class="mono" style="flex:none">${h(termValue(t))}</b>
        </span>
        <span class="small muted" style="display:block">${h(t.note)}</span>
      </span>`).join('')}
      <span style="display:block;margin-top:4px">${h(lever.basisNote)}</span>
    </span>
  </span>`;
}

function leversCard(model) {
  const rows = levers(model);
  // One precision across all three, so the savings can be compared directly.
  const money = alignedUsd(rows.map((l) => l.save));
  return `<div class="card">
    <div class="card__head"><h3>Where to cut</h3><div class="sub">largest single levers</div></div>
    <div class="card__body stack" style="gap:10px">
      ${rows.length ? rows.map((l) => `
        <div class="note"><div style="min-width:0">
          <div class="row row--wrap" style="gap:8px;margin-bottom:3px">
            <span style="color:var(--ink);font-weight:500">${h(l.title)}</span>
            <span class="badge ${l.basis === 'measured' ? 'badge--ok' : 'badge--warn'} mono"
                  title="${h(l.basisNote)}">${l.basis === 'measured' ? 'measured base' : 'estimated base'}</span>
          </div>
          <div>${h(l.body)}</div>
          <div class="mono small" style="color:var(--ok);margin-top:5px">est. −${money(l.save)} / window
            <span class="muted">· ${h(l.assumption)}</span></div>
          ${leverExplainer(l)}
        </div></div>`).join('') : '<div class="empty">Not enough priced traffic to size a lever.</div>'}
    </div>
    <div class="card__foot"><span>Editorial: the three levers are fixed heuristics, and each applies a reduction
      factor that is assumed rather than measured. The token counts and rates behind them come from this window —
      hover a formula to see every input. Estimates, not quoted savings.</span></div>
  </div>`;
}

function nodeDayLedger(model, state) {
  const days = model.days;
  const rows = model.ledger.filter((r) => r.calls > 0);
  const convs = model.totals.conversations || 1;

  return `<div class="card">
    <div class="card__head"><h3>Node × day ledger</h3>
      <div class="sub">spend per node per day, with the daily shape inline</div>
      <div class="right"><span class="badge mono">${days.length}d to ${h(shortDate(state.to))}</span></div></div>
    <div class="card__body" style="padding:4px 8px;overflow-x:auto">
      <table class="tbl tbl--tight">
        <thead><tr><th>Node</th><th>Model</th><th style="width:120px">Shape</th><th class="num">Calls</th>
          <th class="num">Tok/call</th><th class="num">$/conv</th><th class="num">Day min</th>
          <th class="num">Day max</th><th class="num">Window</th></tr></thead>
        <tbody>${rows.map((r) => {
          const vals = days.map((d) => (r.byDay.get(d.key) || 0) * model.totals.scale);
          const sp = spark(vals, 100, 30);
          return `<tr class="is-click" data-act="open-node" data-id="${h(r.id)}">
            <td><div class="row" style="gap:7px"><div class="pm ${h(r.pmCls)}">${h(r.ini)}</div>
              <span style="font-weight:500">${h(r.label)}</span></div></td>
            <td class="mono small muted">${h(r.model || '—')}</td>
            <td><svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" style="height:26px">
              <path class="area" d="${sp.areaD}"></path><path d="${sp.lineD}"></path></svg></td>
            <td class="num">${int(r.calls)}</td>
            <td class="num">${int(r.tinPerCall + r.toutPerCall)}</td>
            <td class="num">${usd(r.cost / convs)}</td>
            <td class="num muted">${usd(vals.length ? Math.min(...vals) : 0)}</td>
            <td class="num muted">${usd(vals.length ? Math.max(...vals) : 0)}</td>
            <td class="num" style="font-weight:500">${usd(r.cost)}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div class="card__foot"><span>Daily node spend is the per-turn group-by bucketed on the conversation's start day in
      ${h(model.timezone)}, scaled to the billed total by the same factor as the ledger.</span></div>
  </div>`;
}

function outliers(model) {
  const rows = model.conversations.slice().sort((a, b) => b.cost - a.cost).slice(0, 8);
  return `<div class="card"><div class="card__head"><h3>Most expensive conversations</h3>
      <div class="sub">the p90 tail</div></div>
    <div class="card__body" style="padding:4px 8px">
      <table class="tbl tbl--tight">
        <thead><tr><th>Conversation</th><th class="num">Turns</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>
        <tbody>${rows.map((c) => `<tr class="is-click" data-act="open-conv" data-id="${h(c.id)}">
          <td class="mono" style="font-size:11.5px">${h(c.id)}</td><td class="num">${int(c.turns)}</td>
          <td class="num">${num(c.tin + c.tout)}</td>
          <td class="num" style="font-weight:500">${usd(c.cost)}</td></tr>`).join('')}</tbody>
      </table>
    </div></div>`;
}

export function renderAnalytics(model, state) {
  const layouts = [['overview', 'Overview'], ['ledger', 'Ledger']];
  const head = `
  <div class="page__head">
    <div><h1>Token analytics</h1>
      <div class="sub">${h(state.rangeLong)} · ${int(model.totals.conversations)} conversations · every number below is
        derived from per-node token counts, not sampled.</div></div>
    <div class="page__actions"><div class="seg">${layouts.map(([k, label]) =>
      `<button data-act="layout" data-id="${k}" aria-pressed="${state.layout === k}">${label}</button>`).join('')}</div></div>
  </div>`;

  if (state.layout === 'ledger') {
    return head + nodeDayLedger(model, state) + `
      <div class="grid grid-2" style="margin-top:12px">
        <div class="card"><div class="card__head"><h3>Model mix</h3></div>
          <div class="card__body" style="padding:4px 8px">${modelTable(model, true)}</div></div>
        ${outliers(model)}
      </div>`;
  }

  return head + tiles(model) + `
    <div class="split" style="margin-top:12px">${dailyCard(model)}${driversCard(model)}</div>
    <div class="split" style="margin-top:12px">
      <div class="card"><div class="card__head"><h3>Model mix</h3>
        <div class="sub">where the money actually goes</div></div>
        <div class="card__body" style="padding:4px 8px;overflow-x:auto">${modelTable(model, false)}</div>
        <div class="card__foot"><span>Prices are the ones the API returned with these conversations, so they already
          reflect the workspace tier, burst status and any dev discount.</span></div></div>
      ${leversCard(model)}
    </div>`;
}
