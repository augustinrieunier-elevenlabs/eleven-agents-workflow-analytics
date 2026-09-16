"""Agent dependency discovery.

A workflow can hand off to another agent through a `standalone_agent` node, and
that agent can hand off again. Live traffic confirms it: on one coordinator, 71%
of conversations touch more than one agent, and one of the agents in the
transcripts is reached only by a second hop — it is not in the coordinator's own
node set at all.

So the dependency walk is transitive, cycle-guarded, and depth-limited. It runs
when the agent definition is fetched, before any conversation work, because the
node names and prompts of the whole reachable set are needed to read a single
transferred conversation.
"""

import elevenlabs_client as api
import store

MAX_DEPTH = 4
MAX_AGENTS = 40


def transfer_targets(agent_doc):
    """Agent ids this definition hands off to, with the node that does it."""
    out = []
    nodes = ((agent_doc or {}).get("workflow") or {}).get("nodes") or {}
    items = nodes.items() if isinstance(nodes, dict) else enumerate(nodes)
    for node_id, node in items:
        if not isinstance(node, dict):
            continue
        target = node.get("agent_id")
        # `agent_id` also appears on nodes that merely name their own agent, so
        # require the transfer node type rather than trusting the field alone.
        if target and node.get("type") in ("standalone_agent", "agent_transfer", "transfer_to_agent"):
            out.append({"node_id": str(node_id), "agent_id": target,
                        "label": node.get("label") or None,
                        "transfer_message": node.get("transfer_message") or None})
    return out


def agent_ids_in_transcripts(conversations):
    """Every agent that actually ran, straight from the turns.

    This is ground truth and the graph walk cannot reach it. On a real
    coordinator, 491 turns ran on an agent that no cached definition declares a
    transfer to — reached by a tool-driven or runtime handoff. Reading the
    transcripts is the only way to find it.
    """
    found = set()
    for detail in conversations or []:
        for turn in detail.get("transcript") or []:
            meta = turn.get("agent_metadata") or {}
            if meta.get("agent_id"):
                found.add(meta["agent_id"])
        if detail.get("agent_id"):
            found.add(detail["agent_id"])
    return found


def fetch_missing(creds, agent_ids, region=None):
    """Fetch and cache any of these agent definitions we do not have."""
    fetched = []
    problems = []
    for agent_id in sorted(agent_ids):
        rel = store.agent_key(agent_id, None, None, region)
        if store.read(rel) is not None:
            continue
        if not (creds and getattr(creds, "key", None)):
            problems.append({"agent_id": agent_id, "error": "no key held"})
            continue
        try:
            doc = api.get_agent(creds, agent_id)
        except api.ApiError as exc:
            problems.append({"agent_id": agent_id, "error": "%s %s" % (exc.status, exc.message)})
            continue
        store.write(rel, doc)
        store.touch(rel, api_key=creds.key, api_base=creds.base, region=region)
        fetched.append(agent_id)
    return fetched, problems


def walk(creds, root_agent_id, region=None, refresh=False, fetch=True, extra_roots=()):
    """Fetch the reachable agent set, breadth-first.

    Returns ``(docs, edges, problems)`` where ``docs`` maps agent_id -> definition
    for everything reachable (root included), ``edges`` records who hands off to
    whom, and ``problems`` lists agents that could not be fetched.
    """
    docs = {}
    edges = []
    problems = []
    depth = {root_agent_id: 0}
    queue = [root_agent_id]
    # Agents observed in traffic are roots too: a handoff that no graph declares
    # still has to be reachable, or its nodes get audited against another
    # agent's prompt.
    for extra in extra_roots or ():
        if extra and extra != root_agent_id:
            depth.setdefault(extra, 1)
            queue.append(extra)
    seen = set()

    while queue and len(docs) < MAX_AGENTS:
        agent_id = queue.pop(0)
        if agent_id in seen:
            continue
        seen.add(agent_id)

        rel = store.agent_key(agent_id, None, None, region)
        doc = store.read(rel)
        if doc is None and fetch and creds is not None and getattr(creds, "key", None):
            try:
                doc = api.get_agent(creds, agent_id)
                store.write(rel, doc)
                store.touch(rel, api_key=creds.key, api_base=creds.base, region=region)
            except api.ApiError as exc:
                problems.append({"agent_id": agent_id, "depth": depth.get(agent_id),
                                 "error": "%s %s" % (exc.status, exc.message)})
                continue
        if doc is None:
            problems.append({"agent_id": agent_id, "depth": depth.get(agent_id),
                             "error": "not cached and no key held"})
            continue

        docs[agent_id] = doc
        if depth.get(agent_id, 0) >= MAX_DEPTH:
            continue
        for link in transfer_targets(doc):
            edges.append({"from": agent_id, "to": link["agent_id"],
                          "node_id": link["node_id"], "label": link["label"]})
            if link["agent_id"] not in seen:
                depth.setdefault(link["agent_id"], depth.get(agent_id, 0) + 1)
                queue.append(link["agent_id"])

    return docs, edges, problems


def tool_ids(agent_doc):
    """Every tool id referenced anywhere in a definition."""
    found = set()

    def crawl(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key in ("tool_ids", "additional_tool_ids") and isinstance(value, list):
                    found.update(t for t in value if isinstance(t, str))
                elif key == "tools" and isinstance(value, list):
                    for tool in value:
                        if isinstance(tool, dict) and isinstance(tool.get("tool_id"), str):
                            found.add(tool["tool_id"])
                crawl(value)
        elif isinstance(node, list):
            for item in node:
                crawl(item)

    crawl(agent_doc)
    return found
