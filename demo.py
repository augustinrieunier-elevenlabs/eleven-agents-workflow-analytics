"""Deterministic demo fixtures, written in the shape the real API returns.

The point is not to fake the product: it is to fill the JSON store with
responses that have the same field names and nesting as ElevenLabs returns, so
the frontend's derivation — node attribution, pricing, cache accounting, the
reconciliation check — runs against the same code paths it will run against a
live workspace. Delete ``data/`` to drop it.
"""

import random
import time

import store
from config import DEMO_REGION

DEMO_FINGERPRINT = "demo"

# Per-1M-token list prices, as the API reports them per conversation.
# in, out, cache-read multiplier, cache-write multiplier
MODELS = {
    "gemini-2.0-flash": (0.10, 0.40, 0.25, 1.00),
    "gpt-4o-mini": (0.15, 0.60, 0.50, 1.00),
    "gpt-4o": (2.50, 10.00, 0.50, 1.00),
    "claude-sonnet-4": (3.00, 15.00, 0.10, 1.25),
    "text-embedding-3-small": (0.02, 0.00, 1.00, 1.00),
}

# Text that deliberately appears in more than one node prompt, so the
# duplicate-block detector on the Prompts screen has something real to find.
BRAND_BLOCK = (
    "## Tone and refusals\n"
    "Speak as {{company}} support: warm, concrete, never chatty. One idea per sentence.\n"
    "Never invent policy, pricing, or delivery dates. If you are not certain, say so and offer\n"
    "to check. Refuse requests for another customer's data outright, and do not repeat account\n"
    "numbers back in full. Never promise a refund you have not confirmed in the billing system."
)

VERIFY_BLOCK = (
    "## Account verification policy\n"
    "Before any account action, confirm the last four digits of the card on file and the billing\n"
    "postcode. Two failed attempts ends verification: offer a callback to the number on the\n"
    "account instead. Verification is valid for the remainder of the call only. A caller who\n"
    "cannot verify may still receive general product help, never account specifics, never an\n"
    "invoice copy, and never a plan change. Log every verification outcome to the case record\n"
    "with the reason code, because the audit export reads that field and not the transcript."
)

ESCALATION_BLOCK = (
    "## Escalation criteria\n"
    "Escalate to a human when: the caller asks twice for a person; the fault is a hardware RMA;\n"
    "the account is flagged for churn risk; the caller is distressed; or a regulated complaint is\n"
    "raised. Do not escalate for password resets, invoice copies, or plan comparisons — those are\n"
    "in scope here and an escalation on them is counted as a deflection failure in the weekly\n"
    "review, so resolve them in the flow even when the caller sounds impatient."
)

FEWSHOT = "\n".join(
    "## Few-shot examples\n"
    + "\n".join(
        'Caller: "%s"\n-> {"intent": "%s", "confidence": %.2f}\n' % (utterance, intent, conf)
        for utterance, intent, conf in [
            ("My bill went up and nobody told me", "billing", 0.94),
            ("The box has a red light and no internet", "technical", 0.96),
            ("I want to cancel, put me through to someone", "escalate", 0.91),
            ("Can you send me last month's invoice", "billing", 0.97),
            ("Wi-fi drops every evening around eight", "technical", 0.93),
            ("This is the third time I have called about this", "escalate", 0.88),
            ("Why am I being charged for a second line", "billing", 0.92),
            ("The app says my device is offline but it is on", "technical", 0.90),
            ("I need to speak to a manager about a complaint", "escalate", 0.95),
            ("What plans do you have with more data", "billing", 0.71),
            ("My call quality is terrible on mobile", "technical", 0.89),
            ("Cancel my account today please", "escalate", 0.93),
            ("Is my direct debit going out on the first", "billing", 0.90),
            ("Router keeps rebooting by itself", "technical", 0.94),
        ]
    ).rstrip()
    for _ in [0]
)

BILLING_POLICY = (
    "## Billing policy\n"
    "Invoices are issued on the first of the month and cover the month ahead. A mid-cycle seat\n"
    "addition is pro-rated to the day and appears as a separate line on the next invoice, which\n"
    "is the single most common cause of an unexpected increase — check for it before anything\n"
    "else. Refunds are available within 14 days of the charge for unused seats only; usage-based\n"
    "charges are never refundable once the usage is metered. A plan downgrade takes effect at the\n"
    "start of the next cycle and never refunds the current one. A plan upgrade takes effect\n"
    "immediately and is pro-rated. Failed payments retry on day 3 and day 7, then suspend on day\n"
    "10; a suspended account is restored within ten minutes of a successful payment. Dunning\n"
    "emails go to the billing contact only, which is frequently not the caller, so confirm which\n"
    "address the caller is checking before telling them an email was sent. VAT is applied on the\n"
    "billing country, not the card country. Purchase-order customers are invoiced on net-30 terms\n"
    "and do not see card charges at all; if the caller mentions a PO number, hand to the finance\n"
    "queue rather than explaining card behaviour. Credit notes appear within one business day.\n"
    "Annual plans renew automatically with a reminder 30 days out; the reminder is not a\n"
    "cancellation window in every jurisdiction, so never state a universal right to cancel.\n"
    "Currency is set at signup and cannot be changed without a new subscription. Discounts stack\n"
    "only when one is a percentage and the other a fixed credit, never two percentages."
)

TROUBLESHOOT = (
    "## Troubleshooting tree\n"
    "Start with reachability: is the device powered, and does the status light show steady white?\n"
    "A red light means no upstream signal, an amber light means it is negotiating, and a blinking\n"
    "white light means a firmware update is in progress — never ask a caller to power-cycle a\n"
    "device that is mid-update, it is the most common cause of a bricked unit and an RMA.\n"
    "If the light is steady white and the caller still has no service, check whether the fault is\n"
    "local or area-wide before anything else; an area outage makes every other step noise. For a\n"
    "local fault, work outward: one device or all devices, wired or wireless, one app or all\n"
    "traffic. Evening-only slowdowns on wireless are almost always channel congestion rather than\n"
    "line capacity, so move the 2.4GHz band before escalating a speed complaint. Intermittent\n"
    "drops with a healthy line point at power: a failing PSU drops the unit for seconds at a time\n"
    "and looks exactly like a line fault in the caller's description. Ask when it started and\n"
    "what changed that week, because a new device, a new wall, or a new neighbour explains most\n"
    "sudden degradations. Escalate to a hardware RMA only after a factory reset has been tried\n"
    "and the fault survives it, and record the pre-reset symptom because the depot needs it."
)


def _prompt(*blocks):
    return "\n\n".join(b for b in blocks if b)


NODES = [
    {
        "id": "start", "label": "Inbound call", "type": "start", "model": None,
        "x": 24, "y": 236, "hit": 1.00, "tin": 0, "tout": 0, "cache": 0.0, "lat": (0, 0),
        "prompt": None,
    },
    {
        "id": "greet", "label": "Greeting + language", "type": "override_agent",
        "model": "gemini-2.0-flash", "x": 228, "y": 236, "hit": 1.00,
        "tin": 412, "tout": 68, "cache": 0.35, "lat": (0.34, 0.61),
        "vars": ["company", "caller_locale", "caller_tier"],
        "tools": [],
        "prompt": _prompt(
            "You are the front door for {{company}} support. The caller's locale is\n"
            "{{caller_locale}} and their plan tier is {{caller_tier}}.\n"
            "Greet in the caller's language, detected from their first utterance. Do not answer\n"
            "questions here — capture the intent in one sentence and hand off.",
            BRAND_BLOCK,
        ),
    },
    {
        "id": "router", "label": "Intent router", "type": "override_agent",
        "model": "gpt-4o-mini", "x": 432, "y": 236, "hit": 1.00,
        "tin": 1180, "tout": 42, "cache": 0.64, "lat": (0.41, 0.88),
        "vars": ["intent_hint"],
        "tools": [],
        "prompt": _prompt(
            "Classify the captured intent into exactly one of: billing, technical, escalate.\n"
            "Return JSON only, no prose. A hint may be supplied as {{intent_hint}}; treat it as\n"
            "weak evidence, never as the answer.",
            FEWSHOT,
        ),
    },
    {
        "id": "billing", "label": "Billing sub-agent", "type": "override_agent",
        "model": "claude-sonnet-4", "x": 656, "y": 76, "hit": 0.32,
        "tin": 4820, "tout": 310, "cache": 0.82, "lat": (0.98, 2.10),
        "vars": ["company", "account_id", "plan", "last4"],
        "tools": ["tool_get_invoice"],
        "prompt": _prompt(
            "You handle invoices, refunds and plan changes for {{company}}. The account is\n"
            "{{account_id}} on the {{plan}} plan, card ending {{last4}}.",
            BILLING_POLICY,
            VERIFY_BLOCK,
            BRAND_BLOCK,
        ),
    },
    {
        "id": "invoice", "label": "get_invoice", "type": "tool", "model": None,
        "x": 872, "y": 76, "hit": 0.30, "tin": 0, "tout": 0, "cache": 0.0, "lat": (0.62, 1.45),
        "tools": ["tool_get_invoice"], "prompt": None,
    },
    {
        "id": "tech", "label": "Tech support sub-agent", "type": "override_agent",
        "model": "gpt-4o", "x": 656, "y": 236, "hit": 0.49,
        "tin": 3940, "tout": 288, "cache": 0.78, "lat": (0.87, 1.98),
        "vars": ["device_model", "firmware"],
        "tools": ["tool_kb_search"],
        "prompt": _prompt(
            "Diagnose device and connectivity faults for a {{device_model}} on firmware\n"
            "{{firmware}}. Ask at most two clarifying questions before searching the knowledge\n"
            "base.",
            TROUBLESHOOT,
            ESCALATION_BLOCK,
            BRAND_BLOCK,
        ),
    },
    {
        "id": "kb", "label": "kb_search", "type": "tool", "model": "text-embedding-3-small",
        "x": 872, "y": 236, "hit": 0.61, "tin": 1850, "tout": 0, "cache": 0.05, "lat": (0.24, 0.52),
        "tools": ["tool_kb_search"], "prompt": None, "rag": True,
    },
    {
        "id": "triage", "label": "Escalation triage", "type": "override_agent",
        "model": "gpt-4o-mini", "x": 656, "y": 396, "hit": 0.19,
        "tin": 1420, "tout": 96, "cache": 0.41, "lat": (0.38, 0.74),
        "vars": ["queue", "sla_tier"],
        "tools": ["tool_transfer_to_human"],
        "prompt": _prompt(
            "Decide: human transfer, callback, or return to the flow. The receiving queue is\n"
            "{{queue}} at SLA tier {{sla_tier}}. Summarise the case in 60 words or fewer for the\n"
            "receiving agent.",
            ESCALATION_BLOCK,
            VERIFY_BLOCK,
        ),
    },
    {
        "id": "human", "label": "transfer_to_human", "type": "tool", "model": None,
        "x": 872, "y": 396, "hit": 0.15, "tin": 0, "tout": 0, "cache": 0.0, "lat": (0.11, 0.30),
        "tools": ["tool_transfer_to_human"], "prompt": None,
    },
    {
        "id": "wrap", "label": "Wrap-up + CSAT", "type": "override_agent",
        "model": "gemini-2.0-flash", "x": 1080, "y": 236, "hit": 0.85,
        "tin": 2260, "tout": 180, "cache": 0.12, "lat": (0.30, 0.56),
        "vars": ["company", "csat_survey_id"],
        "tools": [],
        "prompt": _prompt(
            "Close the call for {{company}}: confirm the resolution in one sentence, offer the\n"
            "CSAT prompt {{csat_survey_id}}, then end. You receive the full conversation as\n"
            "context, so keep your own output short.",
            BRAND_BLOCK,
        ),
    },
]

EDGES = [
    ("start", "greet", "unconditional", None),
    ("greet", "router", "unconditional", None),
    ("router", "billing", "llm", "caller is asking about an invoice, payment or plan"),
    ("router", "tech", "llm", "caller reports a fault with a device or connection"),
    # Declared but unused in this window — a direct escalation path nobody took.
    ("router", "triage", "llm", "caller asks for a person or raises a complaint"),
    ("billing", "invoice", "result", None),
    ("billing", "wrap", "unconditional", None),
    ("invoice", "wrap", "result", None),
    ("invoice", "billing", "result_failure", None),
    ("tech", "kb", "result", None),
    ("kb", "wrap", "expression", "fault_resolved == true"),
    ("kb", "triage", "llm", "the knowledge base did not resolve the fault"),
    ("triage", "human", "result", None),
]

PATHS = [
    (["start", "greet", "router", "billing", "invoice", "wrap"], "success", "resolved", 0.26),
    (["start", "greet", "router", "tech", "kb", "wrap"], "success", "resolved", 0.30),
    (["start", "greet", "router", "tech", "kb", "triage", "human"], "unknown", "transferred", 0.13),
    (["start", "greet", "router", "billing", "wrap"], "success", "resolved", 0.12),
    (["start", "greet", "router"], "failure", "abandoned", 0.07),
    (["start", "greet", "router", "tech", "kb", "kb", "wrap"], "success", "resolved", 0.12),
]

TOOLS = {
    "tool_get_invoice": {
        "name": "get_invoice",
        "description": "Fetch a rendered invoice PDF and its line items for one billing period.",
        "properties": {
            "account_id": ("string", "Internal account identifier, not the customer-facing number."),
            "period": ("string", "Billing period as YYYY-MM."),
            "include_line_items": ("boolean", "Return the itemised breakdown as well as the total."),
            "format": ("string", "One of pdf, json. Defaults to json for in-call use."),
        },
        "required": ["account_id", "period"],
    },
    "tool_kb_search": {
        "name": "kb_search",
        "description": "Semantic search over the help centre. Returns reranked chunks appended to the caller's context.",
        "properties": {
            "query": ("string", "Natural-language question, rewritten from the caller's words."),
            "top_k": ("integer", "Chunks to retrieve before reranking. Default 6."),
            "product_area": ("string", "Optional filter: billing, connectivity, hardware, account."),
        },
        "required": ["query"],
    },
    "tool_transfer_to_human": {
        "name": "transfer_to_human",
        "description": "Native transfer. Passes the triage summary as the screen-pop payload.",
        "properties": {
            "queue": ("string", "Destination queue name."),
            "summary": ("string", "Case summary for the receiving agent, 60 words or fewer."),
            "sla_tier": ("string", "One of standard, priority, regulated."),
        },
        "required": ["queue", "summary"],
    },
}

# Each agent runs one or more branches. "versions" are the seq numbers committed
# on that branch, newest first — the shape `most_recent_versions` comes back in.
AGENTS = [
    {
        "agent_id": "agent_7hq2", "name": "Support — EU inbound",
        "branches": [
            {"id": "main", "name": "main", "is_default": True, "versions": [14, 13, 11], "share": 0.78},
            {"id": "br_shortprompt", "name": "shorter-billing-prompt", "is_default": False,
             "versions": [4, 3], "share": 0.22},
        ],
    },
    {
        "agent_id": "agent_2bk9", "name": "Outbound renewals",
        "branches": [{"id": "main", "name": "main", "is_default": True, "versions": [6, 5], "share": 1.0}],
    },
    {
        "agent_id": "agent_9xm1", "name": "Voice IVR replacement",
        "branches": [
            {"id": "main", "name": "main", "is_default": True, "versions": [31, 30, 28], "share": 1.0},
        ],
    },
]

PRIMARY_AGENT = "agent_7hq2"


def _branches_of(agent_id):
    return next(a for a in AGENTS if a["agent_id"] == agent_id)["branches"]


def _default_branch(agent_id):
    branches = _branches_of(agent_id)
    return next((b for b in branches if b.get("is_default")), branches[0])

LINES = {
    "greet": [
        ("user", "Hi, yes — I'm calling about my account."),
        ("agent", "Hello, you're through to {{company}} support. What can I help with today?"),
    ],
    "router": [
        ("user", "My bill this month looks about forty euros higher than usual."),
        ("agent", "Understood — let me pull up the billing side of your account."),
    ],
    "billing": [
        ("agent", "I can check that. Can you confirm the last four digits of the card on file?"),
        ("user", "Sure, it's 4412."),
    ],
    "invoice": [("agent", "Thanks — pulling the itemised invoice for this period now.")],
    "tech": [
        ("agent", "Let's narrow it down. Is the status light steady white, amber, or red?"),
        ("user", "It's amber, and it has been all evening."),
    ],
    "kb": [("agent", "Checking the help centre for amber-light faults on your model.")],
    "triage": [
        ("agent", "I'd like to get a specialist onto this. May I transfer you?"),
        ("user", "Yes, please — I've called about this before."),
    ],
    "human": [("agent", "Connecting you now, and passing on a summary so you don't repeat yourself.")],
    "wrap": [
        ("agent", "So that's the pro-rated seat added on the 3rd — I've sent the itemised invoice. Anything else?"),
        ("user", "No, that explains it. Thanks."),
    ],
}


def _model_usage(model, input_tokens, cached_tokens, output_tokens, cache_write=0):
    """One ``model_usage`` entry.

    ``price`` is the ABSOLUTE dollar cost for those tokens, exactly as the live
    API reports it — not a per-1M rate. The rates in MODELS are only used here to
    compute that cost.
    """
    p_in, p_out, cr_mult, cw_mult = MODELS[model]
    fresh = max(0, input_tokens - cached_tokens)
    cost = lambda tokens, rate: round(tokens / 1e6 * rate, 10)
    entry = {
        "input": {"tokens": fresh, "price": cost(fresh, p_in)},
        "input_cache_read": {"tokens": cached_tokens, "price": cost(cached_tokens, p_in * cr_mult)},
        "input_cache_write": {"tokens": cache_write, "price": cost(cache_write, p_in * cw_mult)},
        "output_total": {"tokens": output_tokens, "price": cost(output_tokens, p_out)},
    }
    return {model: entry}


def _merge_usage(total, usage):
    for model, entry in usage.items():
        bucket = total.setdefault(model, {})
        for unit, value in entry.items():
            slot = bucket.setdefault(unit, {"tokens": 0, "price": 0.0})
            slot["tokens"] += value["tokens"]
            slot["price"] += value["price"]          # absolute cost accumulates
    return total


def _node_by_id():
    return {n["id"]: n for n in NODES}


def _tool_schema(tool_id):
    spec = TOOLS[tool_id]
    return {
        "id": tool_id,
        "tool_config": {
            "type": "webhook",
            "name": spec["name"],
            "description": spec["description"],
            "response_timeout_secs": 2,
            "api_schema": {
                "url": "https://api.internal.example/%s" % spec["name"],
                "method": "POST",
                "request_body_schema": {
                    "type": "object",
                    "required": spec["required"],
                    "properties": {
                        key: {"type": kind, "description": desc}
                        for key, (kind, desc) in spec["properties"].items()
                    },
                },
            },
        },
    }


def _workflow():
    nodes = {}
    for node in NODES:
        entry = {
            "type": node["type"],
            "label": node["label"],
            "position": {"x": node["x"], "y": node["y"]},
        }
        if node["type"] == "tool":
            entry["tools"] = [{"tool_id": t} for t in node.get("tools", [])]
        if node.get("prompt"):
            entry["additional_prompt"] = node["prompt"]
            entry["additional_tool_ids"] = node.get("tools", [])
            entry["conversation_config"] = {
                "agent": {"prompt": {"llm": node["model"], "prompt": node["prompt"]}}
            }
        nodes[node["id"]] = entry

    edges = {}
    for i, (src, dst, kind, label) in enumerate(EDGES):
        cond = {"type": "unconditional"}
        if kind == "llm":
            cond = {"type": "llm", "label": label}
        elif kind == "expression":
            cond = {"type": "expression", "expression": label}
        elif kind.startswith("result"):
            cond = {"type": "result", "outcome": "failure" if kind.endswith("failure") else "success"}
        edges["edge_%02d" % i] = {"source": src, "target": dst, "forward_condition": cond}

    return {"nodes": nodes, "edges": edges, "subgraphs": {}}


def _version_id(agent_id, branch_id, seq):
    return "ver_%s_%s_%d" % (agent_id, branch_id, seq)


def _agent_doc(agent, branch, version_seq):
    root_prompt = _prompt(
        "You are the {{company}} voice support agent. Keep turns under two sentences unless the\n"
        "caller asks for detail. You are on a phone call: never read out URLs, IDs, or JSON.",
        BRAND_BLOCK,
    )
    doc = {
        "agent_id": agent["agent_id"],
        "name": agent["name"],
        "version_id": _version_id(agent["agent_id"], branch["id"], version_seq),
        "branch_id": branch["id"],
        "conversation_config": {
            "agent": {
                "prompt": {
                    "prompt": root_prompt,
                    "llm": "gemini-2.0-flash",
                    "temperature": 0.2,
                    "tool_ids": sorted(TOOLS),
                },
                "first_message": "Hello, you're through to support. What can I help with today?",
                "language": "en",
            },
            "tts": {"model_id": "eleven_turbo_v2_5", "voice_id": "voice_demo"},
        },
        "platform_settings": {"workspace_overrides": {}},
        "metadata": {"created_at_unix_secs": int(time.time()) - 86400 * 210},
    }
    if agent["agent_id"] == PRIMARY_AGENT:
        doc["workflow"] = _workflow()
    else:
        doc["workflow"] = {"nodes": {}, "edges": {}, "subgraphs": {}}
    return doc


def _branches(agent):
    """The branches response, in the shape the real API returns.

    ``GET /v1/convai/agents/{id}/branches`` -> ``{results: [...], meta: {...}}``.
    Branch objects carry NO version identifier: versions are not enumerable from
    here, which is why the app discovers them from the conversations instead.
    """
    now = int(time.time())
    results = []
    for i, branch in enumerate(agent["branches"]):
        results.append({
            "id": branch["id"],
            "name": branch["name"],
            "agent_id": agent["agent_id"],
            "description": branch.get("description", "The default branch for your agent."),
            "created_at": now - 86400 * (120 - i * 30),
            "last_committed_at": now - 86400 * (5 + i * 9),
            "is_archived": False,
            "protection_status": "writer_perms_required",
            "access_info": {
                "is_creator": True,
                "creator_name": "demo@example.com",
                "creator_email": "demo@example.com",
                "role": "admin",
                "anonymous_access_level_override": None,
                "access_source": "creator",
            },
            "current_live_percentage": round(branch.get("share", 0.0) * 100, 1),
            "parent_branch_id": None if branch.get("is_default") else agent["branches"][0]["id"],
            "draft_exists": False,
            "draft_created_at": None,
            "draft_is_behind_tip": False,
            "calls_7d": int(branch.get("share", 0.0) * 300),
            "commits_ahead": None if branch.get("is_default") else len(branch["versions"]),
            "commits_behind": None,
            "merged_into_branch_id": None,
        })
    return {"results": results, "meta": {"total": len(results), "page": 1, "page_size": len(results)}}


def _version_doc(agent_id, branch, seq, i):
    """GET /v1/convai/agents/{id}/versions/{version_id} — this endpoint does exist."""
    now = int(time.time())
    return {
        "id": _version_id(agent_id, branch["id"], seq),
        "agent_id": agent_id,
        "branch_id": branch["id"],
        "version_description": ["current", "previous", "older"][min(i, 2)] + " commit",
        "seq_no_in_branch": seq,
        "time_committed_secs": now - 86400 * (5 + i * 18),
        "parents": {
            "in_branch_parent_id": (
                _version_id(agent_id, branch["id"], branch["versions"][i + 1])
                if i + 1 < len(branch["versions"]) else None
            ),
            "out_of_branch_parent_id": None,
        },
        "access_info": {"is_creator": True, "creator_email": "demo@example.com", "role": "admin"},
    }


def _weighted_branch(rnd, branches):
    roll = rnd.random()
    cumulative = 0.0
    for branch in branches:
        cumulative += branch.get("share", 1.0 / len(branches))
        if roll <= cumulative:
            return branch
    return branches[-1]


def _pick_path(rnd):
    roll = rnd.random()
    cumulative = 0.0
    for path, successful, outcome, weight in PATHS:
        cumulative += weight
        if roll <= cumulative:
            return path, successful, outcome
    return PATHS[-1][0], PATHS[-1][1], PATHS[-1][2]


def generate(agent_id=PRIMARY_AGENT, days=14, per_day=44, end_unix=None, seed=90210,
             region=DEMO_REGION):
    """Write a full demo window into the JSON store and return its descriptor."""
    rnd = random.Random(seed)
    nodes = _node_by_id()
    end_unix = int(end_unix or time.time())
    end_day = end_unix - (end_unix % 86400)
    start_day = end_day - (days - 1) * 86400

    # steps 1–3
    store.write(store.agents_key(region), {
        "agents": [
            {
                "agent_id": a["agent_id"],
                "name": a["name"],
                "created_at_unix_secs": int(time.time()) - 86400 * 210,
                "access_info": {"role": "admin", "creator_email": "demo@example.com"},
                "tags": [],
            }
            for a in AGENTS
        ],
        "has_more": False,
        "next_cursor": None,
    })
    store.touch(store.agents_key(region), source="demo", region=region)

    for agent in AGENTS:
        default_branch = _default_branch(agent["agent_id"])
        doc = _agent_doc(agent, default_branch, default_branch["versions"][0])
        store.write(store.agent_key(agent["agent_id"], None, None, region), doc)
        store.touch(store.agent_key(agent["agent_id"], None, None, region), source="demo", region=region)
        store.write(store.branches_key(agent["agent_id"], region), _branches(agent))
        store.touch(store.branches_key(agent["agent_id"], region), source="demo", region=region)
        for branch in agent["branches"]:
            branch_rel = store.agent_key(agent["agent_id"], None, branch["id"], region)
            store.write(branch_rel, _agent_doc(agent, branch, branch["versions"][0]))
            store.touch(branch_rel, source="demo", region=region)
            for i, seq in enumerate(branch["versions"]):
                version_id = _version_id(agent["agent_id"], branch["id"], seq)
                store.write(store.agent_key(agent["agent_id"], version_id, None, region),
                            _agent_doc(agent, branch, seq))
                store.touch(store.agent_key(agent["agent_id"], version_id, None, region), source="demo", region=region)
                store.write(store.version_key(agent["agent_id"], version_id, region),
                            _version_doc(agent["agent_id"], branch, seq, i))
                store.touch(store.version_key(agent["agent_id"], version_id, region), source="demo", region=region)

    for tool_id in TOOLS:
        store.write(store.tool_key(tool_id, region), _tool_schema(tool_id))
        store.touch(store.tool_key(tool_id, region), source="demo", region=region)

    branches = _branches_of(agent_id)
    default_branch = _default_branch(agent_id)
    pinned_version = _version_id(agent_id, default_branch["id"], default_branch["versions"][0])

    summaries = []
    index = 0
    for day in range(days):
        day_start = start_day + day * 86400
        weekday = time.gmtime(day_start).tm_wday
        volume = per_day * (0.42 if weekday >= 5 else 1.0)
        count = max(1, int(round(volume * (0.78 + rnd.random() * 0.44))))
        for _ in range(count):
            index += 1
            # Traffic is split across the agent's branches by their share, so the
            # branch picker on the Setup screen has something real to narrow.
            branch = _weighted_branch(rnd, branches)
            version_id = _version_id(agent_id, branch["id"], branch["versions"][0])
            summary, detail = _conversation(
                rnd, nodes, agent_id, branch, version_id, day_start, index)
            store.write(store.conversation_key(detail["conversation_id"], region), detail)
            summaries.append(summary)

    summaries.sort(key=lambda c: c["start_time_unix_secs"], reverse=True)
    frm_label = time.strftime("%Y-%m-%d", time.gmtime(start_day))
    to_label = time.strftime("%Y-%m-%d", time.gmtime(end_day))
    index_rel = store.index_key(agent_id, frm_label, to_label, region)
    store.write(index_rel, {
        "agent_id": agent_id,
        "call_start_after_unix": start_day,
        "call_start_before_unix": end_day + 86399,
        "conversations": summaries,
        "pages": [{"conversations": summaries, "has_more": False, "next_cursor": None}],
    })
    store.touch(index_rel, source="demo", region=region)

    meta = store.meta()
    regions = meta.get("regions", {})
    regions[store.ns(region)] = {"key_fingerprint": DEMO_FINGERPRINT,
                                 "api_base": "demo", "fetched_at": time.time()}
    store.set_meta(
        key_fingerprint=DEMO_FINGERPRINT,
        regions=regions,
        demo={"agent_id": agent_id, "from": frm_label, "to": to_label, "region": region,
              "conversations": len(summaries), "generated_at": time.time()},
    )

    return {"agent_id": agent_id, "version_id": pinned_version, "from": frm_label,
            "to": to_label, "conversations": len(summaries), "region": store.ns(region)}


def _conversation(rnd, nodes, agent_id, branch, version_id, day_start, index):
    path, successful, outcome = _pick_path(rnd)
    hour = 8 + int(rnd.random() * 11)
    minute = int(rnd.random() * 60)
    started = day_start + hour * 3600 + minute * 60
    conversation_id = "conv_%s%04d" % (format(abs(hash((day_start, index))) % 0xFFFFFF, "06x"), index)

    jitter = 0.7 + rnd.random() * 0.8
    transcript = []
    turn_total = {}
    t = 0
    step = 0

    for node_id in path:
        node = nodes[node_id]
        step += 1
        history_growth = 1 + (step - 1) * 0.08
        meta_block = {
            "agent_id": agent_id,
            "workflow_node_id": node_id,
            "branch_id": branch["id"],
            "version_id": version_id,
        }

        for role, text in LINES.get(node_id, [("agent", "…")]):
            t += 2 + int(rnd.random() * 8)
            turn = {
                "role": role,
                "message": text,
                "time_in_call_secs": t,
                "agent_metadata": dict(meta_block),
                "interrupted": role == "agent" and rnd.random() < 0.06,
                "ignored_as_backchannel": role == "user" and rnd.random() < 0.05,
                "triggered_guardrails": None,
                "reasoned": False,
                "llm_usage": None,
                "conversation_turn_metrics": None,
                "tool_calls": [],
                "tool_results": [],
            }

            if role == "agent" and node["model"]:
                tin = int(node["tin"] * jitter * history_growth)
                tout = int(node["tout"] * jitter)
                cached = int(tin * node["cache"] * (0.85 + rnd.random() * 0.3))
                cached = min(cached, tin)
                write_tokens = int(tin * 0.04) if node["cache"] > 0.2 and step <= 2 else 0
                usage = _model_usage(node["model"], tin, cached, tout, write_tokens)
                turn["llm_usage"] = {"model_usage": usage}
                turn["producing_llm"] = node["model"]
                turn["llm_override"] = node["model"] if node["model"] != "gemini-2.0-flash" else None
                p50, p95 = node["lat"]
                turn["conversation_turn_metrics"] = {
                    "metrics": {
                        "convai_llm_service_ttf_sentence": {
                            "elapsed_time": round(p50 * (0.7 + rnd.random() * 0.9), 3)
                        },
                        "convai_llm_service_ttfb": {
                            "elapsed_time": round(p50 * 0.55 * (0.7 + rnd.random() * 0.8), 3)
                        },
                    }
                }
                _merge_usage(turn_total, usage)

            if node["type"] == "tool" and role == "agent":
                tool_id = (node.get("tools") or [None])[0]
                if tool_id:
                    ok = rnd.random() > (0.11 if node_id == "invoice" else 0.03)
                    turn["tool_calls"] = [{
                        "tool_name": TOOLS[tool_id]["name"],
                        "tool_id": tool_id,
                        "params_as_json": "{}",
                        "request_id": "req_%06x" % (rnd.getrandbits(24)),
                    }]
                    turn["tool_results"] = [{
                        "tool_name": TOOLS[tool_id]["name"],
                        "is_error": not ok,
                        "result_value": "ok" if ok else "upstream timeout after 1.8s",
                        "tool_latency_secs": round(node["lat"][0] * (0.8 + rnd.random()), 3),
                    }]

            if node.get("rag") and role == "agent":
                chunks = 3
                turn["rag_retrieval_info"] = {
                    "chunks": [
                        {
                            "document_id": "kb_doc_%03d" % int(rnd.random() * 400),
                            "chunk_id": "chunk_%04d" % int(rnd.random() * 9000),
                            "vector_distance": round(0.1 + rnd.random() * 0.3, 4),
                        }
                        for _ in range(chunks)
                    ],
                    "rag_latency_secs": round(0.12 + rnd.random() * 0.2, 3),
                    "retrieved_tokens": int(1560 * jitter),
                }
                turn["used_static_kb_document_ids"] = ["kb_doc_core_faq"]

            transcript.append(turn)

    duration = max(35, t + int(rnd.random() * 30))

    # metadata.charging is the billed truth. It reports cache splits its own way,
    # so it drifts slightly from the per-turn sum — that drift is what the
    # reconciliation strip on the Workflow screen surfaces rather than hides.
    # irreversible_generation = the generations that completed; this is what the
    # per-turn usage sums to. initiated_generation additionally covers ones that
    # were started and abandoned (interruptions), and is what llm_price bills.
    irreversible = {
        model: {unit: dict(slot) for unit, slot in units.items()}
        for model, units in turn_total.items()
    }
    started_extra = 1.0 + rnd.random() * 0.45
    initiated = {}
    for model, units in turn_total.items():
        initiated[model] = {
            unit: {"tokens": int(round(slot["tokens"] * started_extra)),
                   "price": round(slot["price"] * started_extra, 10)}
            for unit, slot in units.items()
        }

    llm_cost = 0.0
    for units in initiated.values():
        for slot in units.values():
            llm_cost += slot["price"]

    analysis_cost = round(0.00042 + rnd.random() * 0.0004, 8)
    detail = {
        "conversation_id": conversation_id,
        "agent_id": agent_id,
        "version_id": version_id,
        "branch_id": branch["id"],
        "status": "done",
        "user_id": None,
        "transcript": transcript,
        "metadata": {
            "start_time_unix_secs": started,
            "call_duration_secs": duration,
            "queue_wait_secs": int(rnd.random() * 4),
            "accepted_time_unix_secs": started,
            "timezone": "Europe/London",
            "main_language": "en",
            "termination_reason": "caller hung up" if outcome != "transferred" else "transferred to human",
            "cost": int(llm_cost * 1e5),
            "cost_fiat": round(llm_cost + analysis_cost + duration / 60.0 * 0.08, 8),
            "charging": {
                "tier": "trial",
                "dev_discount": False,
                "is_burst": False,
                "llm_price": round(llm_cost, 10),
                "llm_charge": int(llm_cost * 10000),
                "llm_usage": {
                    "irreversible_generation": {"model_usage": irreversible},
                    "initiated_generation": {"model_usage": initiated},
                },
                "analysis": {"total": {"price": analysis_cost, "runs": 1}},
                "free_llm_dollars_consumed": 0.0,
            },
            "rag_usage": {"retrieval_count": sum(1 for x in transcript if x.get("rag_retrieval_info"))},
            "phone_call": {"direction": "inbound", "type": "sip_trunking"},
        },
        "analysis": {
            "call_successful": successful,
            "call_success_score": round(0.55 + rnd.random() * 0.45, 3),
            "transcript_summary": "Caller queried an unexpected charge; resolved with an itemised invoice.",
            "evaluation_criteria_results": {},
            "data_collection_results": {},
        },
        "conversation_initiation_client_data": {
            "dynamic_variables": {
                "company": "Northwind Telecom",
                "caller_locale": "en-GB",
                "caller_tier": rnd.choice(["standard", "priority"]),
                "account_id": "acct_%06d" % int(rnd.random() * 999999),
                "plan": rnd.choice(["Essential", "Pro", "Business"]),
                "last4": "%04d" % int(rnd.random() * 9999),
                "device_model": rnd.choice(["NW-Hub-3", "NW-Hub-2", "NW-Mesh-1"]),
                "firmware": "4.%d.%d" % (int(rnd.random() * 9), int(rnd.random() * 9)),
                "queue": "tier2_support",
                "sla_tier": "standard",
                "intent_hint": "",
                "csat_survey_id": "csat_2026_q3",
            }
        },
    }

    summary = {
        "conversation_id": conversation_id,
        "agent_id": agent_id,
        "agent_name": next(a["name"] for a in AGENTS if a["agent_id"] == agent_id),
        "start_time_unix_secs": started,
        "call_duration_secs": duration,
        "message_count": len(transcript),
        "status": "done",
        "call_successful": successful,
        "direction": "inbound",
        "termination_reason": detail["metadata"]["termination_reason"],
        "main_language": "en",
    }
    return summary, detail
