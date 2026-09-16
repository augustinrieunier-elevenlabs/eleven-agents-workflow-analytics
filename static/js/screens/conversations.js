// Conversations screen — SPEC §4.

import { dur, h, int, num, pct, quantile, stampOf, sum, usd, versionSelect } from '../util.js';

export function outcomeFilters(model) {
  const seen = new Map();
  for (const c of model.conversations) {
    if (!seen.has(c.outcome.label)) seen.set(c.outcome.label, 0);
    seen.set(c.outcome.label, seen.get(c.outcome.label) + 1);
  }
  return ['All', ...Array.from(seen.keys()).sort()];
}

export function filterConversations(model, filter) {
  const rows = model.conversations;
  return filter === 'All' ? rows : rows.filter((c) => c.outcome.label === filter);
}

function pathDots(conv) {
  const max = Math.max(1e-9, ...conv.steps.map((s) => s.cost));
  return `<div class="pathdots">${conv.steps.map((s) => {
    const t = s.cost / max;
    const bg = s.cost <= 0 ? 'var(--line)' : t > 0.55 ? 'var(--ink)' : 'var(--q4)';
    return `<i title="${h(s.label)} — ${usd(s.cost)}" style="background:${bg}"></i>`;
  }).join('')}</div>`;
}

function tiles(model, shown) {
  const t = model.totals;
  const shownSpend = sum(shown.map((c) => c.cost));
  const costs = model.conversations.map((c) => c.cost).sort((a, b) => a - b);
  const p90 = quantile(costs, 0.9);
  const tail = sum(costs.slice(Math.floor(costs.length * 0.9)));
  const avgTurns = model.conversations.length
    ? sum(model.conversations.map((c) => c.turns)) / model.conversations.length : 0;
  const avgNodes = model.conversations.length
    ? sum(model.conversations.map((c) => c.steps.length)) / model.conversations.length : 0;

  return `<div class="grid grid-4" style="margin-bottom:14px">
    <div class="tile"><div class="tile__k">shown</div><div class="tile__v">${int(shown.length)}</div>
      <div class="tile__note">of ${int(t.conversations)} in window</div></div>
    <div class="tile"><div class="tile__k">spend shown</div><div class="tile__v">${usd(shownSpend)}</div>
      <div class="tile__note">${pct(t.windowSpend ? shownSpend / t.windowSpend : 0)} of window</div></div>
    <div class="tile"><div class="tile__k">p90 cost</div><div class="tile__v">${usd(p90)}</div>
      <div class="tile__note">tail is ${pct(t.windowSpend ? tail / t.windowSpend : 0)} of spend</div></div>
    <div class="tile"><div class="tile__k">avg turns</div><div class="tile__v">${avgTurns.toFixed(1)}</div>
      <div class="tile__note">${avgNodes.toFixed(1)} nodes touched avg</div></div>
  </div>`;
}

export function renderConversations(model, state) {
  const filters = outcomeFilters(model);
  const shown = filterConversations(model, state.convFilter);
  const limit = state.convLimit || 60;
  const page = shown.slice(0, limit);

  return `
  <div class="page__head">
    <div><h1>Conversations</h1>
      <div class="sub">Each row is one conversation in the window, costed from its own node path. Open one to see
        where its tokens went.</div></div>
    <div class="page__actions">
      ${versionSelect(state)}
      <div class="seg">${filters.map((f) =>
        `<button data-act="conv-filter" data-id="${h(f)}" aria-pressed="${state.convFilter === f}">${h(f)}</button>`).join('')}</div>
    </div>
  </div>

  ${tiles(model, shown)}

  <div class="card"><div class="card__body" style="padding:4px 8px;overflow-x:auto">
    <table class="tbl tbl--tight">
      <thead><tr>
        <th>Conversation</th><th>Started</th><th class="num">Dur</th><th class="num">Turns</th>
        <th>Path</th><th class="num">Tok in</th><th class="num">Tok out</th><th>Outcome</th><th class="num">Cost</th>
      </tr></thead>
      <tbody>
        ${page.map((c) => `
        <tr class="is-click" data-act="open-conv" data-id="${h(c.id)}">
          <td class="mono" style="font-size:11.5px">${h(c.id)}</td>
          <td class="mono small muted">${h(stampOf(c.startedAt, c.timezone))}</td>
          <td class="num muted">${dur(c.duration)}</td>
          <td class="num">${int(c.turns)}</td>
          <td>${pathDots(c)}</td>
          <td class="num">${num(c.tin)}</td>
          <td class="num">${num(c.tout)}</td>
          <td><span class="${h(c.outcome.cls)}">${h(c.outcome.label)}</span></td>
          <td class="num" style="font-weight:500">${usd(c.cost)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div class="card__foot">
    <span>Showing ${int(page.length)} of ${int(shown.length)}. Duration is billed call length;
      <span class="mono">queue_wait_secs</span> is excluded from it.</span>
    <span class="spacer"></span>
    ${shown.length > page.length ? `<button class="btn btn--sm" data-act="conv-more">Show 60 more</button>` : ''}
  </div>
  </div>`;
}
