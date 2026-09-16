// Config-side token counting.
//
// SPEC §6.3: ElevenLabs exposes no tokenizer endpoint, so every config-side
// prompt size on the Prompts screen is a local estimate and is labelled as one.
// The only ground truth is the input token count in `llm_usage` / `charging`.
//
// Two tiers, and the UI says which one produced the numbers:
//   cl100k    — a real BPE tokenizer, loaded lazily from a CDN
//   approx    — a byte/word heuristic used offline or when the load fails

const CDN = 'https://cdn.jsdelivr.net/npm/gpt-tokenizer@2.9.0/esm/model/cl100k_base.js';

let encoder = null;
let source = 'approx';
let loading = null;
const cache = new Map();

/**
 * Heuristic fallback.
 *
 * The previous version took a per-word ceiling (`ceil(len / 4.1)`, minimum 1).
 * Measured against cl100k on the same 11,811-character Spanish prompt it
 * returned 4,071 tokens where cl100k returned 2,432 — **67% over**. BPE merges
 * the leading space into a token and merges common subwords, so a per-word floor
 * of one token overcounts badly on any language with many short words.
 *
 * This counts characters instead, with a word-count floor so text made of very
 * short tokens is not undercounted, and a separate CJK path where one character
 * is roughly one token. Measured on the same prompt: 3,013 tokens (3.92
 * chars/token) against cl100k's 2,432 (4.86) — 24% over, down from 67%. Still an
 * estimate, which is why every figure derived from it is prefixed `~` and the
 * active tier is shown on the Prompts screen.
 */
const CHARS_PER_TOKEN = 4.0;

function approximate(text) {
  if (!text) return 0;
  const str = String(text);
  const cjk = (str.match(/[\u3000-\u9fff\uac00-\ud7af\u3040-\u30ff]/g) || []).length;
  const latin = Math.max(0, str.length - cjk);
  const words = (str.match(/\S+/g) || []).length;
  // Newlines and runs of punctuation resist merging, so they get their own floor.
  const breaks = (str.match(/\n/g) || []).length;
  return Math.round(cjk + breaks + Math.max(words * 0.75, latin / CHARS_PER_TOKEN));
}

/** Try to upgrade to a real tokenizer. Resolves to true when the upgrade lands. */
export function upgrade() {
  if (loading) return loading;
  loading = import(/* webpackIgnore: true */ CDN)
    .then((mod) => {
      const encode = mod.encode || (mod.default && mod.default.encode);
      if (typeof encode !== 'function') throw new Error('no encode export');
      encode('probe');
      encoder = encode;
      source = 'cl100k';
      cache.clear();
      return true;
    })
    .catch(() => false);
  return loading;
}

export function countTokens(text) {
  if (!text) return 0;
  const key = text.length > 2000 ? text.length + ':' + text.slice(0, 120) + text.slice(-60) : text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let n;
  if (encoder) {
    try { n = encoder(text).length; } catch (e) { n = approximate(text); }
  } else {
    n = approximate(text);
  }
  if (cache.size < 4000) cache.set(key, n);
  return n;
}

export const tokenizerSource = () => source;

/** True when config-side sizes come from a real tokenizer rather than the heuristic. */
export const tokenizerExact = () => source === 'cl100k';

export const tokenizerLabel = () => (source === 'cl100k'
  ? 'cl100k_base (BPE) — config-side sizes are estimates; runtime token counts are exact'
  : 'heuristic estimator — no tokenizer library loaded. Config-side sizes run roughly '
    + '20% high on non-English prose and are marked ~ throughout; runtime token counts are exact.');
