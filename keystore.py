"""Named API keys, kept in the OS keychain.

The keys themselves go into the macOS keychain via the ``security`` CLI. What is
written to disk is only an index: alias, region, a masked hint and a timestamp.
No key value is ever written to a file, returned to the browser, or logged.

Why not browser storage: ``localStorage`` is plaintext readable by any script on
the origin, persists indefinitely, rides along in profile backups and sync, and
survives long after the key should have been rotated. The keychain is the local
equivalent of a secret manager — it is encrypted at rest, gated by the login
keychain, and auditable. The UI is the same either way: pick an alias.
"""

import errno
import json
import os
import platform
import subprocess
import tempfile
import threading
import time

from config import KEYS_FILE

SERVICE = "elevenlabs-agent-cost-explorer"

_lock = threading.Lock()
# Fallback when there is no keychain: aliases live for the life of the process
# only, and the API says so, so nobody assumes they were persisted.
_memory = {}


def backend():
    """Which store is in use: 'keychain' or 'memory'."""
    if platform.system() != "Darwin":
        return "memory"
    try:
        subprocess.run(["security", "-h"], capture_output=True, timeout=5)
        return "keychain"
    except (OSError, subprocess.SubprocessError):
        return "memory"


def mask(api_key):
    if not api_key:
        return None
    if len(api_key) <= 11:
        return api_key[:3] + "••••"
    return api_key[:7] + "••••" + api_key[-4:]


# ── index (no secrets) ─────────────────────────────────────────────────

def _read_index():
    try:
        with open(KEYS_FILE, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        return payload if isinstance(payload, dict) else {}
    except (IOError, OSError, ValueError):
        return {}


def _write_index(index):
    parent = os.path.dirname(KEYS_FILE) or "."
    try:
        os.makedirs(parent)
    except OSError as exc:
        if exc.errno != errno.EEXIST:
            raise
    fd, tmp = tempfile.mkstemp(dir=parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(index, fh, indent=1, sort_keys=True)
        os.chmod(tmp, 0o600)
        os.replace(tmp, KEYS_FILE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── keychain ───────────────────────────────────────────────────────────

def _keychain_set(alias, api_key):
    # -U updates an existing item instead of failing. The value is passed with
    # -w, which keeps it out of a shell string; argv is still visible to the
    # same user on this machine, which is the same trust boundary as the app.
    result = subprocess.run(
        ["security", "add-generic-password", "-a", alias, "-s", SERVICE, "-w", api_key, "-U"],
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "keychain write failed").strip())


def _keychain_get(alias):
    result = subprocess.run(
        ["security", "find-generic-password", "-a", alias, "-s", SERVICE, "-w"],
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _keychain_delete(alias):
    subprocess.run(
        ["security", "delete-generic-password", "-a", alias, "-s", SERVICE],
        capture_output=True, text=True, timeout=15,
    )


# ── api ────────────────────────────────────────────────────────────────

def save(alias, api_key, region):
    """Store a key under an alias. Returns the index entry (no key value)."""
    alias = (alias or "").strip()
    if not alias:
        raise ValueError("alias is required")
    if len(alias) > 64:
        raise ValueError("alias must be 64 characters or fewer")
    if not api_key:
        raise ValueError("api_key is required")

    with _lock:
        if backend() == "keychain":
            _keychain_set(alias, api_key)
        else:
            _memory[alias] = api_key
        index = _read_index()
        index[alias] = {
            "region": region,
            "mask": mask(api_key),
            "saved_at": time.time(),
            "backend": backend(),
        }
        _write_index(index)
        return {"alias": alias, **index[alias]}


def load(alias):
    """Retrieve a key value. Never goes to the browser."""
    with _lock:
        if backend() == "keychain":
            value = _keychain_get(alias)
            if value:
                return value
        return _memory.get(alias)


def forget(alias):
    with _lock:
        if backend() == "keychain":
            _keychain_delete(alias)
        _memory.pop(alias, None)
        index = _read_index()
        index.pop(alias, None)
        _write_index(index)
    return True


def listing():
    """Aliases with their region and masked hint — no key values."""
    with _lock:
        index = _read_index()
        current = backend()
        out = []
        for alias, entry in sorted(index.items()):
            available = bool(_keychain_get(alias)) if current == "keychain" else alias in _memory
            out.append({
                "alias": alias,
                "region": entry.get("region"),
                "mask": entry.get("mask"),
                "saved_at": entry.get("saved_at"),
                "available": available,
            })
        return out
