"""Agent Cost Explorer — Flask backend.

Its only jobs are holding the API key, calling ElevenLabs, and writing the raw
responses to disk (SPEC §0.0). It does no aggregation, no pricing, no derived
metrics. Every route below returns the cached file if present, otherwise
fetches, persists, and returns.

If a number in the UI looks wrong, the bug is in the frontend's derivation or in
the cached JSON — never in a backend aggregation. Delete ``data/`` to rule out
the latter.
"""

import calendar
import os
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_from_directory, session

import agentgraph
import demo
import elevenlabs_client as api
import keystore
import layouts
import store
import sync
from config import (DATA_DIR, DEFAULT_REGION, DEMO_REGION, ENV_API_KEY, LAYOUT_DIR,
                    RESIDENCY, SECRET_KEY, region_base, region_slug)

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.secret_key = SECRET_KEY
app.config["JSON_SORT_KEYS"] = False

# The key is posted once and kept in process memory. It is never returned to the
# browser and never written into the JSON store — only a fingerprint is.
_keys = {}
_keys_lock = threading.Lock()


def _session_id():
    sid = session.get("sid")
    if not sid:
        sid = uuid.uuid4().hex
        session["sid"] = sid
        session.permanent = True
    return sid


def _held():
    with _keys_lock:
        return _keys.get(_session_id()) or {}


def _api_key():
    return _held().get("key") or ENV_API_KEY


def _region():
    """Residency region for this session. Sticky across requests."""
    explicit = request.args.get("region")
    if explicit:
        return explicit
    return _held().get("region") or DEFAULT_REGION


def _creds():
    return api.creds(_api_key(), _region())


def _set_api_key(value, region=None, alias=None):
    with _keys_lock:
        if value:
            entry = {"key": value, "region": region or DEFAULT_REGION}
            if alias:
                entry["alias"] = alias
            _keys[_session_id()] = entry
        else:
            _keys.pop(_session_id(), None)


def _mask(key):
    if not key:
        return None
    if len(key) <= 11:
        return key[:3] + "••••"
    return key[:7] + "••••" + key[-4:]


def _day_bounds(frm, to):
    """YYYY-MM-DD window → inclusive Unix-second bounds (UTC)."""
    def parse(value, end_of_day):
        parts = [int(p) for p in str(value).split("-")]
        stamp = calendar.timegm((parts[0], parts[1], parts[2], 0, 0, 0, 0, 0, 0))
        return stamp + 86399 if end_of_day else stamp

    return parse(frm, False), parse(to, True)


def _error(status, message, **extra):
    payload = {"error": message, "status": status}
    payload.update(extra)
    return jsonify(payload), status


def _cached_or_fetch(rel, fetch, refresh=False):
    """The whole backend, in one function."""
    if not refresh:
        cached = store.read(rel)
        if cached is not None:
            return cached, True
    creds = _creds()
    if not creds.key:
        raise api.ApiError(401, "No API key held for this session.")
    payload = fetch(creds)
    store.write(rel, payload)
    store.touch(rel, api_key=creds.key, api_base=creds.base, region=creds.region)
    return payload, False


def _refresh_wanted():
    return request.args.get("refresh") in ("1", "true", "yes")


# ── page ───────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("templates", "index.html")


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


# ── session / key ──────────────────────────────────────────────────────

@app.route("/api/session")
def get_session():
    key = _api_key()
    region = _region()
    meta = store.meta()
    demo_meta = meta.get("demo")
    return jsonify({
        "has_key": bool(key),
        "key_mask": _mask(key),
        "key_source": "session" if _keys.get(session.get("sid", "")) else ("env" if ENV_API_KEY else None),
        "region": region,
        "region_slug": region_slug(region),
        "api_base": region_base(region),
        "regions": [
            {"id": key_, "label": entry["label"], "base": entry["base"]}
            for key_, entry in RESIDENCY.items()
        ],
        "demo": demo_meta,
        "is_demo_cache": (meta.get("regions", {}).get(region_slug(region), {}).get("key_fingerprint")
                          == demo.DEMO_FINGERPRINT),
        "stale_workspace": store.stale_workspace(key, region),
        "active_alias": _held().get("alias"),
        "key_backend": keystore.backend(),
        "store": store.store_stats(),
        "data_dir": DATA_DIR,
        "layout_dir": LAYOUT_DIR,
    })


@app.route("/api/key", methods=["POST"])
def post_key():
    body = request.get_json(silent=True) or {}
    key = (body.get("api_key") or "").strip()
    region = (body.get("region") or DEFAULT_REGION).strip()
    if not key:
        _set_api_key(None)
        return jsonify({"ok": True, "has_key": False})

    # Validate against the region's own host: a residency key is rejected by the
    # others, so this is also the check that the right region was chosen.
    try:
        api.validate_key(api.creds(key, region))
    except api.ApiError as exc:
        return _error(exc.status or 502, exc.message, region=region, api_base=region_base(region))

    _set_api_key(key, region)
    store.touch(store.agents_key(region), api_key=key, api_base=region_base(region), region=region)
    return jsonify({
        "ok": True,
        "has_key": True,
        "key_mask": _mask(key),
        "region": region,
        "api_base": region_base(region),
        "stale_workspace": store.stale_workspace(key, region),
    })


@app.route("/api/key", methods=["DELETE"])
def delete_key():
    _set_api_key(None)
    session.clear()
    return jsonify({"ok": True})


# ── named keys ─────────────────────────────────────────────────────────
#
# Aliases for API keys, so a workspace does not have to be re-pasted every time.
# The values live in the OS keychain; only the alias, its region and a masked
# hint ever reach the browser.

@app.route("/api/keys")
def get_keys():
    return jsonify({
        "keys": keystore.listing(),
        "backend": keystore.backend(),
        "active_alias": _held().get("alias"),
    })


@app.route("/api/keys", methods=["POST"])
def post_keys():
    body = request.get_json(silent=True) or {}
    alias = (body.get("alias") or "").strip()
    key = (body.get("api_key") or "").strip() or _api_key()
    region = (body.get("region") or _region() or DEFAULT_REGION).strip()
    if not alias:
        return _error(400, "Give the key an alias first.")
    if len(alias) > 64:
        return _error(400, "Alias must be 64 characters or fewer.")
    if not key:
        return _error(400, "No key to save — paste one first, or connect one.")

    # Only save a key that actually works, and against the region it works for.
    try:
        api.validate_key(api.creds(key, region))
    except api.ApiError as exc:
        return _error(exc.status or 502, exc.message, region=region)

    try:
        entry = keystore.save(alias, key, region)
    except (ValueError, RuntimeError) as exc:
        return _error(400, str(exc))

    _set_api_key(key, region, alias)
    return jsonify({"ok": True, "saved": entry, "backend": keystore.backend(),
                    "keys": keystore.listing()})


@app.route("/api/keys/<alias>/activate", methods=["POST"])
def activate_key(alias):
    key = keystore.load(alias)
    if not key:
        return _error(404, "No stored key for alias %r — it may have been removed "
                           "from the keychain." % alias)
    entry = next((k for k in keystore.listing() if k["alias"] == alias), None)
    region = (entry or {}).get("region") or DEFAULT_REGION
    try:
        api.validate_key(api.creds(key, region))
    except api.ApiError as exc:
        return _error(exc.status or 502, exc.message, region=region)
    _set_api_key(key, region, alias)
    return jsonify({"ok": True, "alias": alias, "region": region,
                    "key_mask": _mask(key), "api_base": region_base(region)})


@app.route("/api/keys/<alias>", methods=["DELETE"])
def forget_saved_key(alias):
    keystore.forget(alias)
    with _keys_lock:
        held = _keys.get(_session_id())
        if held and held.get("alias") == alias:
            held.pop("alias", None)
    return jsonify({"ok": True, "keys": keystore.listing()})


# ── the retrieval pipeline, cached (SPEC §0) ───────────────────────────

@app.route("/api/agents")
def get_agents():
    region = _region()
    try:
        payload, cached = _cached_or_fetch(
            store.agents_key(region), lambda c: api.list_agents(c), _refresh_wanted()
        )
    except api.ApiError as exc:
        return _error(exc.status or 502, exc.message)
    return jsonify({"data": payload, "cached": cached,
                    "fetched_at": store.fetched_at(store.agents_key(region))})


@app.route("/api/agents/<agent_id>")
def get_agent(agent_id):
    region = _region()
    version_id = request.args.get("version_id") or None
    branch_id = request.args.get("branch_id") or None
    rel = store.agent_key(agent_id, version_id, branch_id, region)
    try:
        payload, cached = _cached_or_fetch(
            rel, lambda c: api.get_agent(c, agent_id, version_id, branch_id), _refresh_wanted()
        )
    except api.ApiError as exc:
        return _error(exc.status or 502, exc.message)
    return jsonify({"data": payload, "cached": cached, "fetched_at": store.fetched_at(rel)})


@app.route("/api/agents/<agent_id>/versions/<version_id>")
def get_version(agent_id, version_id):
    """Version metadata — the only version endpoint the API exposes.

    There is no list-versions endpoint: branch objects carry no version id, so
    version ids can only come from the conversations that ran them. Given one,
    this walks back through `parents.in_branch_parent_id`.
    """
    region = _region()
    rel = store.version_key(agent_id, version_id, region)
    try:
        payload, cached = _cached_or_fetch(
            rel, lambda c: api.get_version(c, agent_id, version_id), _refresh_wanted()
        )
    except api.ApiError as exc:
        return _error(exc.status or 502, exc.message)
    return jsonify({"data": payload, "cached": cached, "fetched_at": store.fetched_at(rel)})


@app.route("/api/agents/<agent_id>/dependencies")
def get_dependencies(agent_id):
    """The agent set reachable through transfer nodes, fetched transitively.

    Called when an agent is selected, before any conversation work: reading a
    transferred conversation needs the node names and prompts of every agent it
    touches, and node ids repeat across agents so they are only unambiguous when
    paired with their owner.
    """
    region = _region()
    creds = _creds()
    docs, edges, problems = agentgraph.walk(
        creds, agent_id, region, fetch=bool(creds.key),
    )

    # Pull the tools each reachable definition references.
    fetched_tools = 0
    if creds.key:
        for doc in docs.values():
            for tool_id in agentgraph.tool_ids(doc):
                rel = store.tool_key(tool_id, region)
                if store.exists(rel):
                    continue
                try:
                    store.write(rel, api.get_tool(creds, tool_id))
                    store.touch(rel, api_key=creds.key, api_base=creds.base, region=region)
                    fetched_tools += 1
                except api.ApiError:
                    pass

    names = {}
    listing = store.read(store.agents_key(region)) or {}
    for entry in listing.get("agents") or []:
        if entry.get("agent_id"):
            names[entry["agent_id"]] = entry.get("name")
    for aid, doc in docs.items():
        names.setdefault(aid, doc.get("name"))

    return jsonify({
        "root": agent_id,
        "agents": [
            {
                "agent_id": aid,
                "name": names.get(aid),
                "nodes": len(((doc.get("workflow") or {}).get("nodes")) or {}),
                "is_root": aid == agent_id,
            }
            for aid, doc in docs.items()
        ],
        "edges": edges,
        "problems": problems,
        "tools_fetched": fetched_tools,
    })


@app.route("/api/agents/<agent_id>/backfill", methods=["POST"])
def backfill_agents(agent_id):
    """Fetch definitions for every agent that ran in an already-cached window.

    Saves a full re-sync: the conversations are already on disk, and the turns
    name every agent involved.
    """
    region = _region()
    frm = request.args.get("from")
    to = request.args.get("to")
    if not (frm and to):
        return _error(400, "from and to are required")

    index = store.read(store.index_key(agent_id, frm, to, region))
    if index is None:
        return _error(409, "Window is not cached yet — run a sync first.", needs_sync=True)

    details = []
    for summary in index.get("conversations") or []:
        cid = summary.get("conversation_id")
        detail = store.read(store.conversation_key(cid, region)) if cid else None
        if detail is not None:
            details.append(detail)

    observed = agentgraph.agent_ids_in_transcripts(details)
    creds = _creds()
    fetched, problems = agentgraph.fetch_missing(creds, observed, region)

    # Anything newly fetched may itself transfer onward.
    docs, edges, walk_problems = agentgraph.walk(
        creds, agent_id, region, fetch=bool(creds.key), extra_roots=observed,
    )
    tools_fetched = 0
    if creds.key:
        for doc in docs.values():
            for tool_id in agentgraph.tool_ids(doc):
                rel = store.tool_key(tool_id, region)
                if store.exists(rel):
                    continue
                try:
                    store.write(rel, api.get_tool(creds, tool_id))
                    store.touch(rel, api_key=creds.key, api_base=creds.base, region=region)
                    tools_fetched += 1
                except api.ApiError:
                    pass

    return jsonify({
        "observed": sorted(observed),
        "fetched": fetched,
        "known": sorted(docs),
        "still_missing": sorted(a for a in observed if a not in docs),
        "problems": problems + walk_problems,
        "tools_fetched": tools_fetched,
    })


@app.route("/api/agents/<agent_id>/branches")
def get_branches(agent_id):
    region = _region()
    rel = store.branches_key(agent_id, region)
    try:
        payload, cached = _cached_or_fetch(
            rel, lambda c: api.get_branches(c, agent_id), _refresh_wanted()
        )
    except api.ApiError as exc:
        return _error(exc.status or 502, exc.message)
    return jsonify({"data": payload, "cached": cached, "fetched_at": store.fetched_at(rel)})


@app.route("/api/tools/<tool_id>")
def get_tool(tool_id):
    region = _region()
    rel = store.tool_key(tool_id, region)
    try:
        payload, cached = _cached_or_fetch(rel, lambda c: api.get_tool(c, tool_id), _refresh_wanted())
    except api.ApiError as exc:
        return _error(exc.status or 502, exc.message)
    return jsonify({"data": payload, "cached": cached, "fetched_at": store.fetched_at(rel)})


@app.route("/api/conversations")
def get_conversations():
    region = _region()
    agent_id = request.args.get("agent_id")
    frm = request.args.get("from")
    to = request.args.get("to")
    if not (agent_id and frm and to):
        return _error(400, "agent_id, from and to are required")

    rel = store.index_key(agent_id, frm, to, region)
    after, before = _day_bounds(frm, to)
    try:
        payload, cached = _cached_or_fetch(rel, lambda c: _fetch_index(c, agent_id, after, before),
                                           _refresh_wanted())
    except api.ApiError as exc:
        return _error(exc.status or 502, exc.message)
    return jsonify({"data": payload, "cached": cached, "fetched_at": store.fetched_at(rel)})


def _fetch_index(creds, agent_id, after, before):
    conversations, pages = api.list_conversations(creds, agent_id, after, before)
    return {
        "agent_id": agent_id,
        "call_start_after_unix": after,
        "call_start_before_unix": before,
        "conversations": conversations,
        "pages": pages,
    }


@app.route("/api/conversations/<conversation_id>")
def get_conversation(conversation_id):
    region = _region()
    rel = store.conversation_key(conversation_id, region)
    cached = store.cached_conversation(conversation_id, region)
    if cached is not None and not _refresh_wanted():
        return jsonify({"data": cached, "cached": True, "fetched_at": store.fetched_at(rel)})
    creds = _creds()
    if not creds.key:
        return _error(401, "No API key held for this session.")
    try:
        payload = api.get_conversation(creds, conversation_id)
    except api.ApiError as exc:
        return _error(exc.status or 502, exc.message)
    store.write(rel, payload)
    store.touch(rel, api_key=creds.key, api_base=creds.base, region=creds.region)
    return jsonify({"data": payload, "cached": False, "fetched_at": store.fetched_at(rel)})


# ── window bundle ──────────────────────────────────────────────────────

@app.route("/api/window")
def get_window():
    """Every cached response the frontend needs for one window, in one read.

    Still a cache read and nothing else: the agent document, the branches, the
    conversation index and each conversation detail are returned verbatim, exactly
    as they were persisted. Batched only so the browser makes one request instead
    of one per conversation.
    """
    region = _region()
    agent_id = request.args.get("agent_id")
    frm = request.args.get("from")
    to = request.args.get("to")
    version_id = request.args.get("version_id") or None
    branch_id = request.args.get("branch_id") or None
    if not (agent_id and frm and to):
        return _error(400, "agent_id, from and to are required")

    index_rel = store.index_key(agent_id, frm, to, region)
    index = store.read(index_rel)
    if index is None:
        return _error(409, "Window is not cached yet — run a sync first.",
                      needs_sync=True)

    # Most specific graph first: a pinned version, then the branch tip, then the
    # agent's live config.
    agent = None
    for key in (store.agent_key(agent_id, version_id, None, region) if version_id else None,
                store.agent_key(agent_id, None, branch_id, region) if branch_id else None,
                store.agent_key(agent_id, None, None, region)):
        if key and agent is None:
            agent = store.read(key)

    details = []
    missing = []
    for summary in index.get("conversations") or []:
        cid = summary.get("conversation_id")
        if not cid:
            continue
        detail = store.read(store.conversation_key(cid, region))
        if detail is None:
            missing.append(cid)
        else:
            details.append(detail)

    # Keyed by the id the document reports, NOT by its filename. `store.safe()`
    # replaces ":" with "_" to make a legal filename, so an MCP tool the graph
    # references as `mcp:server:tool` is stored as `mcp_server_tool.json`. Keying
    # by the filename stem made every MCP tool unresolvable by id — all 5 in one
    # real workspace — which silently dropped their schemas from prompt
    # composition, their names from node labels, and their rows from the fit
    # screen, while raising a "schema missing from the cache" warning for
    # documents that were sitting right there.
    tools = {}
    tools_dir = os.path.join(DATA_DIR, store.ns(region), "tools")
    if os.path.isdir(tools_dir):
        for name in sorted(os.listdir(tools_dir)):
            if not name.endswith(".json"):
                continue
            doc = store.read(os.path.join(store.ns(region), "tools", name))
            if doc is None:
                continue
            real_id = doc.get("id") if isinstance(doc, dict) else None
            tools[real_id if isinstance(real_id, str) and real_id else name[:-5]] = doc

    meta = store.meta()
    return jsonify({
        "agent": agent,
        # The agent list resolves transfer-target names on standalone_agent nodes.
        "agents": store.read(store.agents_key(region)),
        # Every definition reachable through transfer nodes, keyed by agent id.
        # Node ids repeat across agents, so a transferred conversation can only
        # be read with the whole reachable set in hand.
        "agent_docs": _reachable_docs(agent_id, region, details),
        "branches": store.read(store.branches_key(agent_id, region)),
        "index": index,
        "conversations": details,
        "tools": tools,
        "missing": missing,
        "meta": {
            "fetched_at": store.fetched_at(index_rel),
            "api_base": region_base(region),
            "region": region,
            "key_fingerprint": meta.get("regions", {}).get(region_slug(region), {}).get("key_fingerprint"),
            "is_demo": (meta.get("regions", {}).get(region_slug(region), {}).get("key_fingerprint")
                        == demo.DEMO_FINGERPRINT),
            "stale_workspace": store.stale_workspace(_api_key(), region),
        },
    })


def _reachable_docs(agent_id, region, conversations=None):
    """Cached definitions for the agent, its transfer targets, and anything that
    actually ran in these conversations."""
    observed = agentgraph.agent_ids_in_transcripts(conversations or [])
    docs, _edges, _problems = agentgraph.walk(
        None, agent_id, region, fetch=False, extra_roots=observed,
    )
    return docs


# ── sync ───────────────────────────────────────────────────────────────

@app.route("/api/sync", methods=["POST"])
def post_sync():
    agent_id = request.args.get("agent_id") or (request.get_json(silent=True) or {}).get("agent_id")
    frm = request.args.get("from") or (request.get_json(silent=True) or {}).get("from")
    to = request.args.get("to") or (request.get_json(silent=True) or {}).get("to")
    force = request.args.get("force") in ("1", "true", "yes")
    if not (agent_id and frm and to):
        return _error(400, "agent_id, from and to are required")

    creds = _creds()
    if not creds.key:
        return _error(401, "No API key held for this session.")

    after, before = _day_bounds(frm, to)
    branch_ids = request.args.getlist("branch_id") or None
    job = sync.start(creds, agent_id, after, before, frm, to, force=force, branch_ids=branch_ids)
    return jsonify(job)


@app.route("/api/sync/status")
def get_sync_status():
    job_id = request.args.get("job_id")
    job = sync.status(job_id) if job_id else sync.latest()
    if not job:
        return _error(404, "no such job")
    return jsonify(job)


# ── graph layout ───────────────────────────────────────────────────────
#
# Where the user dragged each node. Display state, not API data, and stored
# outside the response cache so deleting data/ does not lose it.

@app.route("/api/layout")
def get_layout():
    agent_id = request.args.get("agent_id")
    if not agent_id:
        return _error(400, "agent_id is required")
    branch_id = request.args.get("branch_id") or None
    return jsonify(layouts.load(agent_id, branch_id, _region()))


@app.route("/api/layout", methods=["PUT"])
def put_layout():
    body = request.get_json(silent=True) or {}
    agent_id = request.args.get("agent_id") or body.get("agent_id")
    if not agent_id:
        return _error(400, "agent_id is required")
    branch_id = request.args.get("branch_id") or body.get("branch_id") or None
    saved = layouts.save(agent_id, body.get("nodes"), body.get("view"), branch_id, _region())
    return jsonify(saved)


@app.route("/api/layout", methods=["DELETE"])
def delete_layout():
    agent_id = request.args.get("agent_id")
    if not agent_id:
        return _error(400, "agent_id is required")
    branch_id = request.args.get("branch_id") or None
    return jsonify(layouts.clear(agent_id, branch_id, _region()))


# ── demo / store management ────────────────────────────────────────────

@app.route("/api/demo", methods=["POST"])
def post_demo():
    body = request.get_json(silent=True) or {}
    days = int(body.get("days") or 14)
    per_day = int(body.get("per_day") or 44)
    started = time.time()
    # Always its own namespace, never a real workspace's.
    descriptor = demo.generate(days=days, per_day=per_day, region=DEMO_REGION)
    with _keys_lock:
        held = _keys.setdefault(_session_id(), {})
        held["region"] = DEMO_REGION
    descriptor["elapsed_secs"] = round(time.time() - started, 2)
    descriptor["store"] = store.store_stats()
    return jsonify(descriptor)


@app.route("/api/store/demo", methods=["DELETE"])
def delete_demo():
    """Remove demo fixtures only, leaving every fetched response in place."""
    removed = store.purge_source(demo.DEMO_FINGERPRINT)
    with _keys_lock:
        held = _keys.get(_session_id())
        if held and held.get("region") == DEMO_REGION:
            held["region"] = DEFAULT_REGION
    return jsonify({"ok": True, "removed": len(removed), "store": store.store_stats()})


@app.route("/api/store", methods=["DELETE"])
def delete_store():
    store.wipe()
    return jsonify({"ok": True, "store": store.store_stats()})


if __name__ == "__main__":
    if not os.path.isdir(DATA_DIR):
        os.makedirs(DATA_DIR)
    app.run(host=os.environ.get("ACE_HOST", "127.0.0.1"),
            port=int(os.environ.get("ACE_PORT", "5000")),
            debug=os.environ.get("ACE_DEBUG") == "1",
            threaded=True)
