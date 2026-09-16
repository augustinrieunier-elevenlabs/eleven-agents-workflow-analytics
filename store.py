"""Local JSON store — one file per API response, keyed by id (SPEC §0.0).

Responses are persisted verbatim. No reshaping, no field pruning, so a cached
window replays offline and a change in the frontend's maths never forces a
re-fetch.

Layout under DATA_DIR:

    {region}/agents.json                           GET /v1/convai/agents
    agents/{agent_id}.json                         GET /v1/convai/agents/{id}
    agents/{agent_id}/branches.json                GET .../branches  (results[], no versions)
    agents/{agent_id}/branches/{branch_id}.json    agent config at a branch tip
    agents/{agent_id}/versions/{version_id}.json        agent config at a version
    agents/{agent_id}/versions/{version_id}.meta.json   version metadata
    tools/{tool_id}.json
    conversations/index/{agent_id}_{from}_{to}.json paginated list, concatenated
    conversations/{conversation_id}.json            full detail
    _meta.json                                      fetch times, key fingerprint
"""

import errno
import hashlib
import json
import os
import re
import tempfile
import threading
import time

from config import DATA_DIR, MUTABLE_STATUSES, region_slug

_meta_lock = threading.Lock()
_io_lock = threading.Lock()

_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def safe(part):
    """Make one path segment safe to use as a filename."""
    return _SAFE.sub("_", str(part))[:180] or "_"


def _abs(rel):
    path = os.path.normpath(os.path.join(DATA_DIR, rel))
    root = os.path.normpath(DATA_DIR)
    if not (path == root or path.startswith(root + os.sep)):
        raise ValueError("path escapes data dir: %r" % rel)
    return path


def _ensure_parent(path):
    parent = os.path.dirname(path)
    try:
        os.makedirs(parent)
    except OSError as exc:
        if exc.errno != errno.EEXIST:
            raise


def exists(rel):
    return os.path.isfile(_abs(rel))


def read(rel, default=None):
    path = _abs(rel)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (IOError, OSError, ValueError):
        return default


def write(rel, payload):
    """Atomically persist a response verbatim."""
    path = _abs(rel)
    _ensure_parent(path)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return payload


# ── keys ───────────────────────────────────────────────────────────────
#
# Every key is namespaced by residency region. A residency environment is a
# separate account with a separate workspace, so an EU agent list and a global
# agent list are different data that must never overwrite each other on disk.

def ns(region=None):
    return region_slug(region)


def agents_key(region=None):
    return os.path.join(ns(region), "agents.json")


def agent_key(agent_id, version_id=None, branch_id=None, region=None):
    """The agent config is keyed by version, then by branch — a pinned version is
    immutable, a branch tip is not but is still worth caching per branch."""
    root = os.path.join(ns(region), "agents")
    if version_id:
        return os.path.join(root, safe(agent_id), "versions", safe(version_id) + ".json")
    if branch_id:
        return os.path.join(root, safe(agent_id), "branches", safe(branch_id) + ".json")
    return os.path.join(root, safe(agent_id) + ".json")


def version_key(agent_id, version_id, region=None):
    return os.path.join(ns(region), "agents", safe(agent_id), "versions", safe(version_id) + ".meta.json")


def branches_key(agent_id, region=None):
    return os.path.join(ns(region), "agents", safe(agent_id), "branches.json")


def tool_key(tool_id, region=None):
    return os.path.join(ns(region), "tools", safe(tool_id) + ".json")


def index_key(agent_id, frm, to, region=None):
    return os.path.join(ns(region), "conversations", "index",
                        "%s_%s_%s.json" % (safe(agent_id), safe(frm), safe(to)))


def conversation_key(conversation_id, region=None):
    return os.path.join(ns(region), "conversations", safe(conversation_id) + ".json")


# ── _meta.json ─────────────────────────────────────────────────────────

def fingerprint(api_key):
    """A fingerprint of the key, never the value (SPEC §0.0)."""
    if not api_key:
        return None
    return "sha256:" + hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]


_meta_cache = None
_meta_dirty = False
_meta_flushed_at = 0.0
FLUSH_EVERY_SECS = 2.0


def _read_meta():
    """Load the meta index once and keep it in memory.

    A cold 1,240-conversation window calls touch() 1,240 times. Re-reading and
    re-writing the whole index each time is quadratic and serialises the fetch
    workers behind file I/O, so writes are coalesced and flushed on a timer.
    """
    global _meta_cache
    if _meta_cache is None:
        meta = read("_meta.json")
        if not isinstance(meta, dict):
            meta = {}
        meta.setdefault("entries", {})
        meta.setdefault("regions", {})
        meta.setdefault("api_base", None)
        meta.setdefault("key_fingerprint", None)
        _meta_cache = meta
    return _meta_cache


def _merge_meta(disk, mine):
    """Combine another process's meta with ours, newest wins per key.

    Coalescing writes means this process holds the index in memory for seconds
    at a time. Two processes on the same store (a dev server plus a script, or
    two dev servers) would otherwise clobber each other's entries wholesale, so
    the on-disk copy is re-read and merged at every flush.
    """
    if not isinstance(disk, dict):
        return mine
    out = dict(disk)

    entries = dict(disk.get("entries") or {})
    for rel, entry in (mine.get("entries") or {}).items():
        current = entries.get(rel)
        if not current or (entry.get("fetched_at") or 0) >= (current.get("fetched_at") or 0):
            entries[rel] = entry
    out["entries"] = entries

    regions = dict(disk.get("regions") or {})
    for slug, slot in (mine.get("regions") or {}).items():
        current = regions.get(slug)
        if not current or (slot.get("fetched_at") or 0) >= (current.get("fetched_at") or 0):
            regions[slug] = slot
    out["regions"] = regions

    mine_demo = mine.get("demo")
    disk_demo = disk.get("demo")
    if mine_demo and (not disk_demo
                      or (mine_demo.get("generated_at") or 0) >= (disk_demo.get("generated_at") or 0)):
        out["demo"] = mine_demo

    for key in ("api_base", "key_fingerprint"):
        if mine.get(key) is not None:
            out[key] = mine[key]
    return out


def _flush_locked(force=False):
    global _meta_cache, _meta_dirty, _meta_flushed_at
    if not _meta_dirty:
        return
    now = time.time()
    if not force and (now - _meta_flushed_at) < FLUSH_EVERY_SECS:
        return
    merged = _merge_meta(read("_meta.json"), _meta_cache)
    write("_meta.json", merged)
    _meta_cache = merged
    _meta_dirty = False
    _meta_flushed_at = now


def meta():
    with _meta_lock:
        _flush_locked(force=True)
        return json.loads(json.dumps(_read_meta()))


def flush():
    """Force any coalesced meta writes to disk. Call at the end of a sync."""
    with _meta_lock:
        _flush_locked(force=True)


def touch(rel, api_key=None, api_base=None, source="api", region=None):
    """Record when a key was fetched, and which key and region produced it."""
    global _meta_dirty
    with _meta_lock:
        m = _read_meta()
        m["entries"][rel] = {"fetched_at": time.time(), "source": source}
        slot = m["regions"].setdefault(ns(region), {})
        slot["fetched_at"] = time.time()
        if api_key:
            slot["key_fingerprint"] = fingerprint(api_key)
            m["key_fingerprint"] = fingerprint(api_key)
        if api_base:
            slot["api_base"] = api_base
            m["api_base"] = api_base
        _meta_dirty = True
        _flush_locked()


def set_meta(**fields):
    """Set top-level meta fields (not entries) and flush."""
    global _meta_dirty
    with _meta_lock:
        m = _read_meta()
        m.update(fields)
        _meta_dirty = True
        _flush_locked(force=True)


def fetched_at(rel):
    entry = meta()["entries"].get(rel)
    return entry.get("fetched_at") if entry else None


def stale_workspace(api_key, region=None):
    """True when this region's cache was written by a different key.

    Checked per region: switching residency legitimately changes the key, and
    that is not a stale cache — it is a different workspace with its own store.
    """
    if not api_key:
        return False
    slot = meta().get("regions", {}).get(ns(region)) or {}
    fp = slot.get("key_fingerprint")
    if not fp:
        return False
    return fp != fingerprint(api_key)


# ── conversation cache policy (SPEC §0.0) ──────────────────────────────

def conversation_is_immutable(detail):
    """A conversation with status 'done' is immutable — written once."""
    if not isinstance(detail, dict):
        return False
    status = (detail.get("status") or "").lower()
    if not status:
        status = (detail.get("metadata") or {}).get("status", "") if isinstance(detail.get("metadata"), dict) else ""
        status = (status or "").lower()
    if not status:
        return False
    return status not in MUTABLE_STATUSES


def cached_conversation(conversation_id, region=None):
    """Return the cached detail only when the cache rules allow reusing it."""
    rel = conversation_key(conversation_id, region)
    detail = read(rel)
    if detail is None:
        return None
    if conversation_is_immutable(detail):
        return detail
    return None


def store_stats():
    counts = {"conversations": 0, "indexes": 0, "agents": 0, "tools": 0, "bytes": 0}
    root = os.path.normpath(DATA_DIR)
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if not name.endswith(".json"):
                continue
            full = os.path.join(dirpath, name)
            try:
                counts["bytes"] += os.path.getsize(full)
            except OSError:
                continue
            rel = os.path.relpath(full, root)
            parts = rel.split(os.sep)
            rel = os.sep.join(parts[1:]) if len(parts) > 1 else rel
            if rel.startswith("conversations" + os.sep + "index"):
                counts["indexes"] += 1
            elif rel.startswith("conversations" + os.sep):
                counts["conversations"] += 1
            elif rel.startswith("agents"):
                counts["agents"] += 1
            elif rel.startswith("tools"):
                counts["tools"] += 1
    return counts


def purge_source(source):
    """Delete exactly the files a given writer produced.

    Used to unmix demo fixtures from a real workspace cache: every write records
    its source in _meta.json, so this removes demo files without touching a
    single fetched response.
    """
    global _meta_dirty
    removed = []
    with _meta_lock:
        m = _read_meta()
        for rel, entry in list(m["entries"].items()):
            if entry.get("source") != source:
                continue
            try:
                os.unlink(_abs(rel))
            except OSError:
                pass
            m["entries"].pop(rel, None)
            removed.append(rel)
        # Drop them from the on-disk copy too, so the merge cannot bring them back.
        disk = read("_meta.json")
        if isinstance(disk, dict):
            for rel in removed:
                (disk.get("entries") or {}).pop(rel, None)
            write("_meta.json", disk)
        for slug, slot in list(m.get("regions", {}).items()):
            if slot.get("key_fingerprint") == source:
                m["regions"].pop(slug, None)
        _meta_dirty = True
        _flush_locked(force=True)

    # Drop directories the purge emptied.
    for dirpath, dirnames, filenames in os.walk(os.path.normpath(DATA_DIR), topdown=False):
        if not dirnames and not filenames and os.path.normpath(dirpath) != os.path.normpath(DATA_DIR):
            try:
                os.rmdir(dirpath)
            except OSError:
                pass
    return removed


def wipe():
    """Delete the whole store. It is a test-purpose cache — safe to drop."""
    global _meta_cache, _meta_dirty
    import shutil
    with _io_lock, _meta_lock:
        if os.path.isdir(DATA_DIR):
            shutil.rmtree(DATA_DIR)
        os.makedirs(DATA_DIR)
        _meta_cache = None
        _meta_dirty = False
