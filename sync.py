"""Window sync — walks a date window and fills the cache.

This is the expensive half of the retrieval pipeline: step 5 of SPEC §0 is one
request per conversation, so a 1,240-conversation window is 1,240 requests. The
job runs on a background thread and reports progress; the cache rules mean a
second run over the same window costs almost nothing.
"""

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import agentgraph
import elevenlabs_client as api
import store
from config import SYNC_WORKERS

_jobs = {}
_lock = threading.Lock()


def _new_job(agent_id, frm, to):
    job = {
        "job_id": uuid.uuid4().hex[:12],
        "agent_id": agent_id,
        "from": frm,
        "to": to,
        "state": "listing",
        "message": "Listing conversations in the window…",
        "listed": 0,
        "total": 0,
        "done": 0,
        "fetched": 0,
        "cached": 0,
        "errors": [],
        "started_at": time.time(),
        "finished_at": None,
    }
    with _lock:
        _jobs[job["job_id"]] = job
    return job


def status(job_id):
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def latest():
    with _lock:
        if not _jobs:
            return None
        job = max(_jobs.values(), key=lambda j: j["started_at"])
        return dict(job)


def _set(job, **kwargs):
    with _lock:
        job.update(kwargs)


def start(creds, agent_id, frm_unix, to_unix, frm_label, to_label, force=False, branch_ids=None):
    """Kick off a background sync and return the job record."""
    job = _new_job(agent_id, frm_label, to_label)
    job["region"] = getattr(creds, "region", None)
    thread = threading.Thread(
        target=_run,
        args=(job, creds, agent_id, frm_unix, to_unix, frm_label, to_label, force, branch_ids),
        daemon=True,
    )
    thread.start()
    return job


def _run(job, creds, agent_id, frm_unix, to_unix, frm_label, to_label, force, branch_ids=None):
    region = getattr(creds, "region", None)
    try:
        index_rel = store.index_key(agent_id, frm_label, to_label, region)

        # ── steps 1–3: cheap calls that pin the graph ──────────────────
        _set(job, state="listing", message="Resolving agent graph…")
        agents = api.list_agents(creds)
        store.write(store.agents_key(region), agents)
        store.touch(store.agents_key(region), api_key=creds.key, api_base=creds.base, region=region)

        try:
            branches = api.get_branches(creds, agent_id)
            store.write(store.branches_key(agent_id, region), branches)
            store.touch(store.branches_key(agent_id, region), api_key=creds.key, api_base=creds.base, region=region)
        except api.ApiError as exc:
            _note(job, "branches", str(exc))

        agent = api.get_agent(creds, agent_id)
        store.write(store.agent_key(agent_id, None, None, region), agent)
        store.touch(store.agent_key(agent_id, None, None, region), api_key=creds.key, api_base=creds.base, region=region)
        _fetch_tools(job, creds, region, agent)

        # Transfer targets, transitively. Their node names and prompts are
        # needed to read a transferred conversation, and 71% of conversations on
        # a real coordinator agent touch more than one agent.
        _set(job, message="Resolving transfer targets…")
        docs, edges, dep_problems = agentgraph.walk(creds, agent_id, region)
        for problem in dep_problems:
            _note(job, problem.get("agent_id"), problem.get("error"))
        for dep_id, doc in docs.items():
            if dep_id != agent_id:
                _fetch_tools(job, creds, region, doc)
        _set(job, dependencies=[
            {"agent_id": aid, "name": (doc or {}).get("name"), "is_root": aid == agent_id}
            for aid, doc in docs.items()
        ], dependency_edges=len(edges))

        # One graph per selected branch — the node set can differ between them,
        # and costing a branch against another branch's graph is meaningless.
        for branch_id in (branch_ids or []):
            rel = store.agent_key(agent_id, None, branch_id, region)
            try:
                doc = api.get_agent(creds, agent_id, branch_id=branch_id)
                store.write(rel, doc)
                store.touch(rel, api_key=creds.key, api_base=creds.base, region=region)
                _fetch_tools(job, creds, region, doc)
            except api.ApiError as exc:
                _note(job, branch_id, str(exc))

        # ── step 4: the conversation index for the window ──────────────
        _set(job, message="Listing conversations in the window…")

        def on_page(count):
            _set(job, listed=count, message="Listed %d conversations…" % count)

        conversations, pages = api.list_conversations(
            creds, agent_id, frm_unix, to_unix, on_page=on_page
        )
        store.write(index_rel, {
            "agent_id": agent_id,
            "call_start_after_unix": int(frm_unix),
            "call_start_before_unix": int(to_unix),
            "conversations": conversations,
            "pages": pages,
        })
        store.touch(index_rel, api_key=creds.key, api_base=creds.base, region=region)

        ids = [c.get("conversation_id") for c in conversations if c.get("conversation_id")]
        _set(job, state="fetching", total=len(ids), listed=len(ids),
             message="Fetching %d conversation details…" % len(ids))

        # ── step 5: one request per conversation, cache-aware ──────────
        def fetch_one(conversation_id):
            if not force:
                cached = store.cached_conversation(conversation_id, region)
                if cached is not None:
                    with _lock:
                        job["cached"] += 1
                        job["done"] += 1
                    return
            try:
                detail = api.get_conversation(creds, conversation_id)
            except api.ApiError as exc:
                _note(job, conversation_id, "%s %s" % (exc.status, exc.message))
                with _lock:
                    job["done"] += 1
                return
            rel = store.conversation_key(conversation_id, region)
            store.write(rel, detail)
            store.touch(rel, api_key=creds.key, api_base=creds.base, region=region)
            with _lock:
                job["fetched"] += 1
                job["done"] += 1

        if ids:
            with ThreadPoolExecutor(max_workers=max(1, SYNC_WORKERS)) as pool:
                list(pool.map(fetch_one, ids))

        # Now that the transcripts are on disk, fetch any agent that actually
        # ran but that no workflow graph declares a handoff to.
        details = []
        for cid in ids:
            detail = store.read(store.conversation_key(cid, region))
            if detail is not None:
                details.append(detail)
        observed = agentgraph.agent_ids_in_transcripts(details)
        newly, obs_problems = agentgraph.fetch_missing(creds, observed, region)
        for problem in obs_problems:
            _note(job, problem.get("agent_id"), problem.get("error"))
        if newly:
            final_docs, _e, _p = agentgraph.walk(
                creds, agent_id, region, extra_roots=observed,
            )
            for dep_id, doc in final_docs.items():
                if dep_id != agent_id:
                    _fetch_tools(job, creds, region, doc)
            _set(job, dependencies=[
                {"agent_id": aid, "name": (doc or {}).get("name"), "is_root": aid == agent_id}
                for aid, doc in final_docs.items()
            ])
        _set(job, observed_agents=sorted(observed), agents_from_traffic=newly)

        store.flush()
        _set(job, state="done", finished_at=time.time(),
             message="Window cached — %d fetched, %d already immutable."
                     % (job["fetched"], job["cached"]))

    except api.ApiError as exc:
        _set(job, state="error", finished_at=time.time(),
             message="%s — %s" % (exc.status, exc.message))
    except Exception as exc:  # noqa: BLE001 - surface anything the walk hits
        _set(job, state="error", finished_at=time.time(), message=str(exc))


def _note(job, subject, message):
    with _lock:
        if len(job["errors"]) < 25:
            job["errors"].append({"subject": subject, "message": message})


def _fetch_tools(job, creds, region, agent):
    """Pull tool definitions referenced by the graph — they are real prompt tokens."""
    tool_ids = set()

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key in ("tool_ids", "additional_tool_ids") and isinstance(value, list):
                    tool_ids.update(t for t in value if isinstance(t, str))
                elif key == "tools" and isinstance(value, list):
                    for tool in value:
                        if isinstance(tool, dict) and isinstance(tool.get("tool_id"), str):
                            tool_ids.add(tool["tool_id"])
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(agent)
    for tool_id in tool_ids:
        rel = store.tool_key(tool_id, region)
        if store.exists(rel):
            continue
        try:
            store.write(rel, api.get_tool(creds, tool_id))
            store.touch(rel, api_key=creds.key, api_base=creds.base, region=region)
        except api.ApiError as exc:
            _note(job, tool_id, str(exc))
