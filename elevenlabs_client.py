"""Thin ElevenLabs REST client.

Auth is the ``xi-api-key`` header on every call; read scope is enough for
everything the explorer does. The client returns parsed JSON verbatim — it is
the caller's job to persist it unchanged.
"""

import collections
import random
import threading
import time

import requests

from config import API_BASE, HTTP_TIMEOUT, MAX_RETRIES, PAGE_SIZE, region_base

_local = threading.local()

# What every call needs: the key, and which residency environment it belongs to.
# A key is only valid against its own region's host.
Creds = collections.namedtuple("Creds", "key base region")


def creds(api_key, region=None):
    return Creds(key=api_key, base=region_base(region), region=region or "global")


def _unpack(auth):
    """Accept a Creds or a bare key string (which falls back to the default base)."""
    if isinstance(auth, Creds):
        return auth.key, auth.base
    return auth, API_BASE


class ApiError(Exception):
    def __init__(self, status, message, body=None):
        super(ApiError, self).__init__(message)
        self.status = status
        self.message = message
        self.body = body


def _session():
    sess = getattr(_local, "session", None)
    if sess is None:
        sess = requests.Session()
        _local.session = sess
    return sess


def _sleep_for(attempt, response):
    if response is not None:
        retry_after = response.headers.get("retry-after")
        if retry_after:
            try:
                return min(30.0, float(retry_after))
            except ValueError:
                pass
    return min(20.0, (2 ** attempt) * 0.6 + random.random() * 0.4)


def get(path, auth, params=None):
    """GET a path under the session's residency base and return parsed JSON."""
    api_key, base = _unpack(auth)
    if not api_key:
        raise ApiError(401, "No API key held for this session.")

    url = base.rstrip("/") + path
    headers = {"xi-api-key": api_key, "accept": "application/json"}
    last = None

    for attempt in range(MAX_RETRIES):
        try:
            resp = _session().get(url, headers=headers, params=params, timeout=HTTP_TIMEOUT)
        except requests.RequestException as exc:
            last = ApiError(0, "network error: %s" % exc)
            time.sleep(_sleep_for(attempt, None))
            continue

        if resp.status_code == 200:
            try:
                return resp.json()
            except ValueError:
                raise ApiError(200, "response was not JSON", resp.text[:400])

        if resp.status_code in (429, 500, 502, 503, 504):
            last = ApiError(resp.status_code, "upstream %s" % resp.status_code, resp.text[:400])
            time.sleep(_sleep_for(attempt, resp))
            continue

        detail = resp.text[:400]
        if resp.status_code == 401:
            detail = ("key rejected by %s — needs convai_read, and a residency key is only "
                      "valid against its own region" % base)
        raise ApiError(resp.status_code, detail, resp.text[:400])

    raise last or ApiError(0, "request failed")


def post(path, auth, payload=None):
    api_key, base = _unpack(auth)
    if not api_key:
        raise ApiError(401, "No API key held for this session.")
    url = base.rstrip("/") + path
    headers = {"xi-api-key": api_key, "accept": "application/json"}
    try:
        resp = _session().post(url, headers=headers, json=payload or {}, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise ApiError(0, "network error: %s" % exc)
    if resp.status_code != 200:
        raise ApiError(resp.status_code, resp.text[:400], resp.text[:400])
    try:
        return resp.json()
    except ValueError:
        raise ApiError(200, "response was not JSON", resp.text[:400])


# ── the five calls of the retrieval pipeline (SPEC §0) ─────────────────

def list_agents(auth, page_size=100, max_pages=50):
    """Every agent, not just the first page.

    The response is ``{agents, next_cursor, has_more}``; a workspace with more
    than `page_size` agents truncates the picker unless the cursor is followed.
    Pages are concatenated into one response of the same shape.
    """
    agents = []
    cursor = None
    pages = 0
    while pages < max_pages:
        params = {"page_size": page_size}
        if cursor:
            params["cursor"] = cursor
        page = get("/v1/convai/agents", auth, params)
        agents.extend(page.get("agents") or [])
        pages += 1
        if not page.get("has_more"):
            break
        cursor = page.get("next_cursor")
        if not cursor:
            break
    return {"agents": agents, "has_more": False, "next_cursor": None}


def get_agent(auth, agent_id, version_id=None, branch_id=None):
    params = {}
    if version_id:
        params["version_id"] = version_id
    if branch_id:
        params["branch_id"] = branch_id
    return get("/v1/convai/agents/%s" % agent_id, auth, params or None)


def get_branches(auth, agent_id, include_archived=False):
    """List agent branches.

    Returns ``{results: [...], meta: {total, page, page_size}}``. Branch objects
    carry no version identifier — there is no way to enumerate versions from
    here, despite what SPEC.md §0 step 2 assumes.
    """
    return get("/v1/convai/agents/%s/branches" % agent_id, auth, {
        "limit": 100,
        "include_archived": bool(include_archived),
        "include_commit_status": True,
    })


def get_version(auth, agent_id, version_id):
    return get("/v1/convai/agents/%s/versions/%s" % (agent_id, version_id), auth)


def get_tool(auth, tool_id):
    return get("/v1/convai/tools/%s" % tool_id, auth)


def list_conversations(auth, agent_id, after_unix, before_unix, on_page=None):
    """Paginate the conversation index and return every page, concatenated.

    Returns ``(conversations, pages)`` where ``pages`` is the list of raw page
    responses so the index file can hold the responses verbatim.
    """
    conversations = []
    pages = []
    cursor = None

    while True:
        params = {
            "agent_id": agent_id,
            "page_size": PAGE_SIZE,
            "call_start_after_unix": int(after_unix),
            "call_start_before_unix": int(before_unix),
        }
        if cursor:
            params["cursor"] = cursor

        page = get("/v1/convai/conversations", auth, params)
        pages.append(page)
        batch = page.get("conversations") or []
        conversations.extend(batch)
        if on_page:
            on_page(len(conversations))

        if not page.get("has_more"):
            break
        cursor = page.get("next_cursor")
        if not cursor:
            break

    return conversations, pages


def get_conversation(auth, conversation_id):
    return get("/v1/convai/conversations/%s" % conversation_id, auth)


def validate_key(auth):
    """Cheap validation — a 401 means the key is rejected (SPEC §1)."""
    return get("/v1/convai/agents", auth, {"page_size": 1})
