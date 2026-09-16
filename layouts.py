"""Saved graph layouts — where the user dragged each node.

Deliberately NOT in ``data/``. That directory is the API response cache and is
documented as safe to delete; a hand-arranged graph is user work and must
survive wiping the cache.

One file per region + agent + branch, because the node set differs between
branches and between residency accounts.
"""

import errno
import json
import os
import re
import tempfile
import threading
import time

from config import LAYOUT_DIR, region_slug

_lock = threading.Lock()
_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def _safe(part):
    return _SAFE.sub("_", str(part))[:180] or "_"


def _path(agent_id, branch_id=None, region=None):
    name = _safe(agent_id) + ("__" + _safe(branch_id) if branch_id else "") + ".json"
    return os.path.join(LAYOUT_DIR, region_slug(region), name)


def load(agent_id, branch_id=None, region=None):
    """Layout for this exact scope, else the agent-wide one as a starting point."""
    for path in ([_path(agent_id, branch_id, region)] if branch_id else []) + [
        _path(agent_id, None, region)
    ]:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
            if isinstance(payload, dict):
                payload.setdefault("nodes", {})
                payload.setdefault("view", None)
                payload["scope"] = "branch" if branch_id and path.endswith("__%s.json" % _safe(branch_id)) else "agent"
                return payload
        except (IOError, OSError, ValueError):
            continue
    return {"nodes": {}, "view": None, "scope": None}


def save(agent_id, nodes, view=None, branch_id=None, region=None):
    """Persist positions. Only finite numeric x/y survive the round trip."""
    clean = {}
    for node_id, point in (nodes or {}).items():
        if not isinstance(point, dict):
            continue
        try:
            x = float(point.get("x"))
            y = float(point.get("y"))
        except (TypeError, ValueError):
            continue
        if x != x or y != y:          # NaN
            continue
        clean[str(node_id)[:200]] = {"x": round(x, 1), "y": round(y, 1)}

    payload = {"nodes": clean, "view": _clean_view(view), "updated_at": time.time()}
    path = _path(agent_id, branch_id, region)

    with _lock:
        parent = os.path.dirname(path)
        try:
            os.makedirs(parent)
        except OSError as exc:
            if exc.errno != errno.EEXIST:
                raise
        fd, tmp = tempfile.mkstemp(dir=parent, suffix=".tmp")
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


def _clean_view(view):
    if not isinstance(view, dict):
        return None
    try:
        zoom = float(view.get("zoom", 1))
        x = float(view.get("x", 0))
        y = float(view.get("y", 0))
    except (TypeError, ValueError):
        return None
    if zoom != zoom or x != x or y != y:
        return None
    return {"zoom": max(0.2, min(2.5, zoom)), "x": round(x, 1), "y": round(y, 1)}


def clear(agent_id, branch_id=None, region=None):
    """Drop the override so the graph falls back to the API's own positions."""
    with _lock:
        for path in {_path(agent_id, branch_id, region), _path(agent_id, None, region)}:
            try:
                os.unlink(path)
            except OSError:
                pass
    return {"nodes": {}, "view": None, "scope": None}
