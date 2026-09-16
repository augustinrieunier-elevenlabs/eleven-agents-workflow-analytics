// Printable cost report — SPEC §8.
//
// One long static document assembled from the *same* screen renderers the app
// uses, then paginated by the `@media print` block in kit.css. The point of
// reusing the renderers rather than writing a second layout is that a number in
// the PDF cannot disagree with the number on screen: there is one derivation
// (derive.js) and one set of renderers.
//
// Scope, decided deliberately:
//   - Analytics and the prompt audit. These are the cost views.
//   - **No customer data.** No transcripts, no conversation ids, no resolved
//     dynamic variables. A PDF gets forwarded; anything customer-linkable in it
//     is a leak waiting to happen, so it is not in the document at all rather
//     than being toggled off by default.
//   - No workflow canvas. 75 nodes across four agent bands is illegible on a
//     page, and the node ledger carries the same information as data.
//
// Everything the app knows about provenance goes on the cover. A cost report
// with no window, no region and no fetch time is unfalsifiable, and the first
// question anyone asks of a surprising number is "when was this measured".

import { reportAnalytics } from './analytics.js';
import { reportPrompts } from './prompts.js';
import { tokenizerLabel, tokenizerSource } from '../tokenizer.js';
import { h, int, longDate, median, pct, usd } from '../util.js';

/** One labelled fact on the cover. */
const fact = (k, v, note) => `
  <div class="rpt__fact">
    <div class="rpt__fact-k">${h(k)}</div>
    <div class="rpt__fact-v">${v}</div>
    ${note ? `<div class="rpt__fact-n">${note}</div>` : ''}
  </div>`;

function cover(model, state) {
  const t = model.totals;
  const stamp = state.fetchedAt ? new Date(state.fetchedAt * 1000) : null;
  const unattributedShare = t.windowSpend ? t.unattributedSpend / t.windowSpend : 0;

  return `
  <section class="rpt__cover">
    <div class="rpt__brand">
      <div class="rpt__mark">II</div>
      <div>
        <div class="rpt__kicker">Agent Cost Explorer</div>
        <h1 class="rpt__title">${h(model.agentName || state.agentId || 'Agent')}</h1>
        <div class="rpt__sub">LLM cost report · ${h(longDate(state.from))} → ${h(longDate(state.to))}</div>
      </div>
    </div>

    <div class="rpt__facts">
      ${fact('billed llm spend', usd(t.windowSpend),
        'metadata.charging.llm_price — the billed figure, not an estimate')}
      ${fact('conversations', int(t.conversations),
        state.branchLabel ? 'scope: ' + h(state.branchLabel) : '')}
      ${fact('cost / conversation', usd(t.conversations ? t.windowSpend / t.conversations : 0),
        'median ' + usd(median(t.costs)))}
      ${fact('tokens in / out', int(t.tin) + ' / ' + int(t.tout),
        t.tin ? pct(t.cacheRead / t.tin) + ' of input served from cache' : '')}
    </div>

    ${t.unattributedSpend > 0 ? `
      <div class="rpt__headline">
        <div class="rpt__headline-k">Headline finding</div>
        <p><b>${usd(t.unattributedSpend)}</b> — ${pct(unattributedShare)} of billed LLM spend —
        has no workflow node behind it. These are generations the model began and that were then
        abandoned, overwhelmingly caller interruptions. They are billed in full and no prompt
        change reduces them; only turn-taking behaviour does. The node ledger accounts for the
        remaining ${usd(t.windowSpend - t.unattributedSpend)}.</p>
      </div>` : ''}

    <div class="rpt__prov">
      <div class="rpt__prov-k">Provenance</div>
      <table class="rpt__prov-t">
        <tbody>
          <tr><th>Agent</th><td class="mono">${h(state.agentId || '—')}</td></tr>
          <tr><th>Region</th><td class="mono">${h(state.region || 'global')}${
            state.apiBase ? ' · ' + h(state.apiBase) : ''}</td></tr>
          <tr><th>Branch scope</th><td>${h(state.branchLabel || 'all branches')}</td></tr>
          <tr><th>Version scope</th><td>${h(state.versionLabel || 'any version')}</td></tr>
          <tr><th>Window</th><td>${h(state.from)} → ${h(state.to)}</td></tr>
          <tr><th>Cache fetched</th><td>${stamp ? h(stamp.toISOString().replace('T', ' ').slice(0, 19)) + ' UTC' : 'unknown'}</td></tr>
          <tr><th>Workspace key</th><td class="mono">${h(state.keyFingerprint || state.keyMask || '—')}</td></tr>
          <tr><th>Config tokenizer</th><td>${h(tokenizerSource())} — ${h(tokenizerLabel())}</td></tr>
          <tr><th>Exported</th><td>${h(new Date().toISOString().replace('T', ' ').slice(0, 19))} UTC</td></tr>
        </tbody>
      </table>
    </div>

    ${model.warnings.length ? `
      <div class="rpt__caveats">
        <div class="rpt__caveats-k">Caveats on this window</div>
        <ul>${model.warnings.map((w) => `<li>${h(w)}</li>`).join('')}</ul>
      </div>` : ''}

    <div class="rpt__note">
      Contains no conversation transcripts, conversation ids or resolved dynamic variables.
      Billed figures come from the API's own charging block; anything derived from the local
      tokenizer is an estimate and is marked as one. Assumed reduction factors behind the
      "where to cut" levers are printed with each lever.
    </div>
  </section>`;
}

/** Epistemic key, so a reader can tell which numbers are which. */
function appendix() {
  return `
  <section class="rpt__sec rpt__sec--break">
    <h2>How to read these numbers</h2>
    <table class="tbl tbl--tight rpt__key">
      <thead><tr><th>Class</th><th>Meaning</th><th>Where it comes from</th></tr></thead>
      <tbody>
        <tr><td><b>billed</b></td><td>What the workspace was charged. Authoritative.</td>
          <td class="mono">metadata.charging.llm_price</td></tr>
        <tr><td><b>measured</b></td><td>Counted from the responses. Exact, but attributed per turn,
          so node shares are scaled to the billed total.</td>
          <td class="mono">transcript[].llm_usage</td></tr>
        <tr><td><b>estimated</b></td><td>Config-side prompt sizes. The API exposes no tokenizer, so
          these are counted locally and marked <b>~</b> under the heuristic tier.</td>
          <td>local tokenizer</td></tr>
        <tr><td><b>assumed</b></td><td>A savings lever's reduction factor. A judgement, printed
          with the lever so it can be argued with.</td>
          <td>local constant</td></tr>
      </tbody>
    </table>
    <div class="rpt__note" style="margin-top:12px">
      Node costs are per-turn token sums scaled so the ledger reconciles to the billed total;
      the scale factor and any drift are shown on the Workflow screen in the app. Cache
      read/write counts are reported per conversation per model, not per node, so any per-node
      cache figure is an approximation. Context-window pressure is omitted: the API exposes no
      context metadata, so it would rest on a local table.
    </div>
  </section>`;
}

export function renderReport(model, state) {
  return `
    <div class="rpt" id="report">
      <div class="rpt__bar screen-only">
        <div>
          <b>Cost report</b>
          <span class="muted"> — print or save as PDF. Analytics and prompt audit; no customer data.</span>
        </div>
        <span class="spacer"></span>
        <button class="btn btn--sm" data-act="screen" data-id="analytics">Back</button>
        <button class="btn btn--primary btn--sm" data-act="print-report">Print / Save as PDF</button>
      </div>
      ${cover(model, state)}
      ${reportAnalytics(model, state)}
      ${reportPrompts(model, state)}
      ${appendix()}
    </div>`;
}
