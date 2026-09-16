// Static per-model table.
//
// SPEC §6.4: the API exposes no context-window metadata, so this table is local
// and will drift. Prices are NOT here on purpose — they come back with every
// conversation in `charging.llm_usage`, already correct for the workspace's
// tier, burst status and dev discount (SPEC §2). Never hardcode a price.

const CONTEXT = [
  [/^gpt-4o-mini/, 128000],
  [/^gpt-4o/, 128000],
  [/^gpt-4\.1/, 1047576],
  [/^gpt-5/, 400000],
  [/^gpt-4-turbo/, 128000],
  [/^gpt-4(?!o|\.)/, 8192],
  [/^gpt-3\.5/, 16385],
  [/^o[134]-?(mini|preview)?/, 200000],
  [/^claude-(opus|sonnet|haiku)-4/, 200000],
  [/^claude-3-7/, 200000],
  [/^claude-3-5/, 200000],
  [/^claude-3/, 200000],
  [/^gemini-2\.5-pro/, 1048576],
  [/^gemini-2/, 1048576],
  [/^gemini-1\.5-pro/, 2097152],
  [/^gemini-1\.5/, 1048576],
  [/^grok/, 131072],
  [/^text-embedding-3/, 8191],
  [/^text-embedding-ada/, 8191],
];

const PROVIDERS = [
  [/^(gpt|o[134]|text-embedding|davinci|chatgpt)/, { ini: 'OA', cls: 'pm--oa', name: 'OpenAI' }],
  [/^claude/, { ini: 'CT', cls: 'pm--ct', name: 'Anthropic' }],
  [/^gemini/, { ini: 'GO', cls: 'pm--go', name: 'Google' }],
  [/^grok/, { ini: 'X', cls: 'pm--x', name: 'xAI' }],
  [/^(llama|meta)/, { ini: 'ME', cls: 'pm--as', name: 'Meta' }],
  [/^(mistral|mixtral|ministral)/, { ini: 'MI', cls: 'pm--sx', name: 'Mistral' }],
  [/^(qwen|deepseek)/, { ini: 'QW', cls: 'pm--gl', name: 'Open weights' }],
];

/** Model context window, or null when this table does not know the model. */
export function contextWindow(model) {
  if (!model) return null;
  const key = String(model).toLowerCase();
  for (const [re, size] of CONTEXT) if (re.test(key)) return size;
  return null;
}

export function provider(model) {
  if (!model) return { ini: 'EL', cls: 'pm--el', name: 'ElevenLabs' };
  const key = String(model).toLowerCase();
  for (const [re, meta] of PROVIDERS) if (re.test(key)) return meta;
  return { ini: 'EL', cls: 'pm--el', name: 'other' };
}

/**
 * Legend for the avatar marks actually present in a window.
 *
 * The two-letter marks are provider initials and the symbols are node kinds;
 * neither is guessable, so anything on screen has to be explained somewhere.
 */
export function avatarLegend(models, ledger) {
  const seen = new Map();
  const add = (ini, cls, name) => { if (!seen.has(ini)) seen.set(ini, { ini, cls, name }); };
  for (const m of models || []) {
    const p = provider(m.name);
    add(p.ini, p.cls, p.name);
  }
  for (const row of ledger || []) {
    const a = nodeAvatar(row);
    if (a.ini === 'fn') add('fn', a.cls, 'tool node — a function call, no LLM of its own');
    else if (a.ini === '▸') add('▸', a.cls, 'start of the flow');
    else if (a.ini === '■') add('■', a.cls, 'end of the flow');
    else if (a.ini === '☎') add('☎', a.cls, 'phone number node');
    else if (a.ini === 'EL') add('EL', a.cls, 'ElevenLabs or unrecognised model');
  }
  return Array.from(seen.values());
}

/** Avatar for a node: tool nodes read `fn`, start nodes an arrow. */
export function nodeAvatar(node) {
  if (node.type === 'start') return { ini: '▸', cls: 'pm--el' };
  if (node.type === 'end') return { ini: '■', cls: 'pm--el' };
  if (node.type === 'tool' && !node.model) return { ini: 'fn', cls: 'pm--el' };
  if (node.type === 'phone_number') return { ini: '☎', cls: 'pm--el' };
  const p = provider(node.model);
  return { ini: node.type === 'tool' ? 'fn' : p.ini, cls: p.cls };
}
