// Overview screen — SPEC §1b. The landing screen after a window is retrieved.
//
// Three sections, in the order a cost question is usually asked: where the
// money went by node, what the prompts cost and what fills them, then the
// shape over time and across models.
//
// Composed entirely from the three screens' own renderers — `overviewWorkflow`,
// `overviewPrompts`, `overviewAnalytics` each live in the screen that owns the
// idiom. Nothing is re-derived and no figure is re-formatted here, so a number
// on this page cannot disagree with the screen its button opens.
//
// Deliberately structural, not editorial. Every panel is a metric that exists
// for any agent on any window: no thresholds of its own, no findings ranked by
// a rule invented here, nothing that assumes a particular workspace's shape.
// The caveats banner arrives from `page()` in app.js, the same as every other
// screen, so a filtered or partial window says so above the first tile.

import { overviewAnalytics } from './analytics.js';
import { overviewPrompts } from './prompts.js';
import { overviewWorkflow } from './workflow.js';
import { h, int, longDate, versionSelect } from '../util.js';

/** A section heading with its own "open the screen" affordance. */
const section = (title, sub, screen, label, body) => `
  <section class="section">
    <div class="section__head">
      <h2>${h(title)}</h2>
      <div class="sub">${h(sub)}</div>
      <div class="right">
        <button class="btn btn--ghost btn--sm" data-act="screen" data-id="${h(screen)}">${h(label)} →</button>
      </div>
    </div>
    ${body}
  </section>`;

export function renderOverview(model, state) {
  const t = model.totals;
  return `
  <div class="page__head">
    <div>
      <h1>${h(model.agentName || state.agentId || 'Agent')}</h1>
      <div class="sub">${h(longDate(state.from))} → ${h(longDate(state.to))} ·
        ${int(t.conversations)} conversation${t.conversations === 1 ? '' : 's'} ·
        ${h(state.region || 'global')}. Every figure below is derived from the cached responses for
        this window; open a section for the detail behind it.</div>
    </div>
    <div class="page__actions">
      ${versionSelect(state)}
      <button class="btn btn--sm" data-act="screen" data-id="report">Export report</button>
    </div>
  </div>

  ${section('Workflow cost', 'what each node cost to run', 'workflow', 'Workflow',
    overviewWorkflow(model, state))}

  ${section('Prompt audit', 'what each node sends, and what fills its context', 'prompts', 'Prompts',
    overviewPrompts(model, state))}

  ${section('Token analytics', 'spend over time and across models', 'analytics', 'Analytics',
    overviewAnalytics(model, state))}`;
}
