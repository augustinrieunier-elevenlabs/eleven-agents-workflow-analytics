// Tools screen — SPEC §3c.
//
// One row per tool actually invoked in the window. Every figure here is a
// group-by over `transcript[].tool_calls` joined to `tool_results` by
// `request_id`; the API has no per-tool endpoint and no tool line item in
// `charging`, so there is no such thing as "the cost of this tool" and the
// screen does not print one.
//
// What it does print, kept apart on purpose:
//   Params out      measured   output tokens the model generated for the call
//   ~Schema         estimated  the JSON schema, resident on every call to a
//                              node it is attached to, fired or not
//   ~Result         estimated  the payload injected on the next call, sized
//                              from characters rather than tokenized (§7.12)
//   Exposure        billed     money on turns that called it — exact, and NOT
//                              caused by the tool. A tool on an expensive node
//                              looks expensive; that is the node's prompt.
//
// Workflow plumbing is excluded: `progress_workflow`, `notify_condition_*`, and
// the system markers nobody declared (`start_procedure`, `end_procedure`,
// `guardrail_triggered`, `end_call`). Built-ins an agent *declares* in
// `built_in_tools` are kept — someone chose those. The excluded count is stated
// rather than dropped.
//
// The screen also reconciles the two directions that can disagree: a tool
// attached to a node but never invoked (pure carry — its schema rides every
// call), and a tool invoked but attached nowhere in the cached config (the
// traffic ran a configuration this cache no longer holds).

import { tokenizerExact, tokenizerSource } from '../tokenizer.js';
import {
  barBg, h, int, num, pageCount, pageSlice, pager, pct, sortHeader, sortRowsBy, usd, versionSelect,
} from '../util.js';

/** `~` on anything the local tokenizer or a character count produced. */
const est = (value, render) => (value == null ? '—' : '~' + render(value));

/**
 * The printed report drops the two character-average columns.
 *
 * Fourteen columns do not fit A4 landscape at a readable size, and characters
 * are the raw material rather than the answer — the token averages beside them
 * carry the cost meaning, and the per-call character sizes stay on screen in
 * the row detail. Twelve is the width the prompt audit already prints at.
 */
const REPORT_SKIP = new Set(['paramChars', 'resultChars']);

export const TOOL_COLUMNS = [
  { key: 'name', label: 'Tool', sortOn: (r) => String(r.name || '').toLowerCase() },
  { key: 'type', label: 'Kind', sortOn: (r) => String(r.type || '') },
  { key: 'calls', label: 'Calls', num: true, sortOn: (r) => r.calls },
  { key: 'conversations', label: 'Reach', sub: 'conversations', num: true, sortOn: (r) => r.conversations },
  { key: 'callsPerConv', label: 'Calls', sub: 'per conversation', num: true, sortOn: (r) => r.callsPerConv },
  { key: 'callsWhenUsed', label: 'When used', sub: 'calls/conv', num: true, sortOn: (r) => r.callsWhenUsed },
  { key: 'errors', label: 'Errors', num: true, sortOn: (r) => r.errorRate },
  { key: 'p95', label: 'Latency', sub: 'p50 / p95', num: true, sortOn: (r) => (r.p95 == null ? -1 : r.p95) },
  // Averages are the sortable value and totals sit underneath, because per-call
  // is what compares across tools: a tool called once should not read as cheap
  // beside one called eighty times.
  { key: 'paramsOut', label: 'Params out', sub: 'avg tok/call', num: true, sortOn: (r) => r.paramsOutPerCall },
  { key: 'paramChars', label: 'Params size', sub: 'avg ch/call', num: true, sortOn: (r) => r.paramCharsPerCall },
  { key: 'schemaTokens', label: 'Schema', sub: 'tok, resident', num: true, sortOn: (r) => (r.schemaTokens == null ? -1 : r.schemaTokens) },
  { key: 'resultTokens', label: 'Result in', sub: 'avg tok/call', num: true, sortOn: (r) => r.resultTokensPerCall },
  { key: 'resultChars', label: 'Result size', sub: 'avg ch/call', num: true, sortOn: (r) => r.resultCharsPerCall },
  { key: 'turnSpend', label: 'Exposure', sub: 'spend on its turns', num: true, sortOn: (r) => r.turnSpend },
];

function tiles(model) {
  const t = model.tools.totals;
  const worst = model.tools.rows.slice()
    .filter((r) => r.calls >= 5)
    .sort((a, b) => b.errorRate - a.errorRate)[0];
  return `<div class="grid grid-5">
    <div class="tile tile--accent"><div class="tile__k">tool calls</div>
      <div class="tile__v">${int(t.calls)}</div>
      <div class="tile__note">${t.callsPerConv.toFixed(2)} per conversation across
        ${int(t.tools)} tool${t.tools === 1 ? '' : 's'}</div></div>
    <div class="tile"><div class="tile__k">error rate</div>
      <div class="tile__v">${pct(t.errorRate)}</div>
      <div class="tile__note">${int(t.errors)} failed call${t.errors === 1 ? '' : 's'}${
        worst && worst.errorRate > 0 ? ' · worst ' + h(worst.name) + ' at ' + pct(worst.errorRate) : ''}</div></div>
    <div class="tile"><div class="tile__k">slowest p95</div>
      <div class="tile__v">${t.worstP95 == null ? '—' : t.worstP95.toFixed(2) + 's'}</div>
      <div class="tile__note">tool latency, not LLM latency — this is dead air on a voice call</div></div>
    <div class="tile"><div class="tile__k">result tokens injected</div>
      <div class="tile__v">~${num(t.resultTokens)}</div>
      <div class="tile__note">~${num(Math.round(t.resultTokensPerCall))} per call ·
        ${num(t.resultChars)} characters of tool output returned into context${t.chattiest
          ? ' · widest ' + h(t.chattiest) + ' at ' + num(Math.round(t.chattiestPerCall)) + ' ch/call' : ''}</div></div>
    <div class="tile"><div class="tile__k">exposure</div>
      <div class="tile__v">${usd(t.turnSpend)}</div>
      <div class="tile__note">${pct(t.turnShare)} of window spend sits on turns that called a
        tool — reach, not the tools' own cost</div></div>
  </div>`;
}

/** Expandable evidence for one tool. No payload values, ever — see §3c. */
function detail(row) {
  return `<tr><td colspan="${TOOL_COLUMNS.length}" style="background:var(--bg-3);padding:12px 14px">
    <div class="stack" style="gap:10px">
      ${row.description ? `<div style="font-size:12.5px;color:var(--ink-2);max-width:80ch">${h(row.description)}</div>` : ''}
      <div class="row row--wrap" style="gap:18px;align-items:flex-start">
        <div style="min-width:180px">
          <div class="field__k">latency</div>
          <div class="mono small">${row.p50 == null ? 'not reported' : `p50 ${row.p50.toFixed(2)}s ·
            p95 ${row.p95.toFixed(2)}s · max ${row.maxLatency.toFixed(2)}s`}</div>
          <div class="small muted" style="margin-top:3px">from
            <span class="mono">tool_latency_secs</span>, measured</div>
        </div>
        <div style="min-width:180px">
          <div class="field__k">payloads, per call</div>
          <div class="mono small">params ${num(Math.round(row.paramCharsPerCall))} ch ·
            results ${num(Math.round(row.resultCharsPerCall))} ch
            (~${num(Math.round(row.resultTokensPerCall))} tok)</div>
          ${row.paramCharsPerCall > 0 && row.resultCharsPerCall / row.paramCharsPerCall >= 10
            ? `<div class="small" style="margin-top:3px;color:var(--warn)">Returns
               <b>${Math.round(row.resultCharsPerCall / row.paramCharsPerCall)}×</b> what it sends —
               a ${num(Math.round(row.paramCharsPerCall))}-character query brings back
               ${num(Math.round(row.resultCharsPerCall))} characters, and all of it lands in the
               next call's context.</div>`
            : ''}
          <div class="small muted" style="margin-top:3px">over ${int(row.calls)} call${row.calls === 1 ? '' : 's'}:
            ${num(row.paramChars)} ch in, ${num(row.resultChars)} ch back; largest single result
            ${num(row.maxResultChars)} ch. Sizes only — payload text is never read into the UI
            or the export.</div>
        </div>
        <div style="min-width:180px">
          <div class="field__k">schema</div>
          <div class="mono small">${row.schemaKnown
            ? est(row.schemaTokens, (v) => int(v) + ' tok')
            : 'no cached tool document'}</div>
          <div class="small muted" style="margin-top:3px">${row.schemaKnown
            ? 'resident in the prompt of every call to a node this is attached to'
            : 'run a sync to pull it; the columns read — rather than guessing'}</div>
        </div>
      </div>

      ${row.errorTypes.length ? `<div>
        <div class="field__k">failures by error_type</div>
        <div class="row row--wrap" style="gap:6px;margin-top:4px">${row.errorTypes.map((e) =>
          `<span class="badge badge--fail mono">${h(e.kind)} ×${e.count}</span>`).join('')}</div>
        <div class="small muted" style="margin-top:4px">Messages are deliberately not shown:
          <span class="mono">raw_error_message</span> can echo caller data.</div>
      </div>` : ''}

      <div class="row row--wrap" style="gap:18px;align-items:flex-start">
        <div style="flex:1 1 260px;min-width:0">
          <div class="field__k">called from</div>
          <div class="row row--wrap" style="gap:5px;margin-top:4px">${row.nodes.length
            ? row.nodes.map((n) => `<span class="badge mono">${h(n.label)}</span>`).join('')
            : '<span class="muted small">no node attribution on these turns</span>'}</div>
        </div>
        ${row.agents.length > 1 ? `<div style="flex:0 1 220px">
          <div class="field__k">agents</div>
          <div class="row row--wrap" style="gap:5px;margin-top:4px">${row.agents.map((a) =>
            `<span class="badge mono">${h(a.name)}</span>`).join('')}</div>
        </div>` : ''}
        <div style="flex:1 1 260px;min-width:0">
          <div class="field__k">attached to</div>
          <div class="row row--wrap" style="gap:5px;margin-top:4px">${row.attachedNodes.length
            ? row.attachedNodes.map((n) => `<span class="badge mono"
                title="${n.calls} call${n.calls === 1 ? '' : 's'} on this node in the window">${h(n.label)}</span>`).join('')
            : '<span class="badge badge--warn mono">nowhere in the cached config</span>'}</div>
          ${row.attachedNodes.length && !row.attachedNodes.some((n) => row.nodes.some((c) => c.id === n.id))
            ? `<div class="small muted" style="margin-top:4px">Called from a different node than the one
               it is attached to — the traffic ran a configuration this cache no longer holds.</div>` : ''}
        </div>
        ${row.variables.length ? `<div style="flex:1 1 220px;min-width:0">
          <div class="field__k">writes variables</div>
          <div class="row row--wrap" style="gap:5px;margin-top:4px">${row.variables.map((v) =>
            `<span class="badge mono">${h(v)}</span>`).join('')}</div>
        </div>` : ''}
      </div>
    </div>
  </td></tr>`;
}

function row(r, model, open) {
  const maxSpend = Math.max(1e-9, ...model.tools.rows.map((x) => x.turnSpend));
  return `
    <tr class="is-click${open ? ' th-sort--on' : ''}" data-act="tool-open" data-id="${h(r.name)}">
      <td><div class="row" style="gap:7px">
        <div class="pm pm--el">${h(r.type === 'mcp' ? 'M' : r.type.startsWith('api') ? 'AI' : 'fn')}</div>
        <div style="min-width:0">
          <div class="row" style="gap:5px;align-items:baseline">
            <span style="font-weight:500">${h(r.name)}</span>
            ${r.attached ? '' : `<span class="badge badge--warn mono" style="font-size:9px"
              title="Invoked here, but attached to no node in the cached configuration. The traffic ran a config this cache does not hold — which is also why its schema column is empty.">not in config</span>`}
          </div>
          ${r.schemaKnown ? '' : '<div class="mono" style="font-size:9.5px;color:var(--ink-3)">schema not cached</div>'}
        </div>
      </div></td>
      <td class="mono small muted">${h(r.type)}</td>
      <td class="num">${int(r.calls)}</td>
      <td class="num">${int(r.conversations)}<span class="thn">${pct(r.reach)} of window</span></td>
      <td class="num">${r.callsPerConv.toFixed(2)}</td>
      <td class="num">${r.callsWhenUsed.toFixed(1)}</td>
      <td class="num">${r.errors
        ? `<span class="badge badge--fail mono">${int(r.errors)}</span><span class="thn">${pct(r.errorRate)}</span>`
        : '<span class="muted">0</span>'}</td>
      <td class="num">${r.p95 == null ? '<span class="muted">—</span>'
        : `${r.p95.toFixed(2)}s<span class="thn">p50 ${r.p50.toFixed(2)}s</span>`}</td>
      <td class="num">${int(Math.round(r.paramsOutPerCall))}<span class="thn">${int(r.paramsOut)} total</span></td>
      <td class="num">${num(Math.round(r.paramCharsPerCall))}<span class="thn">${num(r.paramChars)} total</span></td>
      <td class="num">${r.schemaKnown ? est(r.schemaTokens, int) : '<span class="muted">—</span>'}</td>
      <td class="num">~${num(Math.round(r.resultTokensPerCall))}<span class="thn">~${num(r.resultTokens)} total</span></td>
      <td class="num">${num(Math.round(r.resultCharsPerCall))}<span class="thn">max ${num(r.maxResultChars)}</span></td>
      <td class="num" style="font-weight:500">${usd(r.turnSpend)}
        <div class="bartrack" style="margin-top:3px"><i class="bar"
          style="width:${((r.turnSpend / maxSpend) * 100).toFixed(0)}%;background:${barBg(r.turnSpend / maxSpend)}"></i></div></td>
    </tr>
    ${open ? detail(r) : ''}`;
}

/**
 * Attached and never called.
 *
 * The other half of the reconciliation: a tool the config attaches to a node
 * puts its JSON schema in that node's prompt on **every** call, whether or not
 * the model ever invokes it. A tool that never fires is pure carry.
 *
 * Resident tokens are the schema estimate times the node's measured call count,
 * so a tool attached to a node that did not run in this window correctly shows
 * nothing rather than a scary number.
 */
function unusedCard(model) {
  const unused = model.tools.unused;
  if (!unused.length) return '';
  const carrying = unused.filter((u) => u.calls > 0);
  return `<div class="card" style="margin-top:14px">
    <div class="card__head"><h3>Attached but never called</h3>
      <div class="sub">schema carried in the prompt, earning nothing</div></div>
    <div class="card__body" style="padding:4px 8px;overflow-x:auto">
      <table class="tbl tbl--tight">
        <thead><tr><th>Tool</th><th>Kind</th><th>Attached to</th>
          <th class="num">Calls on those nodes</th><th class="num">Schema<span class="thn">tok</span></th>
          <th class="num">Resident<span class="thn">tok/window</span></th><th class="num">Carry cost</th></tr></thead>
        <tbody>${unused.map((u) => `
          <tr>
            <td><span style="font-weight:500">${h(u.name)}</span></td>
            <td class="mono small muted">${u.builtIn ? 'built-in' : 'tool'}</td>
            <td class="small">${u.nodes.map((n) => h(n.label)).join(', ') || '—'}</td>
            <td class="num">${int(u.calls)}</td>
            <td class="num">${u.schemaTokens == null ? '<span class="muted">—</span>' : '~' + int(u.schemaTokens)}</td>
            <td class="num">${u.residentTokens == null ? '<span class="muted">—</span>' : '~' + num(u.residentTokens)}</td>
            <td class="num" style="font-weight:500">${u.cost == null ? '<span class="muted">—</span>'
              : u.cost > 0 ? '~' + usd(u.cost) : '<span class="muted">$0</span>'}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="card__foot"><span>${int(unused.length)} attached tool${unused.length === 1 ? '' : 's'}
      went uncalled in this window${carrying.length
        ? `, ${int(carrying.length)} of them on a node that did run — that is the part you are paying for`
        : '. None of their nodes ran in this window, so nothing was carried'}.
      A built-in has no tool document, so its schema size is unknowable and reads —.</span></div>
  </div>`;
}

function table(model, state) {
  const all = model.tools.rows;
  if (!all.length) {
    return `<div class="empty">No authored tool was invoked in this window.${
      model.tools.excluded.calls
        ? ` ${int(model.tools.excluded.calls)} workflow and system calls were excluded — see the note above.`
        : ''}</div>`;
  }
  const sort = state.toolSort || { key: 'calls', dir: 'desc' };
  const info = pageSlice(sortRowsBy(all, TOOL_COLUMNS, sort), state.toolPage);
  return `<div class="card">
    <div class="card__body" style="padding:4px 8px;overflow-x:auto">
      <table class="tbl tbl--tight">
        ${sortHeader(TOOL_COLUMNS, sort, 'tool-sort')}
        <tbody>${info.rows.map((r) => row(r, model, state.toolOpen === r.name)).join('')}</tbody>
      </table>
    </div>
    <div class="card__foot">
      <span>${pageCount(info, 'tools')}. Payload columns show the <b>average per call</b> with the
        window total beneath, because per-call is what compares across tools.
        Click a row for its schema size, failures and callers.
        <b>Exposure</b> is billed spend on turns that called the tool — exact money, but caused by
        the node's prompt, not by the tool.</span>
      <span class="spacer"></span>
      ${pager(info, 'tool-page')}
    </div>
  </div>`;
}

export function renderTools(model, state) {
  const ex = model.tools.excluded;
  const t = model.tools.totals;
  return `
  <div class="page__head">
    <div><h1>Tool usage</h1>
      <div class="sub">Every tool invocation in the window, from
        <span class="mono">transcript[].tool_calls</span> joined to
        <span class="mono">tool_results</span> by <span class="mono">request_id</span>. A turn
        carries at most one tool call, so each call's tokens attribute to it without being split.</div></div>
    <div class="page__actions">
      ${versionSelect(state)}
      <span class="badge ${tokenizerExact() ? 'badge--ok' : 'badge--warn'} mono"><i class="dot"></i>${h(tokenizerSource())}</span>
    </div>
  </div>

  ${tiles(model)}

  ${ex.calls ? `<div class="note" style="margin-top:14px"><span>
    <b>${int(ex.calls)} calls</b> across ${int(ex.names)} names (${usd(ex.spend)} of exposure) are
    excluded as workflow plumbing: <span class="mono">progress_workflow</span>,
    <span class="mono">notify_condition_*</span>, and system markers like
    <span class="mono">start_procedure</span>, <span class="mono">end_procedure</span> and
    <span class="mono">guardrail_triggered</span>. These are the workflow engine's own transition
    mechanics surfaced through the tool-call channel; no document exists for them because none was
    ever authored.
    ${model.tools.declaredBuiltIns.length ? `Built-ins the agent <b>declares</b> are <b>not</b>
      excluded — ${model.tools.declaredBuiltIns.map((n) => `<span class="mono">${h(n)}</span>`).join(', ')}
      ${model.tools.declaredBuiltIns.length === 1 ? 'is' : 'are'} switched on in
      <span class="mono">built_in_tools</span>, so someone chose ${model.tools.declaredBuiltIns.length === 1 ? 'it' : 'them'}
      and ${model.tools.declaredBuiltIns.length === 1 ? 'it appears' : 'they appear'} in the table above.`
      : 'No built-in tools are declared on this agent.'}
    </span></div>` : ''}

  ${t.schemaUnknown ? `<div class="note note--warn" style="margin-top:14px"><span>
    <b>${int(t.schemaUnknown)} of ${int(t.tools)} tools</b> have no cached tool document, so their
    schema column reads <b>—</b> rather than a guess. Re-sync to pull them; the conversations
    already name every tool that ran.</span></div>` : ''}

  ${t.callsWithoutUsage ? `<div class="note" style="margin-top:14px"><span>
    <b>${int(t.callsWithoutUsage)} call${t.callsWithoutUsage === 1 ? '' : 's'}</b> sat on a turn
    carrying no <span class="mono">llm_usage</span>, so they contribute nothing to the token and
    exposure columns. Said here rather than shown as zero.</span></div>` : ''}

  <div style="margin-top:14px">${table(model, state)}</div>

  ${unusedCard(model)}

  <div class="note" style="margin-top:14px"><span>
    The API exposes no per-tool cost and no tool line item in
    <span class="mono">metadata.charging</span>, so this screen never states one. <b>Params out</b>
    is measured. <b>Schema</b> and <b>Result</b> are estimates — the schema from the local
    tokenizer, the result from its character count, because tool output runs to tens of megabytes
    per window and tokenizing it exactly buys nothing. Both are prefixed <b>~</b>.
  </span></div>`;
}

/**
 * Tools for the printed report. Same renderers, minus the interactive detail
 * panel — and the row data carries no payload text, error messages or caller
 * values by construction, so there is nothing to strip.
 */
export function reportTools(model, state) {
  if (!model.tools.rows.length) return '';
  const sort = state.toolSort || { key: 'calls', dir: 'desc' };
  const rows = sortRowsBy(model.tools.rows, TOOL_COLUMNS, sort);
  const columns = TOOL_COLUMNS.filter((c) => !REPORT_SKIP.has(c.key));
  const maxSpend = Math.max(1e-9, ...rows.map((x) => x.turnSpend));
  return `
    <section class="rpt__sec rpt__sec--break">
      <h2>Tool usage</h2>
      <div class="rpt__lede">Every tool invocation in the window. <b>Exposure</b> is billed spend on
        the turns that called each tool — exact money, but caused by the node's prompt rather than
        by the tool, so it reads as reach and not as a cost. Schema and result token counts are
        estimates and are prefixed <b>~</b>. Workflow and system plumbing
        (${int(model.tools.excluded.calls)} calls) is excluded.</div>
      ${tiles(model)}
      <div class="card" style="margin-top:12px">
        <div class="card__body" style="padding:4px 8px">
          <table class="tbl tbl--tight">
            ${sortHeader(columns, sort, 'tool-sort')}
            <tbody>${rows.map((r) => `
              <tr>
                <td><div style="font-weight:500">${h(r.name)}</div></td>
                <td class="mono small muted">${h(r.type)}</td>
                <td class="num">${int(r.calls)}</td>
                <td class="num">${int(r.conversations)}<span class="thn">${pct(r.reach)}</span></td>
                <td class="num">${r.callsPerConv.toFixed(2)}</td>
                <td class="num">${r.callsWhenUsed.toFixed(1)}</td>
                <td class="num">${r.errors ? int(r.errors) + ' (' + pct(r.errorRate) + ')' : '0'}</td>
                <td class="num">${r.p95 == null ? '—' : r.p95.toFixed(2) + 's'}</td>
                <td class="num">${int(Math.round(r.paramsOutPerCall))}<span class="thn">${int(r.paramsOut)} total</span></td>
                <td class="num">${r.schemaKnown ? '~' + int(r.schemaTokens) : '—'}</td>
                <td class="num">~${num(Math.round(r.resultTokensPerCall))}<span class="thn">~${num(r.resultTokens)} total</span></td>
                <td class="num" style="font-weight:500">${usd(r.turnSpend)}
                  <div class="bartrack" style="margin-top:3px"><i class="bar"
                    style="width:${((r.turnSpend / maxSpend) * 100).toFixed(0)}%;background:${barBg(r.turnSpend / maxSpend)}"></i></div></td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="card__foot"><span>${int(rows.length)} tool${rows.length === 1 ? '' : 's'}.
          Token columns are the <b>average per call</b> with the window total beneath; per-call
          character sizes are on the Tools screen. Payload text, error messages and caller values
          are not part of this table.</span></div>
      </div>
      ${unusedCard(model)}
    </section>`;
}
