"""Configuration for the Agent Cost Explorer backend.

Everything here is deployment-level wiring. No product logic: per SPEC §0.0 the
backend is a caching proxy and nothing is computed server-side.
"""

import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Local JSON store (SPEC §0.0). Test-purpose: flat files, safe to delete.
DATA_DIR = os.environ.get("ACE_DATA_DIR", os.path.join(BASE_DIR, "data"))

# Saved graph layouts. Separate from DATA_DIR on purpose: the response cache is
# disposable, a hand-arranged graph is not.
LAYOUT_DIR = os.environ.get("ACE_LAYOUT_DIR", os.path.join(BASE_DIR, "layouts"))

# Index of named API keys: alias, region, masked hint. The key VALUES live in the
# OS keychain (see keystore.py) and are never written here.
KEYS_FILE = os.environ.get("ACE_KEYS_FILE", os.path.join(BASE_DIR, ".keys.json"))

# Data residency. An isolated residency environment is a SEPARATE account with a
# SEPARATE workspace and a SEPARATE API key — a key from one region is rejected
# by the others, and the agents behind each are different. So the region is part
# of the session, and the JSON store is namespaced by it.
RESIDENCY = {
    "global": {"label": "Global (US)", "base": "https://api.elevenlabs.io"},
    "eu": {"label": "EU residency", "base": "https://api.eu.residency.elevenlabs.io"},
    "in": {"label": "India residency", "base": "https://api.in.residency.elevenlabs.io"},
    "sg": {"label": "Singapore residency", "base": "https://api.sg.residency.elevenlabs.io"},
}

DEFAULT_REGION = os.environ.get("ELEVENLABS_REGION", "global")

# Demo fixtures get their own namespace. They must never share a cache namespace
# with a real workspace: seeding demo data would pollute a real agent list, and a
# real fetch would leave orphaned fixtures behind.
DEMO_REGION = "demo"

# An explicit base overrides the region table (self-hosted, staging, a new region).
ENV_API_BASE = os.environ.get("ELEVENLABS_API_BASE")

API_BASE = ENV_API_BASE or RESIDENCY.get(DEFAULT_REGION, RESIDENCY["global"])["base"]


def region_base(region):
    """Base URL for a region slug, or the slug itself when it is a URL."""
    if not region or region == DEMO_REGION:
        return API_BASE
    if region.startswith("http://") or region.startswith("https://"):
        return region.rstrip("/")
    entry = RESIDENCY.get(region)
    return entry["base"] if entry else API_BASE


def region_slug(region):
    """Filesystem-safe namespace for a region, so regions never share a cache."""
    if not region:
        return DEFAULT_REGION
    if region == DEMO_REGION:
        return DEMO_REGION
    if region.startswith("http://") or region.startswith("https://"):
        host = region.split("://", 1)[1].split("/", 1)[0]
        return "custom_" + host.replace(":", "_").replace(".", "_")
    return region if region in RESIDENCY else DEFAULT_REGION

# Bootstrap key. Optional — the Setup screen posts one instead.
ENV_API_KEY = os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("XI_API_KEY")

# Conversation list page size (max supported by the endpoint).
PAGE_SIZE = int(os.environ.get("ACE_PAGE_SIZE", "100"))

# Parallel detail fetches during a sync. Step 5 is one request per conversation
# (SPEC §0) so this is the knob that decides how long a cold window takes.
SYNC_WORKERS = int(os.environ.get("ACE_SYNC_WORKERS", "6"))

HTTP_TIMEOUT = float(os.environ.get("ACE_HTTP_TIMEOUT", "45"))
MAX_RETRIES = int(os.environ.get("ACE_MAX_RETRIES", "4"))

SECRET_KEY = os.environ.get("ACE_SECRET_KEY", "dev-only-not-a-secret")

# Statuses that mean a conversation is still mutable and must be re-fetched.
MUTABLE_STATUSES = {"initiated", "in-progress", "in_progress", "processing"}
