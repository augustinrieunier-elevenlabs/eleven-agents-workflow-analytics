// Every derived number in the app.
//
// SPEC §0.0: all computation lives in the frontend. The backend hands over raw
// cached responses; this module walks them once and produces the aggregates the
// screens render. If a number looks wrong, it is wrong here or in the cached
// JSON — there is no backend aggregation to blame.

import { contextWindow, nodeAvatar, provider } from './models.js';
import { countTokens } from './tokenizer.js';
import { dayKey, daysBetween, pct, quantile, shiftDays, sum } from './util.js';

export const UNATTRIBUTED = '__unattributed__';

/**
 * Nodes are keyed by owning agent, not by node id alone.
 *
 * A workflow can transfer to another agent, and node ids repeat across agents —
 * every one of them has a `start_node`. On a real coordinator agent, 71% of
 * conversations touch more than one agent, so keying on the node id alone
 * merged four different agents' start nodes into one ledger row.
 */
export const nodeKey = (agentId, nodeId) => (agentId ? agentId + '::' + nodeId : nodeId);
export const splitKey = (key) => {
  const at = String(key).indexOf('::');
  return at === -1 ? { agentId: null, nodeId: key } : { agentId: key.slice(0, at), nodeId: key.slice(at + 2) };
};
export const NODE_W = 176;
export const NODE_H = 84;

// The four billable units (SPEC §2), plus the aliases the API has used for them.
const UNIT_ALIASES = {
  input: 'input',
  input_tokens: 'input',
  llm_input_tokens: 'input',
  prompt_tokens: 'input',
  input_cache_read: 'cacheRead',
  llm_input_cache_read_tokens: 'cacheRead',
  cache_read: 'cacheRead',
  cached_tokens: 'cacheRead',
  input_cache_write: 'cacheWrite',
  llm_input_cache_write_tokens: 'cacheWrite',
  cache_write: 'cacheWrite',
  output_total: 'output',
  output: 'output',
  output_tokens: 'output',
  llm_output_tokens: 'output',
  completion_tokens: 'output',
};

const INPUT_UNITS = ['input', 'cacheRead', 'cacheWrite'];

const SEG_BG = {
  'instructions': 'var(--q6)',
  'policy / knowledge': 'var(--s2)',
  'few-shot examples': 'var(--s4)',
  'tool definitions': 'var(--s7)',
  'dynamic variables': 'var(--s3)',
  'conversation history': 'var(--q3)',
  'retrieved chunks': 'var(--q2)',
  'case summary': 'var(--s5)',
};
export const SEG_ORDER = Object.keys(SEG_BG);
export const segColor = (kind) => SEG_BG[kind] || 'var(--line)';

const PER_TURN_KINDS = new Set([
  'conversation history', 'retrieved chunks', 'dynamic variables', 'case summary',
]);
export const isPerTurnKind = (kind) => PER_TURN_KINDS.has(kind);

// ── usage normalisation ───────────────────────────────────────────────

function blankUnits() {
  return {
    input: { tokens: 0, price: 0 },
    cacheRead: { tokens: 0, price: 0 },
    cacheWrite: { tokens: 0, price: 0 },
    output: { tokens: 0, price: 0 },
  };
}

function mergeEntry(target, model, entry) {
  if (!entry || typeof entry !== 'object') return;
  const bucket = target[model] || (target[model] = blankUnits());
  for (const [rawKey, rawValue] of Object.entries(entry)) {
    const unit = UNIT_ALIASES[rawKey];
    if (!unit) continue;
    let tokens = 0;
    let price = null;
    if (typeof rawValue === 'number') {
      tokens = rawValue;
    } else if (rawValue && typeof rawValue === 'object') {
      tokens = Number(rawValue.tokens ?? rawValue.count ?? rawValue.amount ?? 0) || 0;
      const p = rawValue.price ?? rawValue.price_per_million ?? rawValue.unit_price;
      if (typeof p === 'number') price = p;
    }
    bucket[unit].tokens += tokens;
    if (price != null) bucket[unit].price += price;
  }
}

/**
 * Collect `model_usage` under a node, summed by model.
 *
 * IMPORTANT — what `price` means: it is the **absolute dollar cost already
 * computed for those tokens**, not a rate. Verified against live data:
 * `{tokens: 1015, price: 0.00015225}` is exactly 1015 / 1e6 × $0.15/1M. SPEC §2
 * calls it "per 1M tokens", which is wrong; treating it as a rate understates
 * every cost by a factor of tokens/1e6. Per-1M rates are derived with
 * `ratePerMillion()` for display only.
 *
 * A turn's `llm_usage` holds `model_usage` directly; `charging.llm_usage` wraps
 * it in generation buckets. The direct path is preferred and a walk is the
 * fallback for shapes not seen yet.
 */
export function collectModelUsage(root) {
  const out = {};
  if (!root || typeof root !== 'object') return out;
  // Direct hit: a turn's llm_usage, or one generation bucket of charging.
  if (root.model_usage && typeof root.model_usage === 'object' && !Array.isArray(root.model_usage)) {
    for (const [model, entry] of Object.entries(root.model_usage)) mergeEntry(out, model, entry);
    return out;
  }
  const seen = new Set();

  (function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.model_usage && typeof node.model_usage === 'object' && !Array.isArray(node.model_usage)) {
      for (const [model, entry] of Object.entries(node.model_usage)) mergeEntry(out, model, entry);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'model_usage') continue;
      if (value && typeof value === 'object') walk(value);
    }
  })(root);

  return out;
}

/** `price` is already the dollar cost for those tokens — sum it, never scale it. */
export function usageCost(usage) {
  let total = 0;
  for (const units of Object.values(usage)) {
    for (const slot of Object.values(units)) total += slot.price;
  }
  return total;
}

export function usageInputCost(usage) {
  let total = 0;
  for (const units of Object.values(usage)) {
    for (const unit of INPUT_UNITS) total += units[unit].price;
  }
  return total;
}

export function usageOutputCost(usage) {
  let total = 0;
  for (const units of Object.values(usage)) total += units.output.price;
  return total;
}

/** Dollars per million tokens, derived from an absolute cost. Display only. */
export const ratePerMillion = (slot) =>
  (slot && slot.tokens ? (slot.price / slot.tokens) * 1e6 : 0);

/** The effective blended rate for a set of units. */
export function blendedRate(usage, units) {
  let cost = 0;
  let tokens = 0;
  for (const bucket of Object.values(usage)) {
    for (const unit of units) { cost += bucket[unit].price; tokens += bucket[unit].tokens; }
  }
  return tokens ? (cost / tokens) * 1e6 : 0;
}

/** Input-side tokens are fresh input plus cache reads plus cache writes. */
export function usageTokens(usage) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, fresh: 0 };
  for (const units of Object.values(usage)) {
    t.fresh += units.input.tokens;
    t.cacheRead += units.cacheRead.tokens;
    t.cacheWrite += units.cacheWrite.tokens;
    t.input += units.input.tokens + units.cacheRead.tokens + units.cacheWrite.tokens;
    t.output += units.output.tokens;
  }
  return t;
}

function accumulateUsage(target, usage) {
  for (const [model, units] of Object.entries(usage)) {
    const bucket = target[model] || (target[model] = blankUnits());
    for (const unit of Object.keys(bucket)) {
      bucket[unit].tokens += units[unit].tokens;
      bucket[unit].price += units[unit].price;
    }
  }
  return target;
}

/** The model that actually produced the turns here — the one with most tokens. */
function dominantModel(usage) {
  let best = null;
  let bestTokens = -1;
  for (const [model, units] of Object.entries(usage)) {
    const total = Object.values(units).reduce((a, s) => a + s.tokens, 0);
    if (total > bestTokens) { bestTokens = total; best = model; }
  }
  return best;
}

// ── transcript readers ────────────────────────────────────────────────

function nodeIdOf(turn) {
  const meta = turn && turn.agent_metadata;
  if (!meta || typeof meta !== 'object') return null;
  return meta.workflow_node_id || meta.node_id || meta.workflow_node
    || (meta.workflow && (meta.workflow.node_id || meta.workflow.id)) || null;
}

/** Which agent ran this turn — the transfer target, once a handoff happened. */
function agentIdOf(turn) {
  const meta = turn && turn.agent_metadata;
  return (meta && (meta.agent_id || meta.agentId)) || null;
}

function versionOf(turn) {
  const meta = turn && turn.agent_metadata;
  return (meta && (meta.version_id || meta.agent_version_id)) || null;
}

function branchOfTurn(turn) {
  const meta = turn && turn.agent_metadata;
  if (!meta || typeof meta !== 'object') return null;
  return meta.branch_id || meta.branchId
    || (meta.branch && (meta.branch.id || meta.branch.name)) || null;
}

/** The branch a conversation ran on, read from its turns then its envelope. */
export function branchOfConversation(detail) {
  const fromTurns = (detail.transcript || []).map(branchOfTurn).find(Boolean);
  if (fromTurns) return fromTurns;
  return detail.branch_id || (detail.metadata && detail.metadata.branch_id) || null;
}

/**
 * Per-turn observations that feed the deterministic fit assessment (Phase A).
 * Everything here is read straight off the response — no inference.
 */
function collectFitSignals(stat, turn, detail, tokens, hasLlm) {
  // These arrive as empty ARRAYS on most turns, not as null. `if (turn.x)` is
  // therefore true every time — measure length, not truthiness.
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
  if (turn.interrupted === true) stat.interrupted += 1;
  if (nonEmpty(turn.triggered_guardrails)) stat.guardrails += 1;
  if (turn.reasoned === true || nonEmpty(turn.reasoning)) stat.reasoned += 1;

  const meta = detail.metadata || {};
  const language = meta.main_language || detail.main_language;
  if (language) stat.languages.add(language);
  const score = detail.analysis && detail.analysis.call_success_score;
  if (typeof score === 'number') stat.successScores.push(score);

  if (hasLlm && tokens.output > 0) {
    stat.outTokens.push(tokens.output);
    // Output diversity: a node emitting the same few strings is templated, and a
    // template does not need a frontier model. Capped so the set stays small.
    if (typeof turn.message === 'string' && stat.outputs.size < 400) {
      stat.outputs.add(turn.message.replace(/\s+/g, ' ').trim().slice(0, 200));
      stat.outputSamples += 1;
    }
  }

  for (const call of turn.tool_calls || []) {
    const name = call.tool_name || call.tool_id || 'unnamed';
    const row = stat.toolUse.get(name) || { name, calls: 0, errors: 0, latencies: [] };
    row.calls += 1;
    stat.toolUse.set(name, row);
  }
  for (const result of turn.tool_results || []) {
    const name = result.tool_name || 'unnamed';
    const row = stat.toolUse.get(name) || { name, calls: 0, errors: 0, latencies: [] };
    if (result.is_error) row.errors += 1;
    if (typeof result.tool_latency_secs === 'number') row.latencies.push(result.tool_latency_secs * 1000);
    stat.toolUse.set(name, row);
  }

  for (const id of turn.used_static_kb_document_ids || []) stat.kbDocs.add(id);
  const rag = turn.rag_retrieval_info;
  if (rag && Array.isArray(rag.chunks)) {
    for (const chunk of rag.chunks) {
      if (typeof chunk.vector_distance === 'number') stat.ragDistances.push(chunk.vector_distance);
    }
  }
}

/** LLM latency for one turn, in milliseconds. */
function llmLatencyMs(turn) {
  const block = turn && turn.conversation_turn_metrics;
  if (!block || typeof block !== 'object') return null;
  const metrics = (block.metrics && typeof block.metrics === 'object') ? block.metrics : block;
  let best = null;
  for (const [key, value] of Object.entries(metrics)) {
    if (!value || typeof value !== 'object') continue;
    const secs = value.elapsed_time ?? value.elapsed_time_secs ?? value.value;
    if (typeof secs !== 'number') continue;
    const name = key.toLowerCase();
    if (!name.includes('llm')) continue;
    const rank = name.includes('ttf_sentence') ? 3 : name.includes('ttfb') ? 1 : 2;
    if (!best || rank > best.rank) best = { rank, ms: secs * 1000 };
  }
  return best ? best.ms : null;
}

function retrievedTokens(turn) {
  const rag = turn && turn.rag_retrieval_info;
  if (!rag || typeof rag !== 'object') return 0;
  if (typeof rag.retrieved_tokens === 'number') return rag.retrieved_tokens;
  if (Array.isArray(rag.chunks)) {
    return sum(rag.chunks.map((c) => Number(c.tokens || c.chunk_tokens || 0) || 0));
  }
  return 0;
}

// ── workflow graph ────────────────────────────────────────────────────

function entriesOf(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) {
    return collection.map((item, i) => [item && (item.id || item.node_id) ? (item.id || item.node_id) : String(i), item]);
  }
  if (typeof collection === 'object') return Object.entries(collection);
  return [];
}

/**
 * A readable name for a node.
 *
 * SPEC §2 says `label` is required only on `override_agent`, "else the node id".
 * In practice start/end/tool/standalone_agent/update_state nodes arrive with no
 * label at all, and falling back to a ULID renders rows like
 * `node_01m2g713rse639zan3qx9hdqx5`. Every one of those types carries fields
 * that say what it is, so name it from those instead and mark the name derived.
 */
function deriveLabel(id, def, ctx) {
  const d = (def && typeof def === 'object') ? def : {};
  const authored = (typeof d.label === 'string' && d.label.trim())
    || (typeof d.name === 'string' && d.name.trim());
  if (authored) return { label: authored, derivedLabel: false };

  const shortId = (raw) => (/^[a-z_]*_?[a-z0-9]{20,}$/i.test(raw || '')
    ? String(raw).slice(0, 5) + '…' + String(raw).slice(-6)
    : String(raw || 'node'));

  switch (d.type) {
    case 'start':
      return { label: 'Start', derivedLabel: true };
    case 'end':
      return { label: d.return_when_nested ? 'Return to parent' : 'End', derivedLabel: true };
    case 'tool': {
      const names = (d.tools || []).map((t) => {
        const doc = ctx.toolsById[t && (t.tool_id || t.id)];
        const config = doc && (doc.tool_config || doc);
        return (config && config.name) || (t && (t.tool_id || t.id));
      }).filter(Boolean);
      const sys = d.system_tool && (typeof d.system_tool === 'string' ? d.system_tool : d.system_tool.name);
      if (sys) names.push(sys);
      return { label: names.length ? names.join(' + ') : 'Tool', derivedLabel: true };
    }
    case 'standalone_agent': {
      const name = ctx.agentsById[d.agent_id];
      return { label: 'Transfer → ' + (name || shortId(d.agent_id)), derivedLabel: true };
    }
    case 'update_state': {
      const vars = (Array.isArray(d.updates) ? d.updates : [])
        .map((u) => u && u.variable_name).filter(Boolean);
      return {
        label: vars.length ? 'Set ' + vars.slice(0, 3).join(', ') + (vars.length > 3 ? '…' : '') : 'Update state',
        derivedLabel: true,
      };
    }
    case 'phone_number':
      return { label: d.phone_number || 'Phone number', derivedLabel: true };
    default:
      return { label: shortId(id), derivedLabel: true };
  }
}

function nodePrompt(def) {
  if (!def || typeof def !== 'object') return '';
  const parts = [];
  const push = (value) => { if (typeof value === 'string' && value.trim()) parts.push(value.trim()); };
  push(def.additional_prompt);
  const override = def.override_agent || def;
  push(override.additional_prompt === def.additional_prompt ? null : override.additional_prompt);
  const cfg = def.conversation_config || (override && override.conversation_config);
  if (cfg && cfg.agent && cfg.agent.prompt) push(cfg.agent.prompt.prompt);
  // De-duplicate identical probes.
  return Array.from(new Set(parts)).join('\n\n');
}

function nodeModel(def, fallback) {
  if (!def || typeof def !== 'object') return fallback;
  const cfg = def.conversation_config || (def.override_agent && def.override_agent.conversation_config);
  const llm = cfg && cfg.agent && cfg.agent.prompt && cfg.agent.prompt.llm;
  return llm || def.llm || fallback;
}

function nodeTools(def) {
  if (!def || typeof def !== 'object') return [];
  const ids = new Set();
  const add = (value) => { if (typeof value === 'string') ids.add(value); };
  (def.additional_tool_ids || []).forEach(add);
  (def.tool_ids || []).forEach(add);
  (def.tools || []).forEach((t) => add(t && (t.tool_id || t.id)));
  const override = def.override_agent;
  if (override) {
    (override.additional_tool_ids || []).forEach(add);
    (override.tool_ids || []).forEach(add);
  }
  return Array.from(ids);
}

/**
 * Render an expression AST as something readable.
 *
 * `forward_condition.expression` is a tree, not a string — SPEC §2 calls it "an
 * AST over dynamic variables" and that is literal. Interpolating it produced
 * `[object Object]` in edge tooltips. The node types below are the ones live
 * graphs use; anything else degrades to its type name rather than a blank.
 */
function renderExpression(node, depth = 0) {
  if (node == null) return '';
  // Some graphs carry the expression already as a string; pass it through.
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return String(node);
  if (depth > 4) return '…';

  const OPS = {
    eq_operator: '==', ne_operator: '!=', gt_operator: '>', gte_operator: '>=',
    lt_operator: '<', lte_operator: '<=',
  };
  const type = node.type;

  if (type === 'dynamic_variable') return node.name || 'var';
  if (type === 'string_literal') return JSON.stringify(node.value);
  if (type === 'boolean_literal' || type === 'number_literal') return String(node.value);
  if (type === 'llm') {
    const desc = node.value_schema && node.value_schema.description;
    return desc ? 'llm(' + String(desc).slice(0, 60) + (String(desc).length > 60 ? '…' : '') + ')' : 'llm(…)';
  }
  if (OPS[type]) {
    return renderExpression(node.left, depth + 1) + ' ' + OPS[type] + ' ' + renderExpression(node.right, depth + 1);
  }
  if (type === 'and_operator' || type === 'or_operator') {
    const joiner = type === 'and_operator' ? ' and ' : ' or ';
    const parts = (node.children || []).map((c) => renderExpression(c, depth + 1)).filter(Boolean);
    return parts.length ? parts.join(joiner) : type.replace('_operator', '');
  }
  if (type === 'not_operator') return 'not ' + renderExpression(node.child || node.operand, depth + 1);
  return String(type || 'expression');
}

/**
 * A human label for an edge condition.
 *
 * Live graphs put an author-written `label` on conditions of every type — not
 * only `llm` — and it can be null. The natural-language text for an llm
 * condition is `condition`, not `prompt`. A result condition carries
 * `successful: true|false`, not `outcome: 'failure'`, which is why failure
 * edges were never being drawn as such.
 */
function conditionLabel(cond) {
  if (!cond || typeof cond !== 'object') return { kind: 'unconditional', label: '', failure: false };
  const kind = cond.type || cond.condition_type || 'unconditional';
  const authored = typeof cond.label === 'string' && cond.label.trim() ? cond.label.trim() : null;

  if (kind === 'llm') {
    const text = typeof cond.condition === 'string' ? cond.condition
      : (typeof cond.prompt === 'string' ? cond.prompt : null);
    return {
      kind,
      label: authored || (text ? text.slice(0, 90) + (text.length > 90 ? '…' : '') : 'llm condition'),
      detail: text || null,
      failure: false,
    };
  }
  if (kind === 'expression') {
    const rendered = renderExpression(cond.expression);
    return { kind, label: authored || rendered || 'expression', detail: rendered || null, failure: false };
  }
  if (kind === 'result') {
    const failed = cond.successful === false || cond.outcome === 'failure';
    return {
      kind,
      label: authored || (failed ? 'on failure' : 'on success'),
      failure: failed,
    };
  }
  return { kind, label: authored || '', failure: false };
}

function layout(nodes, edges) {
  // Positions come from the API when the graph carries them. When it does not,
  // fall back to a layered layout so a real agent still renders.
  const missing = nodes.filter((n) => n.x == null || n.y == null);
  if (!missing.length) return;

  const depth = new Map();
  const incoming = new Map();
  nodes.forEach((n) => incoming.set(n.id, 0));
  edges.forEach((e) => incoming.set(e.target, (incoming.get(e.target) || 0) + 1));
  const queue = nodes.filter((n) => !incoming.get(n.id)).map((n) => n.id);
  if (!queue.length && nodes.length) queue.push(nodes[0].id);
  queue.forEach((id) => depth.set(id, 0));

  const outgoing = new Map();
  edges.forEach((e) => {
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source).push(e.target);
  });

  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const id = queue.shift();
    for (const next of outgoing.get(id) || []) {
      const candidate = (depth.get(id) || 0) + 1;
      if (!depth.has(next) || depth.get(next) < candidate) {
        depth.set(next, candidate);
        queue.push(next);
      }
    }
  }

  const byDepth = new Map();
  nodes.forEach((n) => {
    const d = depth.get(n.id) || 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(n);
  });
  byDepth.forEach((column, d) => {
    column.forEach((n, i) => {
      if (n.x == null) n.x = 24 + d * (NODE_W + 28);
      if (n.y == null) n.y = 40 + i * (NODE_H + 36);
    });
  });
}

function parseWorkflow(agent, savedNodes, ctx = { toolsById: {}, agentsById: {} }, owner = {}) {
  const workflow = (agent && agent.workflow) || {};
  const defaultModel = agent && agent.conversation_config && agent.conversation_config.agent
    && agent.conversation_config.agent.prompt && agent.conversation_config.agent.prompt.llm;

  const ownerId = owner.agentId || (agent && agent.agent_id) || null;
  const ownerName = owner.agentName || (agent && agent.name) || null;
  const isPrimary = owner.isPrimary !== false;
  const bandOffset = owner.bandOffset || 0;

  const nodes = entriesOf(workflow.nodes).map(([id, def]) => {
    const d = def && typeof def === 'object' ? def : {};
    const type = d.type || 'override_agent';
    const position = d.position || {};
    const named = deriveLabel(id, d, ctx);
    return {
      id: nodeKey(ownerId, id),
      nodeId: id,
      agentId: ownerId,
      agentName: ownerName,
      isPrimary,
      type,
      label: named.label,
      derivedLabel: named.derivedLabel,
      x: typeof position.x === 'number' ? position.x : null,
      // Dependency agents get their own horizontal band so their graphs do not
      // overlap the primary agent's on the canvas.
      y: typeof position.y === 'number' ? position.y + bandOffset : null,
      configModel: type === 'tool' || type === 'start' || type === 'end' ? null : nodeModel(d, defaultModel),
      prompt: nodePrompt(d),
      toolIds: nodeTools(d),
      raw: d,
    };
  });

  const edges = entriesOf(workflow.edges).map(([id, def]) => {
    const d = def && typeof def === 'object' ? def : {};
    const src = d.source || d.from || d.source_node_id;
    const dst = d.target || d.to || d.target_node_id;
    return {
      id: nodeKey(ownerId, id),
      agentId: ownerId,
      source: src ? nodeKey(ownerId, src) : src,
      target: dst ? nodeKey(ownerId, dst) : dst,
      forward: conditionLabel(d.forward_condition),
      backward: d.backward_condition ? conditionLabel(d.backward_condition) : null,
    };
  }).filter((e) => e.source && e.target);

  // Saved positions win over the graph's own: the user moved them on purpose.
  if (savedNodes) {
    for (const node of nodes) {
      const saved = savedNodes[node.id];
      if (saved && isFinite(saved.x) && isFinite(saved.y)) {
        node.x = saved.x;
        node.y = saved.y;
        node.moved = true;
      }
    }
  }
  layout(nodes, edges);
  return { nodes, edges, defaultModel, rootPrompt: rootPromptOf(agent) };
}

function rootPromptOf(agent) {
  const prompt = agent && agent.conversation_config && agent.conversation_config.agent
    && agent.conversation_config.agent.prompt && agent.conversation_config.agent.prompt.prompt;
  return typeof prompt === 'string' ? prompt : '';
}

// ── prompt composition (SPEC §3) ──────────────────────────────────────

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*$/;

function classifyHeading(heading) {
  const t = (heading || '').toLowerCase();
  if (/few[\s-]?shot|example|sample (call|turn)/.test(t)) return 'few-shot examples';
  if (/summar/.test(t)) return 'case summary';
  if (/polic|knowledge|criteri|procedur|troubleshoot|faq|reference|rules|tree|catalog/.test(t)) {
    return 'policy / knowledge';
  }
  return 'instructions';
}

/** Split an authored prompt into headed sections. */
export function splitSections(text) {
  const lines = String(text || '').split('\n');
  const sections = [];
  let current = { heading: null, kind: 'instructions', lines: [] };
  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match) {
      if (current.lines.join('').trim() || current.heading) sections.push(current);
      current = { heading: match[1], kind: classifyHeading(match[1]), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.join('').trim() || current.heading) sections.push(current);
  return sections.map((s) => ({
    heading: s.heading,
    kind: s.kind,
    text: (s.heading ? '## ' + s.heading + '\n' : '') + s.lines.join('\n').trim(),
  })).filter((s) => s.text.trim());
}

const VAR_RE = /\{\{\s*([\w.\-]+)\s*\}\}/g;

function composeConfigSide(promptText, toolDocs) {
  const buckets = new Map();
  const bump = (kind, tokens) => {
    if (tokens <= 0) return;
    buckets.set(kind, (buckets.get(kind) || 0) + tokens);
  };

  const vars = new Set();
  for (const section of splitSections(promptText)) {
    let sectionTokens = countTokens(section.text);
    let varTokens = 0;
    let match;
    VAR_RE.lastIndex = 0;
    while ((match = VAR_RE.exec(section.text))) {
      vars.add(match[1]);
      varTokens += countTokens(match[0]);
    }
    bump('dynamic variables', varTokens);
    bump(section.kind, Math.max(0, sectionTokens - varTokens));
  }

  let toolTokens = 0;
  for (const doc of toolDocs) {
    const config = (doc && (doc.tool_config || doc.config || doc)) || {};
    toolTokens += countTokens(JSON.stringify(config));
  }
  bump('tool definitions', toolTokens);

  return { buckets, vars: Array.from(vars) };
}

// ── duplicate blocks (SPEC §3) ────────────────────────────────────────

const normalise = (text) => String(text).replace(/\s+/g, ' ').trim();

function duplicateBlocks(nodeAudits) {
  // Matched across node-level prompts only. The agent's root prompt is shared by
  // construction, not pasted twice by a human, so counting it as duplication
  // would bury the findings that are actually actionable.
  const groups = new Map();
  for (const audit of nodeAudits) {
    const seenHere = new Set();
    for (const section of splitSections(audit.nodePrompt)) {
      const key = normalise(section.text);
      if (key.length < 80) continue;
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      if (!groups.has(key)) {
        groups.set(key, {
          name: section.heading || (key.split(' ').slice(0, 7).join(' ') + '…'),
          tokens: countTokens(section.text),
          nodes: [],
        });
      }
      groups.get(key).nodes.push(audit);
    }
  }

  const dupes = [];
  for (const group of groups.values()) {
    if (group.nodes.length < 2) continue;
    // Every repeat after the first is text you paid to send again.
    const repeats = group.nodes.slice(1);
    const cost = sum(repeats.map((a) => (group.tokens * a.calls / 1e6) * a.effectiveInputPrice));
    dupes.push({
      name: group.name,
      tokens: group.tokens,
      count: group.nodes.length,
      nodes: group.nodes.map((a) => ({ id: a.id, label: a.label })),
      cost,
    });
  }
  return dupes.sort((a, b) => b.cost - a.cost);
}

// ── the build ─────────────────────────────────────────────────────────

/**
 * @param bundle  {agent, branches, index, conversations, tools, meta}
 * @param opts    {pinnedVersion, previousBundle}
 */
export function buildModel(bundle, opts = {}) {
  const warnings = [];
  const agent = bundle.agent || {};
  const savedNodes = (opts.layout && opts.layout.nodes) || null;
  const agentsById = {};
  for (const a of ((bundle.agents && bundle.agents.agents) || [])) {
    if (a && a.agent_id) agentsById[a.agent_id] = a.name || a.agent_id;
  }
  const ctx = { toolsById: bundle.tools || {}, agentsById };
  const primaryId = agent.agent_id || opts.agentId || null;
  const agentDocs = bundle.agent_docs && typeof bundle.agent_docs === 'object' ? bundle.agent_docs : {};

  // The primary agent first, then every transfer target, each in its own band.
  const graph = parseWorkflow(agent, savedNodes, ctx,
    { agentId: primaryId, agentName: agent.name, isPrimary: true, bandOffset: 0 });
  const BAND = 900;
  let band = 1;
  for (const [depId, doc] of Object.entries(agentDocs)) {
    if (!depId || depId === primaryId || !doc) continue;
    const sub = parseWorkflow(doc, savedNodes, ctx, {
      agentId: depId,
      agentName: (doc.name || agentsById[depId] || depId),
      isPrimary: false,
      bandOffset: band * BAND,
    });
    graph.nodes.push(...sub.nodes);
    graph.edges.push(...sub.edges);
    // Each agent has its own root prompt; nodes carry their owner's.
    graph.rootPromptByAgent = graph.rootPromptByAgent || {};
    graph.rootPromptByAgent[depId] = sub.rootPrompt;
    band += 1;
  }
  graph.rootPromptByAgent = graph.rootPromptByAgent || {};
  graph.rootPromptByAgent[primaryId] = graph.rootPrompt;
  // Which agents we actually hold a definition for. A node owned by an agent
  // outside this set cannot be audited: substituting another agent's root
  // prompt produced a confident, wrong static size.
  graph.knownAgents = new Set(Object.keys(agentDocs).concat(primaryId ? [primaryId] : []));
  graph.agentNames = agentsById;
  graph.primaryId = primaryId;

  // Transfer edges between agents, so the canvas shows the handoff.
  for (const node of graph.nodes) {
    const target = node.raw && node.raw.agent_id;
    if (node.type !== 'standalone_agent' || !target) continue;
    const entry = graph.nodes.find((n) => n.agentId === target && n.type === 'start');
    if (entry) {
      graph.edges.push({
        id: 'transfer:' + node.id,
        source: node.id,
        target: entry.id,
        forward: { kind: 'transfer', label: 'transfers to ' + (agentsById[target] || target) },
        backward: null,
        transfer: true,
      });
    }
  }
  const toolsById = bundle.tools || {};
  const pinnedVersion = opts.pinnedVersion || null;
  // Empty or absent means every branch — never silently narrow the window.
  const branchIds = Array.isArray(opts.branchIds) ? opts.branchIds : null;

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const stats = new Map();

  const statFor = (id) => {
    let s = stats.get(id);
    if (!s) {
      s = {
        id, calls: 0, turns: 0, usage: {}, latencies: [], convIds: new Set(),
        retrieved: 0, retrievedCalls: 0, costTurns: 0, byDay: new Map(),
        // Phase A fit signals — all observed, none inferred.
        outTokens: [], outputs: new Set(), outputSamples: 0,
        toolUse: new Map(), guardrails: 0, reasoned: 0, interrupted: 0,
        selfLoops: 0, backtracks: 0, languages: new Set(),
        kbDocs: new Set(), ragDistances: [], successScores: [],
      };
      stats.set(id, s);
    }
    return s;
  };

  const edgeTraffic = new Map();
  const conversations = [];
  let offVersion = 0;
  let offBranch = 0;
  const branchCounts = new Map();
  let chargingTotal = 0;
  let chargingConvs = 0;
  let committedTotal = 0;
  let turnsTotal = 0;
  let llmCallCount = 0;
  const allLatencies = [];
  const windowUsage = {};
  const chargingUsage = {};
  const byDay = new Map();
  let timezone = 'UTC';
  let missingFiat = 0;

  for (const detail of bundle.conversations || []) {
    const meta = detail.metadata || {};
    timezone = meta.timezone || timezone;
    const startedAt = meta.start_time_unix_secs || detail.start_time_unix_secs || 0;
    const version = detail.version_id || (detail.transcript || []).map(versionOf).find(Boolean) || null;
    const onVersion = !pinnedVersion || !version || version === pinnedVersion;

    // Branch scope. A conversation with no branch on it is kept rather than
    // guessed at — dropping it would silently shrink the window.
    const branch = branchOfConversation(detail);
    if (branch) branchCounts.set(branch, (branchCounts.get(branch) || 0) + 1);
    const onBranch = !branchIds || !branchIds.length || !branch || branchIds.indexOf(branch) !== -1;

    const inScope = onVersion && onBranch;
    if (!onVersion) offVersion += 1;
    else if (!onBranch) offBranch += 1;

    const transcript = detail.transcript || [];
    const steps = [];
    let current = null;
    let convUsage = {};
    let convLlmCalls = 0;

    for (const turn of transcript) {
      const rawNode = nodeIdOf(turn);
      const turnAgent = agentIdOf(turn) || primaryId;
      const nodeId = rawNode ? nodeKey(turnAgent, rawNode) : UNATTRIBUTED;
      if (!current || current.nodeId !== nodeId) {
        current = { nodeId, usage: {}, turns: 0, cost: 0, tin: 0, tout: 0 };
        steps.push(current);
      }
      current.turns += 1;

      const usage = collectModelUsage(turn.llm_usage);
      const tokens = usageTokens(usage);
      const hasLlm = tokens.input + tokens.output > 0;
      const stat = statFor(nodeId);
      stat.turns += 1;
      if (inScope) stat.convIds.add(detail.conversation_id);

      const rag = retrievedTokens(turn);
      if (rag > 0) { stat.retrieved += rag; stat.retrievedCalls += 1; }
      collectFitSignals(stat, turn, detail, tokens, hasLlm);

      if (hasLlm) {
        const cost = usageCost(usage);
        convLlmCalls += 1;
        current.cost += cost;
        current.tin += tokens.input;
        current.tout += tokens.output;
        accumulateUsage(current.usage, usage);
        accumulateUsage(convUsage, usage);
        if (inScope) {
          stat.calls += 1;
          stat.costTurns += cost;
          accumulateUsage(stat.usage, usage);
          accumulateUsage(windowUsage, usage);
          turnsTotal += cost;
          llmCallCount += 1;
          const key = dayKey(startedAt, timezone);
          stat.byDay.set(key, (stat.byDay.get(key) || 0) + cost);
        }
        const latency = llmLatencyMs(turn);
        if (latency != null) {
          stat.latencies.push(latency);
          if (inScope) allLatencies.push(latency);
        }
      }
    }

    // Edge traffic = consecutive node-id pairs across the window (SPEC §2).
    if (inScope) {
      const seen = new Set();
      for (let i = 0; i < steps.length; i += 1) {
        const node = steps[i].nodeId;
        if (i > 0) {
          const prev = steps[i - 1].nodeId;
          edgeTraffic.set(prev + '\u0000' + node, (edgeTraffic.get(prev + '\u0000' + node) || 0) + 1);
          // Revisits are counted as an observation only. In a voice agent,
          // returning to a router or greeting node is ordinary multi-turn flow,
          // not a failed attempt — it cannot distinguish retry from normal
          // looping, so it is not treated as evidence of strain.
          if (prev !== node && seen.has(node)) statFor(node).backtracks += 1;
        }
        seen.add(node);
      }
    }

    const chargingInfo = chargingOf(detail);
    const charging = chargingInfo ? chargingInfo.usage : null;
    const chargingCost = chargingInfo ? chargingInfo.cost : null;
    const convCost = chargingCost != null ? chargingCost : usageCost(convUsage);
    if (inScope) {
      if (chargingCost != null) {
        chargingTotal += chargingCost;
        chargingConvs += 1;
        accumulateUsage(chargingUsage, charging);
        if (chargingInfo.committed != null) committedTotal += chargingInfo.committed;
      }
      if (meta.cost_fiat == null) missingFiat += 1;

      const key = dayKey(startedAt, timezone);
      let bucket = byDay.get(key);
      if (!bucket) {
        bucket = { key, cost: 0, inCost: 0, outCost: 0, tin: 0, tout: 0, count: 0 };
        byDay.set(key, bucket);
      }
      const source = charging || convUsage;
      bucket.cost += convCost;
      bucket.inCost += usageInputCost(source);
      bucket.outCost += usageOutputCost(source);
      const convTokens = usageTokens(source);
      bucket.tin += convTokens.input;
      bucket.tout += convTokens.output;
      bucket.count += 1;
    }

    const convTokens = usageTokens(charging || convUsage);
    conversations.push({
      id: detail.conversation_id,
      startedAt,
      timezone,
      duration: meta.call_duration_secs ?? detail.call_duration_secs ?? 0,
      queueWait: meta.queue_wait_secs ?? 0,
      turns: transcript.length,
      llmCalls: convLlmCalls,
      steps: steps.map((s) => ({
        nodeId: s.nodeId,
        // `nodeId` here is the `agentId::nodeId` join key. When the graph has no
        // node under it — routine, because a conversation can have run a node
        // that a later version deleted — fall back to the bare node id. The join
        // key must never surface: it reads as a name and it is not one.
        label: (nodeById.get(s.nodeId) || {}).label || splitKey(s.nodeId).nodeId,
        model: dominantModel(s.usage),
        turns: s.turns,
        tin: s.tin,
        tout: s.tout,
        cost: s.cost,
      })),
      tin: convTokens.input,
      tout: convTokens.output,
      cost: convCost,
      costSource: chargingCost != null ? 'charging' : 'turns',
      costFiat: meta.cost_fiat ?? null,
      costCredits: meta.cost ?? null,
      version,
      branch,
      onVersion,
      onBranch,
      inScope,
      outcome: outcomeOf(detail),
      status: detail.status || meta.status || 'unknown',
      terminationReason: meta.termination_reason || detail.termination_reason || null,
      direction: (meta.phone_call && meta.phone_call.direction) || detail.direction || null,
      summary: (detail.analysis && detail.analysis.transcript_summary) || null,
      successScore: detail.analysis ? detail.analysis.call_success_score : null,
      detail,
    });
  }

  const inScope = conversations.filter((c) => c.inScope);

  // Totals follow `charging`, shares follow the turns (SPEC §0 reconciliation).
  const hasCharging = chargingConvs > 0;
  const windowSpend = hasCharging ? chargingTotal : turnsTotal;
  const drift = turnsTotal > 0 && hasCharging ? (chargingTotal - turnsTotal) / turnsTotal : 0;
  const scale = turnsTotal > 0 && hasCharging ? chargingTotal / turnsTotal : 1;

  if (!hasCharging) {
    warnings.push('No metadata.charging on these conversations — totals fall back to summed per-turn llm_usage.');
  }
  if (missingFiat) {
    warnings.push(missingFiat + ' conversation(s) have cost_fiat: null. USD all-in is excluded for those rather than treated as zero (SPEC §6.6).');
  }
  if (offVersion) {
    warnings.push(offVersion + ' conversation(s) ran a different version than the pinned one and are excluded.');
  }
  // Same rule as the branch filter: a conversation the API recorded no version on
  // is kept rather than guessed at. Said out loud, because otherwise pinning a
  // version whose dropdown entry reads "1 conv" returns far more than one and the
  // arithmetic looks broken.
  const unversioned = conversations.filter((c) => !c.version).length;
  if (pinnedVersion && unversioned) {
    warnings.push(unversioned + ' conversation(s) carry no version id. They are kept in the window rather '
      + 'than guessed at, so a version pin does not narrow them.');
  }
  if (offBranch) {
    warnings.push(offBranch + ' conversation(s) ran on a branch outside the selected set and are excluded.');
  }
  const unbranched = conversations.filter((c) => !c.branch).length;
  if (branchIds && branchIds.length && unbranched) {
    warnings.push(unbranched + ' conversation(s) carry no branch on their turns. They are kept in the window rather '
      + 'than guessed at, so a branch filter does not narrow them.');
  }

  // ── node ledger ────────────────────────────────────────────────────
  const ledger = [];
  for (const [id, stat] of stats.entries()) {
    const parts = splitKey(id);
    const bare = parts.nodeId;
    const def = nodeById.get(id) || {
      id,
      nodeId: bare,
      agentId: parts.agentId,
      agentName: agentsById[parts.agentId] || null,
      isPrimary: parts.agentId === primaryId,
      type: id === UNATTRIBUTED ? 'unattributed' : 'override_agent',
      label: id === UNATTRIBUTED ? 'Unattributed turns'
        : (/^[a-z_]*_?[a-z0-9]{20,}$/i.test(bare) ? bare.slice(0, 5) + '…' + bare.slice(-6) : bare),
      derivedLabel: id !== UNATTRIBUTED,
      configModel: null, prompt: '', toolIds: [], x: null, y: null,
    };
    const tokens = usageTokens(stat.usage);
    const observed = dominantModel(stat.usage);
    const latencies = stat.latencies.slice().sort((a, b) => a - b);
    ledger.push({
      ...def,
      calls: stat.calls,
      turnCount: stat.turns,
      convCount: stat.convIds.size,
      usage: stat.usage,
      tin: tokens.input,
      tout: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      freshInput: tokens.fresh,
      retrieved: stat.retrieved,
      retrievedCalls: stat.retrievedCalls,
      observedModel: observed,
      model: observed || def.configModel || null,
      modelOverridden: !!(observed && def.configModel && observed !== def.configModel),
      inCost: usageInputCost(stat.usage) * scale,
      outCost: usageOutputCost(stat.usage) * scale,
      cost: stat.costTurns * scale,
      costTurns: stat.costTurns,
      p50: latencies.length ? quantile(latencies, 0.5) : null,
      p95: latencies.length ? quantile(latencies, 0.95) : null,
      byDay: stat.byDay,
      // fit observations
      outTokens: stat.outTokens,
      distinctOutputs: stat.outputs.size,
      outputSamples: stat.outputSamples,
      toolUse: Array.from(stat.toolUse.values()),
      guardrails: stat.guardrails,
      reasonedCalls: stat.reasoned,
      interrupted: stat.interrupted,
      selfLoops: stat.selfLoops,
      backtracks: stat.backtracks,
      languages: Array.from(stat.languages),
      kbDocs: Array.from(stat.kbDocs),
      ragDistances: stat.ragDistances,
      successScores: stat.successScores,
      tinPerCall: stat.calls ? tokens.input / stat.calls : 0,
      toutPerCall: stat.calls ? tokens.output / stat.calls : 0,
      cacheReadPerCall: stat.calls ? tokens.cacheRead / stat.calls : 0,
      hitRate: inScope.length ? stat.convIds.size / inScope.length : 0,
    });
  }

  // The primary agent's whole graph belongs on the canvas — an unused node is a
  // finding. A transfer target's graph is only relevant where it actually ran,
  // otherwise every dependency pads the tables with zero-call rows.
  for (const node of graph.nodes) {
    if (stats.has(node.id)) continue;
    if (!node.isPrimary) continue;
    ledger.push({
      ...node, calls: 0, turnCount: 0, convCount: 0, usage: {}, tin: 0, tout: 0,
      cacheRead: 0, cacheWrite: 0, freshInput: 0, retrieved: 0, retrievedCalls: 0,
      outTokens: [], distinctOutputs: 0, outputSamples: 0, toolUse: [], guardrails: 0,
      reasonedCalls: 0, interrupted: 0, selfLoops: 0, backtracks: 0, languages: [],
      kbDocs: [], ragDistances: [], successScores: [],
      observedModel: null, model: node.configModel, modelOverridden: false,
      inCost: 0, outCost: 0, cost: 0, costTurns: 0, p50: null, p95: null,
      byDay: new Map(), tinPerCall: 0, toutPerCall: 0, cacheReadPerCall: 0, hitRate: 0,
    });
  }

  placeStrays(ledger, savedNodes);

  ledger.forEach((row) => {
    row.share = windowSpend ? row.cost / windowSpend : 0;
    const avatar = nodeAvatar(row);
    row.ini = avatar.ini;
    row.pmCls = avatar.cls;
  });
  ledger.sort((a, b) => b.cost - a.cost);
  const maxShare = Math.max(...ledger.map((r) => r.share), 0);

  // ── edges with traffic ─────────────────────────────────────────────
  const edges = graph.edges.map((e) => ({
    ...e,
    traffic: edgeTraffic.get(e.source + '\u0000' + e.target) || 0,
  }));
  // Transitions observed in traffic that the pinned graph does not declare.
  for (const [key, traffic] of edgeTraffic.entries()) {
    const [source, target] = key.split('\u0000');
    if (edges.some((e) => e.source === source && e.target === target)) continue;
    if (source === UNATTRIBUTED || target === UNATTRIBUTED) continue;
    edges.push({
      id: 'observed:' + key, source, target, traffic,
      forward: { kind: 'observed', label: 'observed, not in graph' }, backward: null, observed: true,
    });
  }

  // ── days ───────────────────────────────────────────────────────────
  const from = opts.from;
  const to = opts.to;
  const days = [];
  if (from && to) {
    const span = daysBetween(from, to);
    for (let i = 0; i < span; i += 1) {
      const key = shiftDays(from, i);
      const bucket = byDay.get(key);
      days.push(bucket || { key, cost: 0, inCost: 0, outCost: 0, tin: 0, tout: 0, count: 0 });
    }
  } else {
    Array.from(byDay.keys()).sort().forEach((key) => days.push(byDay.get(key)));
  }

  // ── model mix ──────────────────────────────────────────────────────
  const models = Object.entries(windowUsage).map(([name, units]) => {
    const tokens = usageTokens({ [name]: units });
    const cost = usageCost({ [name]: units }) * scale;
    const p = provider(name);
    return {
      name, ini: p.ini, pmCls: p.cls,
      calls: ledger.filter((r) => r.model === name).reduce((a, r) => a + r.calls, 0),
      tin: tokens.input, tout: tokens.output,
      cacheRead: tokens.cacheRead,
      priceIn: ratePerMillion(units.input),
      priceOut: ratePerMillion(units.output),
      priceCacheRead: ratePerMillion(units.cacheRead),
      inCost: usageInputCost({ [name]: units }) * scale,
      outCost: usageOutputCost({ [name]: units }) * scale,
      cost,
    };
  }).sort((a, b) => b.cost - a.cost);

  const windowTokens = usageTokens(hasCharging ? chargingUsage : windowUsage);
  const inSpend = usageInputCost(hasCharging ? chargingUsage : windowUsage);
  const outSpend = usageOutputCost(hasCharging ? chargingUsage : windowUsage);

  // ── prompt audit ───────────────────────────────────────────────────
  const prompts = buildPromptAudit({
    ledger, graph, toolsById, windowSpend, warnings, scale,
    conversationCount: inScope.length,
  });

  // ── trend ──────────────────────────────────────────────────────────
  let trend = null;
  if (opts.previousSpend != null && opts.previousSpend > 0) {
    trend = (windowSpend - opts.previousSpend) / opts.previousSpend;
  }

  const fit = buildFit({ ledger, prompts, models, toolsById, graph, edges, agentsById });

  const agentsInWindow = Array.from(new Set(conversations.flatMap(
    (c) => (c.detail.transcript || []).map(agentIdOf).filter(Boolean),
  )));
  const declared = new Set(Object.keys(agentDocs).concat(primaryId ? [primaryId] : []));
  const undeclaredAgents = agentsInWindow.filter((a) => !declared.has(a));
  if (undeclaredAgents.length) {
    warnings.push(undeclaredAgents.length + ' agent(s) appear in these conversations but their definitions '
      + 'are not cached, so their nodes show ids rather than names: '
      + undeclaredAgents.map((a) => agentsById[a] || a).join(', ')
      + '. They are reached by a further transfer hop — re-sync to pull them in.');
  }

  return {
    agentId: primaryId,
    agents: Array.from(declared).map((id) => ({
      agentId: id,
      name: agentsById[id] || (agentDocs[id] && agentDocs[id].name) || id,
      isPrimary: id === primaryId,
      nodes: graph.nodes.filter((n) => n.agentId === id).length,
      observed: agentsInWindow.includes(id),
    })).sort((a, b) => (b.isPrimary - a.isPrimary) || b.nodes - a.nodes),
    undeclaredAgents,
    fit,
    agentName: agent.name || opts.agentId || 'Agent',
    versionId: pinnedVersion,
    branchIds,
    branchCounts: Array.from(branchCounts.entries())
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count),
    timezone,
    graph,
    ledger,
    edges,
    maxShare,
    nodeById: new Map(ledger.map((r) => [r.id, r])),
    conversations: inScope,
    allConversations: conversations,
    days,
    models,
    prompts,
    warnings,
    trend,
    totals: {
      windowSpend,
      chargingTotal,
      turnsTotal,
      drift,
      scale,
      hasCharging,
      committedTotal,
      // Billed spend with no node behind it: generations started then abandoned.
      unattributedSpend: Math.max(0, chargingTotal - committedTotal),
      conversations: inScope.length,
      offVersion,
      offBranch,
      tin: windowTokens.input,
      tout: windowTokens.output,
      cacheRead: windowTokens.cacheRead,
      freshInput: windowTokens.fresh,
      inSpend,
      outSpend,
      llmCalls: llmCallCount,
      latencyP95: allLatencies.length ? quantile(allLatencies.slice().sort((a, b) => a - b), 0.95) : null,
      costs: inScope.map((c) => c.cost).sort((a, b) => a - b),
      missingFiat,
    },
  };
}

/**
 * Give a position to any ledger row the graph did not place — observed-only
 * nodes and unattributed turns. They cost real money, so they belong on the
 * canvas rather than in a footnote only.
 */
function placeStrays(ledger, savedNodes) {
  const strays = ledger.filter((r) => r.x == null || r.y == null);
  if (!strays.length) return;
  const placed = ledger.filter((r) => r.x != null && r.y != null);
  const columnX = placed.length ? Math.max(...placed.map((r) => r.x)) + NODE_W + 48 : 24;
  strays.forEach((row, i) => {
    const saved = savedNodes && savedNodes[row.id];
    if (saved && isFinite(saved.x) && isFinite(saved.y)) {
      row.x = saved.x;
      row.y = saved.y;
      row.moved = true;
    } else {
      row.x = columnX;
      row.y = 40 + i * (NODE_H + 28);
    }
    row.offGraph = true;
  });
}

/**
 * The billed LLM figure for one conversation, and the usage behind it.
 *
 * `charging.llm_usage` carries two buckets and they must not be added together:
 *   initiated_generation   — every generation that was started. Verified to sum
 *                            to `charging.llm_price` (the billed dollars) on 88
 *                            of 117 live conversations, and equal to the other
 *                            bucket on the rest.
 *   irreversible_generation — the subset that ran to completion. This is what
 *                            per-turn `llm_usage` sums to.
 * The gap between them is real money: generations started and then abandoned,
 * which on voice means interruptions. They are billed but carry no node, so the
 * Workflow screen reports the gap rather than hiding it.
 */
export function chargingOf(detail) {
  const meta = detail.metadata || {};
  const charging = meta.charging;
  if (!charging || typeof charging !== 'object') return null;

  const llmUsage = charging.llm_usage;
  const initiated = llmUsage && llmUsage.initiated_generation;
  const irreversible = llmUsage && llmUsage.irreversible_generation;
  const bucket = initiated || irreversible || llmUsage;

  const usage = bucket ? collectModelUsage(bucket) : {};
  const billed = typeof charging.llm_price === 'number' ? charging.llm_price : null;
  const committed = irreversible ? usageCost(collectModelUsage(irreversible)) : null;

  return {
    usage,
    cost: billed != null ? billed : usageCost(usage),
    billed,
    committed,
    hasBuckets: !!(initiated && irreversible),
  };
}

function outcomeOf(detail) {
  const meta = detail.metadata || {};
  const analysis = detail.analysis || {};
  const reason = String(meta.termination_reason || detail.termination_reason || '').toLowerCase();
  const status = String(detail.status || meta.status || '').toLowerCase();

  if (/transfer/.test(reason)) return { label: 'transferred', cls: 'badge badge--warn mono' };
  if (status && !['done', 'completed', 'processed'].includes(status)) {
    return { label: status, cls: 'badge badge--info mono' };
  }
  const successful = analysis.call_successful || detail.call_successful;
  if (successful === 'success') return { label: 'success', cls: 'badge badge--ok mono' };
  if (successful === 'failure') return { label: 'failure', cls: 'badge badge--fail mono' };
  return { label: 'unknown', cls: 'badge mono' };
}

function buildPromptAudit({ ledger, graph, toolsById, windowSpend, warnings, scale, conversationCount }) {
  const known = graph.knownAgents || new Set();
  const rootFor = (agentId) => (graph.rootPromptByAgent && graph.rootPromptByAgent[agentId] != null
    ? graph.rootPromptByAgent[agentId]
    : null);
  const audits = [];

  for (const row of ledger) {
    if (row.type === 'start' || row.type === 'end' || row.id === UNATTRIBUTED) continue;
    if (!row.isPrimary && !row.calls) continue;
    // A node earns a row when it has its own authored prompt, or when it actually
    // produced LLM calls. A tool node with neither would otherwise show up as a
    // copy of the root prompt it never sends.
    if (!(row.prompt || '').trim() && !row.calls) continue;
    // A transferred node belongs to another agent, so it carries THAT agent's
    // root prompt. Without that definition the config side is unknowable, and
    // falling back to the selected agent's prompt reports a number that looks
    // measured and is simply wrong.
    const configKnown = known.has(row.agentId);
    const authored = configKnown
      ? [rootFor(row.agentId), row.prompt].filter(Boolean).join('\n\n')
      : '';

    const toolDocs = (row.toolIds || []).map((id) => toolsById[id]).filter(Boolean);
    if ((row.toolIds || []).length && toolDocs.length < row.toolIds.length) {
      warnings.push('Tool schema missing from the cache for ' + row.label + ' — its tool-definition tokens are undercounted.');
    }
    const { buckets, vars } = composeConfigSide(authored, toolDocs);

    const measuredPerCall = row.tinPerCall;
    const retrievedPerCall = row.calls ? row.retrieved / row.calls : 0;
    if (retrievedPerCall > 0) buckets.set('retrieved chunks', retrievedPerCall);

    const configTotal = sum(Array.from(buckets.values()));
    // The gap between the assembled config and the tokens actually billed IS the
    // runtime injection — history above all. Showing it beats smoothing it away.
    const history = Math.max(0, measuredPerCall - configTotal);
    if (history > 0) buckets.set('conversation history', history);

    const segs = SEG_ORDER
      .filter((kind) => buckets.get(kind) > 0)
      .map((kind) => ({ kind, tokens: buckets.get(kind) }));
    const total = sum(segs.map((s) => s.tokens));
    const staticTokens = sum(segs.filter((s) => !isPerTurnKind(s.kind)).map((s) => s.tokens));
    const perTurnTokens = total - staticTokens;

    const units = row.usage[row.model] || null;
    // The fresh-input rate, derived from its absolute cost.
    const listInputPrice = units ? ratePerMillion(units.input) : 0;
    const actualInputCost = row.inCost;
    // Scaled the same way the ledger is, so "at list" and "cache-aware" compare.
    const listCost = listInputPrice ? (row.tin / 1e6) * listInputPrice * scale : actualInputCost;
    const effectiveInputPrice = row.tin ? (actualInputCost / row.tin) * 1e6 : listInputPrice;
    const ctx = contextWindow(row.model);

    const unknownConfig = !configKnown;
    audits.push({
      configKnown,
      id: row.id,
      label: row.label,
      agentId: row.agentId,
      agentName: row.agentName,
      isPrimary: row.isPrimary,
      model: row.model,
      ini: row.ini,
      pmCls: row.pmCls,
      calls: row.calls,
      callsPerConv: conversationCount ? row.calls / conversationCount : 0,
      convCount: row.convCount,
      hitRate: row.hitRate,
      derivedLabel: row.derivedLabel,
      type: row.type,
      promptText: authored,
      nodePrompt: row.prompt,
      vars,
      segs: unknownConfig ? [] : segs,
      measuredPerCall,
      configTotal: unknownConfig ? null : configTotal,
      totalPerCall: unknownConfig ? measuredPerCall : total,
      staticTokens: unknownConfig ? null : staticTokens,
      perTurnTokens: unknownConfig ? null : perTurnTokens,
      cacheReadPerCall: row.cacheReadPerCall,
      cachedShare: row.tin ? row.cacheRead / row.tin : 0,
      contextWindow: ctx,
      contextUsed: ctx ? measuredPerCall / ctx : null,
      residentTokens: unknownConfig ? null : staticTokens * row.calls,
      listCost,
      promptCost: actualInputCost,
      cacheSaved: Math.max(0, listCost - actualInputCost),
      effectiveInputPrice,
      listInputPrice,
      historyPerCall: unknownConfig ? null : (buckets.get('conversation history') || 0),
      retrievedPerCall,
    });
  }

  audits.sort((a, b) => b.promptCost - a.promptCost);

  const segTotals = new Map();
  for (const audit of audits) {
    if (!audit.configKnown) continue;
    for (const seg of audit.segs) {
      segTotals.set(seg.kind, (segTotals.get(seg.kind) || 0) + seg.tokens * audit.calls);
    }
  }
  const promptTokens = sum(Array.from(segTotals.values()));
  const dupes = duplicateBlocks(audits.filter((a) => a.configKnown));

  const priced = audits.filter((a) => a.configKnown && a.calls);
  const staticSpend = sum(priced.map((a) => (a.staticTokens * a.calls / 1e6) * a.effectiveInputPrice));
  const unknownConfigRows = audits.filter((a) => !a.configKnown);
  const promptSpend = sum(audits.map((a) => a.promptCost));

  return {
    audits,
    promptTokens,
    promptSpend,
    staticSpend,
    staticShare: promptSpend ? staticSpend / promptSpend : 0,
    unknownConfigRows,
    unknownConfigAgents: Array.from(new Set(unknownConfigRows.map((a) => a.agentName || a.agentId))),
    promptShareOfWindow: windowSpend ? promptSpend / windowSpend : 0,
    cacheSaved: sum(audits.map((a) => a.cacheSaved)),
    cachedTokens: sum(audits.map((a) => a.cacheReadPerCall * a.calls)),
    biggest: audits.slice().sort((a, b) => b.measuredPerCall - a.measuredPerCall)[0] || null,
    dupes,
    dupeCost: sum(dupes.map((d) => d.cost)),
    segLegend: SEG_ORDER.filter((kind) => segTotals.get(kind) > 0).map((kind) => ({
      kind,
      tokens: segTotals.get(kind),
      share: promptTokens ? segTotals.get(kind) / promptTokens : 0,
    })),
  };
}

/**
 * "Where to cut" — editorial, computed from the audit. Every figure is an
 * estimate against a stated assumption and is labelled as one (SPEC §5).
 */
// ── Phase A: deterministic model-fit assessment ───────────────────────
//
// Answers what the data can answer on its own, and stops there. Three parts:
//
//   gates     hard constraints that FORBID a smaller model. A gate is never a
//             suggestion — if it blocks, no downgrade is safe regardless of how
//             cheap the alternative looks.
//   signals   observed evidence of headroom (looks over-provisioned) or strain
//             (looks under-provisioned). Evidence, not a verdict.
//   waste     arithmetic findings that need no judgement at all: tool schemas
//             never called, KB documents never retrieved, retrieval volume.
//
// What it deliberately does NOT do: name a better model on capability grounds.
// It can say which models in the mix clear the gates and what they would cost,
// which is arithmetic; judging whether a model is *capable enough* is Phase B.

const CONTEXT_HEADROOM = 1.5;     // leave room for a longer-than-observed call
const TEMPLATED_RATIO = 0.35;
const THIN_PROMPT_TOKENS = 400;
const REASONING_BLOCK_RATE = 0.10;
const TOOL_ERROR_RATE = 0.05;
const GUARDRAIL_RATE = 0.01;
const REASONING_HEAVY = 0.20;
const INTERRUPT_RATE = 0.20;
const FEWSHOT_TOKENS = 300;
const LOW_SUCCESS = 0.6;
const MIN_SAMPLE = 30;            // below this, say "insufficient evidence"

const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const int0 = (v) => Math.round(v || 0).toLocaleString();
const pctl = (xs, q) => (xs.length ? quantile(xs.slice().sort((a, b) => a - b), q) : 0);

function fitForNode(row, audit, models, toolsById, outgoingLlmEdges) {
  const gates = [];
  const headroom = [];
  const strain = [];

  const measured = row.tinPerCall;
  const requiredContext = Math.ceil(measured * CONTEXT_HEADROOM);
  const ctx = contextWindow(row.model);
  gates.push({
    id: 'context', label: 'Context window',
    state: requiredContext > 0 ? 'constraint' : 'unknown',
    value: requiredContext,
    detail: requiredContext > 0
      ? `needs ≥ ${Math.round(requiredContext).toLocaleString()} tokens `
        + `(${Math.round(measured).toLocaleString()} observed × ${CONTEXT_HEADROOM} headroom)`
        + (ctx ? ` — current model has ${ctx.toLocaleString()}` : ' — current window unknown')
      : 'no LLM traffic on this node',
  });

  const reasoningRate = row.calls ? row.reasonedCalls / row.calls : 0;
  gates.push({
    id: 'reasoning', label: 'Reasoning',
    state: reasoningRate >= REASONING_BLOCK_RATE ? 'block' : reasoningRate > 0 ? 'constraint' : 'pass',
    value: reasoningRate,
    detail: reasoningRate >= REASONING_BLOCK_RATE
      ? `reasoning on ${pct(reasoningRate)} of calls — a non-reasoning model cannot cover this`
      : reasoningRate > 0
        ? `reasoning on ${pct(reasoningRate)} of calls — occasional, so check what those calls are before moving`
        : `no reasoning across ${int0(row.calls)} calls`,
  });

  const toolCount = (row.toolIds || []).length;
  const argDepth = (row.toolIds || []).reduce((max, id) => {
    const doc = toolsById[id];
    const schema = doc && (doc.tool_config || doc);
    const body = schema && schema.api_schema && schema.api_schema.request_body_schema;
    const props = body && body.properties ? Object.keys(body.properties).length : 0;
    return Math.max(max, props);
  }, 0);
  gates.push({
    id: 'tools', label: 'Tool calling',
    state: toolCount ? 'constraint' : 'pass',
    value: toolCount,
    detail: toolCount
      ? `${toolCount} tool${toolCount === 1 ? '' : 's'} attached, widest schema ${argDepth} argument${argDepth === 1 ? '' : 's'} — the replacement must emit these reliably`
      : 'no tools attached',
  });

  const wantsJson = /\b(return|respond with|output)\b[^.]{0,40}\bjson\b|\bjson only\b/i
    .test(audit ? audit.promptText : '');
  gates.push({
    id: 'structured', label: 'Structured output',
    state: wantsJson ? 'constraint' : 'pass',
    value: wantsJson,
    detail: wantsJson
      ? 'the prompt demands JSON — the replacement needs reliable structured output'
      : 'no structured-output requirement found in the prompt',
  });

  gates.push({
    id: 'multilingual', label: 'Languages',
    state: row.languages.length > 1 ? 'constraint' : 'pass',
    value: row.languages.length,
    detail: row.languages.length > 1
      ? `${row.languages.length} languages observed (${row.languages.slice(0, 6).join(', ')})`
      : (row.languages[0] ? `single language (${row.languages[0]})` : 'no language recorded'),
  });

  gates.push({
    id: 'routing', label: 'Routing authority',
    state: outgoingLlmEdges > 0 ? 'constraint' : 'pass',
    value: outgoingLlmEdges,
    detail: outgoingLlmEdges > 0
      ? `decides ${outgoingLlmEdges} llm-condition branch${outgoingLlmEdges === 1 ? '' : 'es'} — a misroute costs a whole path`
      : 'no llm-condition branches depend on this node',
  });

  // ── headroom ──────────────────────────────────────────────────────
  // Deliberately NOT using short outputs or low context utilisation. Voice
  // turns are short by nature and modern windows are enormous, so both fire on
  // essentially every node and discriminate nothing.
  const diversity = row.outputSamples ? row.distinctOutputs / row.outputSamples : null;
  if (diversity != null && row.outputSamples >= MIN_SAMPLE && diversity < TEMPLATED_RATIO) {
    headroom.push({ id: 'templated', label: 'Templated output',
      detail: `${int0(row.distinctOutputs)} distinct outputs across ${int0(row.outputSamples)} sampled calls `
        + `(${pct(diversity)}) — largely fixed responses` });
  }
  const toolCalls = sum(row.toolUse.map((t) => t.calls));
  const toolErrors = sum(row.toolUse.map((t) => t.errors));
  if (toolCalls >= MIN_SAMPLE && toolErrors === 0) {
    headroom.push({ id: 'tool_clean', label: 'Clean tool use',
      detail: `${int0(toolCalls)} tool calls, zero errors — argument generation is not a struggle here` });
  }
  if (row.calls >= MIN_SAMPLE && row.reasonedCalls === 0) {
    headroom.push({ id: 'no_reasoning', label: 'Never reasons',
      detail: `${int0(row.calls)} calls, not one used reasoning — positive evidence the task does not need it` });
  }
  if (row.calls >= MIN_SAMPLE && row.guardrails === 0) {
    headroom.push({ id: 'clean_instructions', label: 'No guardrail trips',
      detail: `${int0(row.calls)} calls without a guardrail — instruction-following is comfortable` });
  }
  const fewShotTokens = (audit && audit.configKnown)
    ? (audit.segs.find((x) => x.kind === 'few-shot examples') || {}).tokens || 0 : 0;
  if (audit && audit.configKnown && audit.staticTokens != null
      && audit.staticTokens < THIN_PROMPT_TOKENS && fewShotTokens === 0 && row.calls >= MIN_SAMPLE) {
    headroom.push({ id: 'thin_prompt', label: 'Thin prompt',
      detail: `${int0(audit.staticTokens)} static tokens and no examples — a short instruction, not a specification` });
  }

  // ── strain ────────────────────────────────────────────────────────
  const errorRate = toolCalls ? toolErrors / toolCalls : 0;
  if (errorRate > TOOL_ERROR_RATE) {
    strain.push({ id: 'tool_errors', label: 'Tool failures', severity: 'high',
      detail: `${pct(errorRate)} of ${int0(toolCalls)} tool calls failed — either the model's arguments or the upstream service` });
  }
  const guardRate = row.calls ? row.guardrails / row.calls : 0;
  if (guardRate > GUARDRAIL_RATE) {
    strain.push({ id: 'guardrails', label: 'Guardrails firing', severity: 'medium',
      detail: `${pct(guardRate)} of calls triggered a guardrail — instruction-following may be marginal` });
  }
  if (reasoningRate > REASONING_HEAVY) {
    strain.push({ id: 'reasoning_heavy', label: 'Leans on reasoning', severity: 'medium',
      detail: `${pct(reasoningRate)} of calls reason — this is doing real work, not pattern-matching` });
  }
  const interruptRate = row.turnCount ? row.interrupted / row.turnCount : 0;
  if (interruptRate > INTERRUPT_RATE) {
    strain.push({ id: 'interruptions', label: 'Interrupted often', severity: 'medium',
      detail: `${pct(interruptRate)} of turns interrupted — on voice that is usually latency, and a faster model cuts both the wait and the abandoned generation` });
  }
  if (fewShotTokens > FEWSHOT_TOKENS) {
    strain.push({ id: 'fewshot', label: 'Leaning on examples', severity: 'low',
      detail: `${int0(fewShotTokens)} tokens of few-shot examples — the prompt may be compensating for the model` });
  }
  const success = mean(row.successScores);
  if (row.successScores.length >= MIN_SAMPLE && success < LOW_SUCCESS) {
    strain.push({ id: 'low_success', label: 'Low success score', severity: 'high',
      detail: `mean call_success_score ${success.toFixed(2)} across ${int0(row.successScores.length)} conversations touching this node` });
  }

  // ── waste: arithmetic, no judgement ───────────────────────────────
  const called = new Set(row.toolUse.filter((t) => t.calls > 0).map((t) => t.name));
  const attached = (row.toolIds || []).map((id) => {
    const doc = toolsById[id];
    const config = (doc && (doc.tool_config || doc)) || {};
    const name = config.name || id;
    return {
      id, name,
      schemaTokens: doc ? countTokens(JSON.stringify(config)) : 0,
      calls: (row.toolUse.find((t) => t.name === name) || {}).calls || 0,
      errors: (row.toolUse.find((t) => t.name === name) || {}).errors || 0,
      known: !!doc,
    };
  });
  const unusedTools = attached.filter((t) => t.calls === 0 && t.known);
  const unusedToolTokens = sum(unusedTools.map((t) => t.schemaTokens));
  const rate = audit ? audit.effectiveInputPrice : 0;
  const unusedToolCost = (unusedToolTokens * row.calls / 1e6) * rate;

  const retrievedPerCall = row.calls ? row.retrieved / row.calls : 0;
  const retrievalCost = (row.retrieved / 1e6) * rate;
  const meanDistance = mean(row.ragDistances);

  const sampleOk = row.calls >= MIN_SAMPLE;
  const blocked = gates.some((g) => g.state === 'block');
  const constrained = gates.filter((g) => g.state === 'constraint');

  let verdict = 'insufficient_evidence';
  if (sampleOk) {
    if (strain.length && !headroom.length) verdict = 'strained';
    else if (headroom.length && !strain.length) verdict = blocked ? 'headroom_blocked' : 'headroom';
    else if (headroom.length && strain.length) verdict = 'mixed';
    else verdict = 'balanced';
  }

  return {
    id: row.id, label: row.label, model: row.model, type: row.type,
    // A node id only identifies a node together with its owning agent, and
    // names repeat: one real coordinator has `start`, `say_espera` and
    // `say_espera_base` on two different agents each.
    nodeId: row.nodeId || splitKey(row.id).nodeId,
    agentId: row.agentId, agentName: row.agentName, isPrimary: row.isPrimary !== false,
    configKnown: !!(audit && audit.configKnown),
    calls: row.calls, cost: row.cost, share: row.share,
    ini: row.ini, pmCls: row.pmCls,
    gates, headroom, strain, verdict, blocked,
    constraints: constrained.length,
    requiredContext, contextWindow: ctx,
    contextUsed: ctx && measured ? measured / ctx : null,
    diversity, successMean: row.successScores.length ? success : null,
    interruptRate, errorRate,
    tools: { attached, unusedTools, unusedToolTokens, unusedToolCost, toolCalls, toolErrors },
    kb: {
      docs: row.kbDocs, retrievedPerCall, retrievalCost, meanDistance,
      ragCalls: row.retrievedCalls,
      ragShare: row.calls ? row.retrievedCalls / row.calls : 0,
    },
    // Which models already in this window clear the context gate, cheapest
    // first. Clearing the gate is NOT the same as being capable enough.
    clearsGates: models
      .filter((m) => m.priceIn > 0 && m.priceOut > 0 && m.name !== row.model)
      .filter((m) => {
        const w = contextWindow(m.name);
        return w == null || w >= requiredContext;
      })
      .map((m) => ({
        name: m.name, priceIn: m.priceIn, priceOut: m.priceOut,
        contextWindow: contextWindow(m.name),
        // Saving if this node's tokens ran at that model's rates instead.
        delta: ((row.tin / 1e6) * (rateOf(row, 'input') - m.priceIn))
             + ((row.tout / 1e6) * (rateOf(row, 'output') - m.priceOut)),
      }))
      .filter((m) => m.delta > 0)
      .sort((a, b) => b.delta - a.delta),
  };
}

/** The node's own observed rate for a unit, derived from billed cost. */
function rateOf(row, unit) {
  const units = row.usage[row.model];
  if (!units) return 0;
  if (unit === 'output') return ratePerMillion(units.output);
  return blendedRate({ [row.model]: units }, INPUT_UNITS);
}

export function buildFit({ ledger, prompts, models, toolsById, edges, agents }) {
  const auditById = new Map(prompts.audits.map((a) => [a.id, a]));
  const llmEdgesFrom = new Map();
  for (const edge of edges) {
    if (edge.forward && edge.forward.kind === 'llm') {
      llmEdgesFrom.set(edge.source, (llmEdgesFrom.get(edge.source) || 0) + 1);
    }
  }

  const nodes = ledger
    .filter((row) => row.id !== UNATTRIBUTED && (row.calls > 0 || row.prompt))
    .map((row) => fitForNode(row, auditById.get(row.id), models, toolsById, llmEdgesFrom.get(row.id) || 0))
    .sort((a, b) => b.cost - a.cost);

  const byAgent = new Map();
  for (const n of nodes) {
    const key = n.agentId || '(unknown)';
    const slot = byAgent.get(key) || {
      agentId: n.agentId, name: n.agentName || n.agentId, isPrimary: n.isPrimary,
      nodes: 0, calls: 0, cost: 0, headroom: 0, strained: 0, blocked: 0, configMissing: 0,
    };
    slot.nodes += 1;
    slot.calls += n.calls;
    slot.cost += n.cost;
    if (n.verdict === 'headroom') slot.headroom += 1;
    if (n.verdict === 'strained') slot.strained += 1;
    if (n.blocked) slot.blocked += 1;
    if (!n.configKnown) slot.configMissing += 1;
    byAgent.set(key, slot);
  }

  return {
    nodes,
    agents: Array.from(byAgent.values()).sort((a, b) => (b.isPrimary - a.isPrimary) || b.cost - a.cost),
    totals: {
      unusedToolCost: sum(nodes.map((n) => n.tools.unusedToolCost)),
      unusedToolCount: sum(nodes.map((n) => n.tools.unusedTools.length)),
      retrievalCost: sum(nodes.map((n) => n.kb.retrievalCost)),
      headroom: nodes.filter((n) => n.verdict === 'headroom').length,
      strained: nodes.filter((n) => n.verdict === 'strained').length,
      blocked: nodes.filter((n) => n.blocked).length,
    },
  };
}

/**
 * "Where to cut" — three fixed heuristics, every number derived from the window.
 *
 * These are editorial: the *choice* of what to suggest is hardcoded here, and
 * each carries a reduction factor that is assumed, not measured. Every lever
 * therefore ships the formula and its inputs so the reader can check the
 * arithmetic, plus a `basis` saying whether the token base was measured from
 * billed usage or estimated with the local tokenizer.
 */
const TRIM_FACTOR = 0.6;
const REROUTE_FACTOR = 0.5;
const HISTORY_FACTOR = 0.5;

const maxBy = (rows, score) => rows.reduce(
  (best, r) => (best == null || score(r) > score(best) ? r : best), null,
);

export function levers(model) {
  const out = [];
  const audits = model.prompts.audits;

  // ── 1. static prompt text re-sent on every call ─────────────────────
  // The advice depends on WHAT the static tokens are. Recommending "move it to
  // retrieval" for a node whose static prompt is 71% tool schemas is useless —
  // tool definitions have to be in the request for the model to call anything.
  const resident = maxBy(audits.filter((a) => a.configKnown && a.residentTokens),
    (a) => a.residentTokens * a.effectiveInputPrice);
  if (resident && resident.residentTokens > 0) {
    const save = (resident.residentTokens / 1e6) * resident.effectiveInputPrice * TRIM_FACTOR;
    const staticSegs = resident.segs.filter((seg) => !isPerTurnKind(seg.kind));
    const biggest = staticSegs.slice().sort((a, b) => b.tokens - a.tokens)[0];
    const kind = biggest ? biggest.kind : 'instructions';
    const shareOfStatic = biggest && resident.staticTokens
      ? biggest.tokens / resident.staticTokens : 0;
    const cacheNote = resident.cachedShare > 0.4
      ? ` Prompt caching already covers ${pct(resident.cachedShare)} of this node's input, so the effective `
        + `rate is ${(resident.effectiveInputPrice).toFixed(2)}/1M against a ${resident.listInputPrice.toFixed(2)}/1M list price.`
      : '';

    const plan = {
      'tool definitions': {
        title: 'Trim the tool surface on ' + resident.label,
        body: `${int0(biggest ? biggest.tokens : 0)} of this node's ${int0(resident.staticTokens)} static tokens `
          + `(${pct(shareOfStatic)}) are tool schemas, sent on every one of ${int0(resident.calls)} calls. `
          + `Tool definitions cannot move to the knowledge base — the model needs them to call anything — so the `
          + `lever is fewer tools attached to this node, or tighter descriptions and argument schemas. `
          + `Check the Model fit screen for tools attached here but never called.${cacheNote}`,
        assumption: 'assumes a 60% cut to the schema surface',
      },
      'policy / knowledge': {
        title: 'Move ' + resident.label + "'s inline policy to the knowledge base",
        body: `${int0(biggest ? biggest.tokens : 0)} of ${int0(resident.staticTokens)} static tokens `
          + `(${pct(shareOfStatic)}) are reference text pasted into the prompt, so it ships on all `
          + `${int0(resident.calls)} calls whether or not the caller needs it. In the knowledge base, retrieval `
          + `fetches only the relevant chunks. The trade is that retrieved policy is present only when `
          + `retrieval finds it — not a safe trade for rules that must always apply.${cacheNote}`,
        assumption: 'assumes a 60% cut, and that partial presence is acceptable',
      },
      'few-shot examples': {
        title: 'Drop few-shot examples from ' + resident.label,
        body: `${int0(biggest ? biggest.tokens : 0)} of ${int0(resident.staticTokens)} static tokens `
          + `(${pct(shareOfStatic)}) are worked examples, re-sent on all ${int0(resident.calls)} calls. `
          + `Current models often need far fewer than the prompt carries — cut them progressively and watch `
          + `the node's success score rather than removing them all at once.${cacheNote}`,
        assumption: 'assumes a 60% cut to examples',
      },
      'instructions': {
        title: 'Tighten the instructions on ' + resident.label,
        body: `${int0(resident.staticTokens)} static tokens re-sent on every one of ${int0(resident.calls)} calls, `
          + `mostly authored instructions rather than reference material or schemas — so there is no structural `
          + `fix, only editing. The Prompts screen lists blocks duplicated across nodes, which is the cheapest `
          + `place to start.${cacheNote}`,
        assumption: 'assumes a 60% cut to static text',
      },
    };
    const chosen = plan[kind] || plan.instructions;

    if (save > 0) {
      out.push({
        title: chosen.title,
        body: chosen.body,
        save,
        assumption: chosen.assumption,
        basis: 'estimated',
        basisNote: 'The static token count comes from the local tokenizer, so this base is an estimate. '
          + 'The price applied to it is measured from billed usage, cache reads included.',
        formula: 'static tokens/call × calls ÷ 1e6 × effective input $/1M × 0.6',
        terms: [
          { label: 'static tokens/call', value: resident.staticTokens, kind: 'int',
            note: 'authored prompt plus tool schemas, minus the per-turn parts' },
          { label: 'largest part: ' + kind, value: biggest ? biggest.tokens : 0, kind: 'int',
            note: pct(shareOfStatic) + ' of the static prompt — this is what sets the advice above' },
          { label: 'calls in window', value: resident.calls, kind: 'int',
            note: 'turns attributed to this node' },
          { label: 'resident tokens', value: resident.residentTokens, kind: 'int',
            note: 'static × calls — what you paid to send the same text again' },
          { label: 'effective input rate', value: resident.effectiveInputPrice, kind: 'rate',
            note: 'billed input cost ÷ input tokens, so cache reads are already in it' },
          { label: 'cache read share', value: resident.cachedShare, kind: 'pct',
            note: 'how much of this node\'s input was already served from cache' },
          { label: 'assumed trim', value: TRIM_FACTOR, kind: 'pct', note: 'chosen, not measured' },
        ],
      });
    }
  }

  // ── 2. routing a node to a cheaper model ────────────────────────────
  // Rank by the saving each (node, model) pair would actually produce, not by
  // headline price. Picking "the priciest model" then hunting for a node fails
  // twice on real agents: the priciest model is often nobody's dominant model,
  // and when two models tie on price the tie-break can land on one with a few
  // thousand tokens instead of the one with a million.
  const priced = model.models.filter((m) => m.priceIn > 0 && m.priceOut > 0);
  if (priced.length > 1) {
    const cheapest = priced.slice().sort((a, b) => a.priceIn - b.priceIn)[0];
    let best = null;
    for (const row of model.ledger) {
      // The unattributed bucket is not a node — there is nothing to re-route.
      if (!row.calls || row.id === UNATTRIBUTED) continue;
      for (const [name, units] of Object.entries(row.usage)) {
        if (name === cheapest.name) continue;
        const candidate = priced.find((m) => m.name === name);
        if (!candidate) continue;
        const dIn = candidate.priceIn - cheapest.priceIn;
        const dOut = candidate.priceOut - cheapest.priceOut;
        if (dIn <= 0 && dOut <= 0) continue;
        const tin = units.input.tokens + units.cacheRead.tokens + units.cacheWrite.tokens;
        const tout = units.output.tokens;
        const save = ((tin / 1e6) * Math.max(0, dIn) + (tout / 1e6) * Math.max(0, dOut)) * REROUTE_FACTOR;
        if (save > 0 && (!best || save > best.save)) best = { row, candidate, tin, tout, save };
      }
    }
    if (best) {
      out.push({
        title: 'Route ' + best.row.label + ' off ' + best.candidate.name,
        body: best.candidate.name + ' runs ' + Math.round(best.tin + best.tout).toLocaleString()
          + ' tokens on this node at '
          + (best.candidate.priceIn / Math.max(cheapest.priceIn, 1e-9)).toFixed(1)
          + '× the input price of ' + cheapest.name
          + ', the cheapest model already in the mix on this agent.',
        save: best.save,
        assumption: 'assumes half the turns move',
        basis: 'measured',
        basisNote: 'Token counts and both rates are measured from billed usage. Whether these turns can '
          + 'actually run on the cheaper model is a judgement this figure cannot make.',
        formula: '(tok in × Δ$/1M in + tok out × Δ$/1M out) ÷ 1e6 × 0.5',
        terms: [
          { label: 'tok in on ' + best.candidate.name, value: best.tin, kind: 'int',
            note: 'this model only — the node may run others too' },
          { label: 'tok out on ' + best.candidate.name, value: best.tout, kind: 'int',
            note: 'completion tokens for this model on this node' },
          { label: best.candidate.name + ' in', value: best.candidate.priceIn, kind: 'rate',
            note: 'derived from the cost the API billed' },
          { label: cheapest.name + ' in', value: cheapest.priceIn, kind: 'rate',
            note: 'cheapest chat model observed in this window' },
          { label: 'assumed migration', value: REROUTE_FACTOR, kind: 'pct', note: 'chosen, not measured' },
        ],
      });
    }
  }

  // ── 3. runtime context growth ───────────────────────────────────────
  const history = maxBy(audits.filter((a) => a.configKnown && a.historyPerCall),
    (a) => a.historyPerCall * a.calls * a.effectiveInputPrice);
  if (history && history.historyPerCall > 0) {
    const save = (history.historyPerCall * history.calls / 1e6) * history.effectiveInputPrice * HISTORY_FACTOR;
    if (save > 0) {
      out.push({
        title: 'Cap context on ' + history.label,
        body: Math.round(history.historyPerCall).toLocaleString() + ' tokens per call arrive at runtime rather than from the '
          + 'authored prompt — replayed history and retrieval. Summarising at handoff cuts it without changing the prompt.',
        save,
        assumption: 'assumes history halves',
        basis: 'measured',
        basisNote: 'This is the gap between the input tokens actually billed and the assembled config, '
          + 'so the base is measured — it is exactly what the runtime injected.',
        formula: 'runtime tokens/call × calls ÷ 1e6 × effective input $/1M × 0.5',
        terms: [
          { label: 'runtime tokens/call', value: history.historyPerCall, kind: 'int',
            note: 'billed input tokens minus the assembled prompt' },
          { label: 'calls in window', value: history.calls, kind: 'int', note: 'turns attributed to this node' },
          { label: 'effective input rate', value: history.effectiveInputPrice, kind: 'rate',
            note: 'cache-aware, from billed cost' },
          { label: 'assumed reduction', value: HISTORY_FACTOR, kind: 'pct', note: 'chosen, not measured' },
        ],
      });
    }
  }

  return out.sort((a, b) => b.save - a.save).slice(0, 3);
}
