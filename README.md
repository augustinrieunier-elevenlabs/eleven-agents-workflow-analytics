# Agent Cost Explorer

Costs an ElevenAgents (Conversational AI) workflow node by node, from the conversations in a
date window. Built to `ClaudeDesign/SPEC.md`; the UI follows `ClaudeDesign/Agent Cost Explorer.dc.html`.

```
ElevenLabs API ──► Flask backend ──► JSON files on disk ──► HTML/JS frontend
   (xi-api-key)      fetch + cache        local store         all maths + rendering
```

## Run it

```bash
pip install -r requirements.txt
python3 app.py                 # http://127.0.0.1:5000
```

Then either:

- **Pick a saved key by alias**, if you have stored one (see below).
- **Connect a workspace key** on the Setup screen. It is posted once, held in process memory,
  and never returned to the browser or written into the JSON store — only a SHA-256 fingerprint
  of it goes into `_meta.json`. `ELEVENLABS_API_KEY` in the environment works as a bootstrap.
- **Press "Use demo data"** to write API-shaped fixtures into `data/` and explore every screen
  offline. The fixtures use the same field names and nesting the real API returns, so the
  frontend runs the same code paths either way.

Pick the **residency region** first, then the agent, then **which branches to pull data from**, then
the window. Press **Retrieve**.

A workspace with hundreds of agents gets a **search** field in step 2 (and in compact entry) that
matches on name and `agent_id`; all words must match. The list renders the first 40 matches and
says how many more there are. Typing patches only the results in place — the input is never
rebuilt, so focus, caret, scroll position and the browser's own undo survive every keystroke. The selected agent stays pinned on screen even when the query
excludes it, so it is never unclear which agent Retrieve will use.
With a key this runs a sync (the expensive step — one request per conversation) and shows
progress; without one it opens whatever window is already cached.

### Multi-agent workflows

Agents transfer to other agents via `standalone_agent` nodes, transitively. Selecting an agent
resolves that whole reachable set **before** any conversation work — their node names and prompts
are needed to read a transferred conversation at all. The Setup screen lists what it found, and
anything it could not fetch.

Node ids repeat across agents, so nodes are keyed `agentId::nodeId`. Without that, four agents'
`start_node` merged into one ledger row. Each node is audited against **its own** agent's root
prompt, and the Prompts screen's **Agent** column says which agent owns each row.

### Saved keys

Re-pasting a key for every session is tedious when you work across regions, so keys can be saved
under an alias and picked from a dropdown. The values go into the **OS keychain**
(`security add-generic-password`, service `elevenlabs-agent-cost-explorer`), not into the browser
and not into a file. `.keys.json` holds only the alias, its region, a masked hint and a timestamp;
it is mode 0600 and gitignored.

Deliberately **not** `localStorage`, even though the UI would be identical: browser storage is
plaintext readable by any script on the origin, persists indefinitely, rides along in profile
backups and sync, and outlives the point at which the key should have been rotated. The keychain
is encrypted at rest and gated by the login keychain — the local equivalent of a secret manager,
which is what the security policy asks for.

A key is validated against its region's host before it is stored, so a bad or wrong-region key is
never saved. Selecting an alias switches the session key **and** its region, which clears the
agent, branch and version selection — it is a different workspace. On a platform without a
keychain the store falls back to process memory and the UI says so.

| Route | Purpose |
|---|---|
| `GET /api/keys` | aliases, regions, masked hints — never a key value |
| `POST /api/keys` | validate then store under an alias |
| `POST /api/keys/<alias>/activate` | make that key the session's |
| `DELETE /api/keys/<alias>` | forget it (keychain item and index entry) |

### Data residency

An ElevenLabs residency environment is an **isolated account**: a different host, a different
workspace, and a key that only works against its own region. So the region is chosen on the Setup
screen before connecting, the key is validated against that region's host, and the JSON store is
namespaced by region — `data/eu/…` never overwrites `data/global/…`.

| Region | API base |
|---|---|
| Global (US) | `https://api.elevenlabs.io` |
| EU residency | `https://api.eu.residency.elevenlabs.io` |
| India residency | `https://api.in.residency.elevenlabs.io` |
| Singapore residency | `https://api.sg.residency.elevenlabs.io` |

Switching region clears the agent, branch and version selection, because none of it carries across
accounts. A 401 names the host that rejected the key, since the most common cause is a key from one
region pointed at another. `ELEVENLABS_REGION` sets the default; `ELEVENLABS_API_BASE` overrides the
table entirely for a staging or self-hosted host (and gets its own cache namespace).

### Branch and version scope

> **SPEC.md is wrong here.** §0 step 2 says recent versions come back on the branch response as
> `most_recent_versions[]`. They do not. The real endpoint returns
> `{results: [...], meta: {total, page, page_size}}`, and a branch object carries **no version
> identifier at all** — confirmed against the live API and the published reference. Versions are
> therefore not enumerable up front, and the app no longer pretends otherwise.

`GET /v1/convai/agents/{id}/branches` lists branches. Selecting an agent loads it and shows every
branch as a chip with its live traffic percentage, 7-day call count and last commit date. All
branches start selected, so nothing is dropped from the window unless the user says so;
deselecting all blocks retrieval rather than quietly costing everything.

Versions appear **after** a window is retrieved, taken from the conversations that actually ran
them (`version_id` on the conversation and on each turn's `agent_metadata`). Each one is then
enriched via `GET /v1/convai/agents/{id}/versions/{version_id}` — the one version endpoint that
does exist — for its sequence number, description and branch. That is the only honest source: a
version is offered because it demonstrably ran in this window.

Branch is the primary selector and version is a refinement inside it:

- **One branch selected** → once versions are known, the pin defaults to that branch's most
  recent observed commit. Before the first retrieve there are no versions, so there is no pin.
- **Several branches selected** → no version pin, because pinning one version would silently
  exclude the other branches.
- A version you pick by hand is left alone until it falls outside the branch selection, at which
  point it is dropped rather than applied invisibly.

Scope is enforced per conversation, read from `transcript[].agent_metadata.branch_id`. A
conversation carrying no branch is kept rather than guessed at, and the count of anything
excluded — by branch or by version — is reported in the caveats banner on every screen.

## Layout

| Path | What it is |
|---|---|
| `app.py` | Flask routes. Cache-or-fetch, nothing else. |
| `store.py` | The JSON store: one file per API response, keyed by id. |
| `elevenlabs_client.py` | HTTP against `api.elevenlabs.io`, with retry and backoff. |
| `sync.py` | Background window walk with progress. |
| `demo.py` | Deterministic API-shaped fixtures. |
| `static/js/derive.js` | **Every derived number in the product.** |
| `static/js/screens/` | One pure renderer per screen, plus the drawers. |
| `static/js/app.js` | State, routing, the shell, delegated event handling. |
| `static/kit.css`, `static/ds/` | The design system, copied from `ClaudeDesign/`. |

## The backend computes nothing

It holds the key, calls the API, and writes responses to disk verbatim — no reshaping, no field
pruning. So:

- Changing a metric definition is a frontend edit. No re-fetch, no deploy.
- If a number looks wrong, the bug is in `derive.js` or in the cached JSON. Delete `data/` to
  rule out the second.

Routes, all cache-first:

| Route | Backing call |
|---|---|
| `GET /api/agents` | `GET /v1/convai/agents` |
| `GET /api/agents/<id>?version_id=&branch_id=` | `GET /v1/convai/agents/{id}` |
| `GET /api/agents/<id>/branches` | `GET /v1/convai/agents/{id}/branches` (paginated `results[]`) |
| `GET /api/agents/<id>/versions/<vid>` | `GET /v1/convai/agents/{id}/versions/{version_id}` |
| `GET /api/tools/<id>` | `GET /v1/convai/tools/{id}` |
| `GET /api/conversations?agent_id=&from=&to=` | paginated list, pages concatenated |
| `GET /api/conversations/<id>` | conversation detail |
| `GET /api/window?agent_id=&from=&to=` | every cached response for one window, batched |
| `POST /api/key` | validates the key against its region's host, holds both server-side |
| `POST /api/sync?agent_id=&from=&to=` | walks the window, fills the cache, reports progress |
| `GET /api/sync/status?job_id=` | progress for a sync |
| `GET`/`PUT`/`DELETE /api/layout` | saved graph layout (outside the response cache) |
| `POST /api/demo` · `DELETE /api/store` | seed fixtures · drop the cache |
| `DELETE /api/store/demo` | drop only demo fixtures |

`/api/window` is the one addition to the route table in the SPEC. It is still only a cache read
— the agent document, the index and each conversation detail come back exactly as persisted —
batched so the browser makes one request instead of 1,240.

## The workflow canvas

A real agent graph does not fit a fixed viewport, so the canvas is interactive:

- **Zoom** with the scroll wheel (anchored on the pointer), the `+` / `−` buttons, or `1:1`.
  **Fit** scales the whole graph into view; if even minimum zoom cannot fit it, the view anchors
  top-left so the start of the flow is on screen rather than centred on empty space.
- **Pan** by dragging the background.
- **Move a node** by dragging it. Connected edges redraw live; unconnected ones are left alone.
  A click that does not move opens the node drawer, so dragging never opens it by accident.
- Nodes that carried traffic but are absent from the pinned graph get a dashed border and a spare
  column on the right, instead of being invisible.

Positions and the zoom/pan view are saved per **region + agent + branch** and reload with the
window. They live in `layouts/`, **not** in `data/` — the response cache is disposable, a
hand-arranged graph is not, so wiping the cache keeps the arrangement. **Reset positions** drops
the override and falls back to the graph's own coordinates.

| Route | Purpose |
|---|---|
| `GET /api/layout?agent_id=&branch_id=` | saved positions + view |
| `PUT /api/layout?agent_id=&branch_id=` | save positions + view |
| `DELETE /api/layout?agent_id=&branch_id=` | drop the override |

## Cache rules

- A conversation with `status: "done"` is immutable: written once, never re-fetched.
- `initiated` / `in-progress` / `processing` are re-fetched every run.
- The list index is keyed by agent + window, so changing the dates triggers exactly the missing
  detail fetches.
- `_meta.json` records when each key was fetched and a fingerprint of the key that fetched it,
  so a stale or wrong-workspace cache is detectable — the UI says so when it is.

- Demo fixtures get their own namespace (`data/demo/`) and never share one with a real workspace.
  `DELETE /api/store/demo` removes exactly the demo-written files — every write records its source
  in `_meta.json` — leaving fetched responses untouched.
- `_meta.json` is re-read and merged at every flush, so a dev server and a script sharing the
  store cannot clobber each other's index.

`data/` is a test-purpose store: flat files, no database, no migrations, safe to delete.
`layouts/` is not part of it and survives deleting `data/`.

## How the numbers are derived

**Agent list.** `GET /v1/convai/agents` is cursor-paginated and caps at 100 per page. Every page
is followed, so a workspace with hundreds of agents shows all of them in the picker.

**Node attribution.** There is no per-node cost endpoint. Each `transcript[]` entry carries
`agent_metadata` (which workflow node ran the turn) and `llm_usage` (tokens per model, with the
prices that billed them). Group turns by node id, sum, price. Everything on the Workflow and
Prompts screens is that one group-by.

**Prices are never hardcoded** — and `price` is not a rate.

> **SPEC.md §2 is wrong here.** It says "prices are per 1M tokens". They are not: `price` is the
> **absolute dollar cost already computed for those tokens**. Verified against live data —
> `{tokens: 1015, price: 0.00015225}` is exactly `1015 / 1e6 × $0.15/1M`. Treating it as a rate
> understates every cost by a factor of `tokens / 1e6`, which is what rendered real spend as
> `$0.000`. Per-1M rates shown in the UI are derived back out with `ratePerMillion()`; deriving
> them returns exactly the published list prices, which is the check that the reading is right.

The four billable units — fresh input, cache read, cache write, output — each carry their own
cost, already reflecting the workspace tier, burst status and any dev discount. The only static
table is model context windows (`static/js/models.js`), because the API exposes none.

**Reconciliation, and what the drift actually is.** `charging.llm_usage` carries two buckets that
must never be summed together:

| Bucket | Meaning | Sums to |
|---|---|---|
| `initiated_generation` | every generation **started** | `charging.llm_price` — the billed dollars |
| `irreversible_generation` | the subset that **completed** | per-turn `transcript[].llm_usage` |

Verified on live data: `initiated_generation` equals `llm_price` on 88 of 117 conversations and
equals the other bucket on the rest. Summing both double-counts by ~1.9×.

The gap between them is real money with **no node behind it**: generations begun and then
abandoned, which on voice means interruptions. Across six real windows it ran **25–70% of billed
LLM spend**. The Workflow screen states the figure rather than hiding it.

So: totals follow `llm_price`, shares follow the turns, and each node's spend is its turn share
scaled to what was actually charged — the ledger sums to the window spend exactly. Validated
against six real cached windows (104 to 8,787 conversations, $1.30 to $155.41) where window
spend, the node ledger and the daily buckets all agree with an independent sum of `llm_price` to
eight decimal places.

**Precision.** Per-turn and per-node costs live between 1e-4 and 1e-6 dollars, so anything under
a dollar is shown to six decimals, and a non-zero value below `$0.000001` renders as
`<$0.000001` rather than zero. Nothing is rounded during calculation — only at display.

**Prompt composition.** Static kinds (instructions, policy, few-shot, tool schemas) are counted
with a local tokenizer and are *estimates* — the badge on the Prompts screen says which
tokenizer produced them. `conversation history` is not estimated: it is the gap between the
tokens actually billed for input and the assembled config, which is exactly what the runtime
injected. Where config and measurement disagree, the difference is shown rather than smoothed.

## Model fit (Phase A)

The **Model fit** screen answers what the traffic can answer on its own, and stops there. Three parts,
each with a different epistemic status:

- **Constraints** are hard: read off observed behaviour and they *forbid* a smaller model regardless of
  price. Context requirement (measured tokens/call × 1.5 headroom), reasoning use, tool-calling surface,
  structured-output demands, language count, and whether the node decides `llm`-condition branches.
- **Signals** are evidence, not verdicts. Headroom: templated output, zero tool errors, never reasons,
  no guardrail trips, thin prompt. Strain: tool failures, guardrails firing, leans on reasoning, high
  interruption rate, few-shot dependence, low `call_success_score`.
- **Waste** is arithmetic and needs no judgement: tool schemas attached but never called (priced at the
  node's own effective input rate × calls), resident KB documents, retrieval volume and mean vector
  distance.

It deliberately **does not name a better model on capability grounds**. It lists which models already in
the window clear the context gate and what they would cost — arithmetic — and labels that clearing a gate
is not the same as being capable enough. Sample floor is 30 calls; below that a node reads
*not enough traffic*.

Two calibration notes, both learned from real traffic rather than assumed:

- `triggered_guardrails` and `reasoning` arrive as **empty arrays**, not null. `if (turn.x)` is therefore
  true on every turn — length must be checked. Measured rates are ~3.7% for `reasoned`, not 100%.
- **Short outputs and low context utilisation are not used as headroom signals.** Voice turns are short
  by nature and current context windows are enormous, so both fire on essentially every node and
  discriminate nothing. Revisiting a node is likewise not treated as a retry: in a voice flow, returning
  to a router is ordinary multi-turn behaviour.

### "Where to cut" is editorial

The three levers on the Analytics screen are **fixed heuristics written in `levers()`** — not model
output, not an API. Every number is derived from the loaded window; the choice of what to suggest,
and the reduction factor each one applies, are assumptions. The UI states the formula under each
card and lists every input on hover, and badges whether the token base was **measured** from billed
usage or **estimated** with the local tokenizer.

| Lever | Formula | Base |
|---|---|---|
| Trim the … prompt | `static tok/call × calls ÷ 1e6 × effective input $/1M × 0.6` | estimated (tokenizer) |
| Route … off *model* | `(tok in × Δ$/1M in + tok out × Δ$/1M out) ÷ 1e6 × 0.5` | measured |
| Cap context on … | `runtime tok/call × calls ÷ 1e6 × effective input $/1M × 0.5` | measured |

The reroute lever ranks **every (node, model) pair by the saving it would produce**, rather than
picking the priciest model and hunting for a node. Picking by headline price failed three ways on
real agents: the priciest model is often nobody's dominant model so the lever vanished; when two
models tie on price the tie-break landed on one with a few thousand tokens instead of a million;
and the node's whole token count was used when only some of its tokens ran on that model. It also
skips the unattributed bucket, which is not a node and cannot be re-routed.

Savings in a card share one decimal precision (`alignedUsd`), because three figures meant to be
compared should not mix two and six decimals.

**Things the app will not pretend to know**, per SPEC §6: post-call analysis cost is kept out of
the node ledger; `cost_fiat: null` is excluded rather than coerced to zero, and the count is
surfaced; per-node cache attribution is labelled an approximation in the node drawer, because
cache accounting is per conversation per model; conversations on a version other than the pinned
one are excluded and counted; and transitions observed in traffic that the pinned graph does not
declare are drawn in amber rather than dropped.

## Scale

A 1,240-conversation window is 1,240 detail requests on the first sync and near-zero after.
`ACE_SYNC_WORKERS` (default 6) sets the fetch concurrency. The whole window is loaded into
browser memory once — tens of MB of JSON — and derived aggregates are kept rather than
transcripts re-walked per render.

## Environment

| Variable | Default |
|---|---|
| `ELEVENLABS_API_KEY` / `XI_API_KEY` | unset — use the Setup screen |
| `ELEVENLABS_REGION` | `global` (`eu`, `in`, `sg`) |
| `ACE_DATA_DIR` | `./data` |
| `ACE_LAYOUT_DIR` | `./layouts` |
| `ACE_KEYS_FILE` | `./.keys.json` (alias index; no key values) |
| `ACE_SYNC_WORKERS` | `6` |
| `ACE_PAGE_SIZE` | `100` |
| `ACE_PORT` / `ACE_HOST` | `5000` / `127.0.0.1` |
| `ACE_SECRET_KEY` | dev placeholder — set it for anything shared |
| `ELEVENLABS_API_BASE` | unset — overrides the residency table when set |
