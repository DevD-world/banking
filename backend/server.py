from __future__ import annotations

import json
import os
import base64
import hashlib
import re
import sqlite3
import subprocess
import threading
import time
import uuid
from collections import deque
from datetime import date
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("COMPLETION_IQ_DATA_DIR", ROOT / "backend"))
DB_PATH = Path(os.environ.get("COMPLETION_IQ_DB_PATH", DATA_DIR / "completion_iq.sqlite3"))
UPLOAD_DIR = Path(os.environ.get("COMPLETION_IQ_UPLOAD_DIR", DATA_DIR / "uploads"))
OCR_SCRIPT = ROOT / "backend" / "windows_ocr.ps1"
TODAY = "2026-06-05"


DEFAULT_RULES = {
    "Savings Account": [
        {"name": "Aadhaar", "weight": 20, "fields": ["aadhaar"], "mandatory": True},
        {"name": "PAN", "weight": 20, "fields": ["pan"], "mandatory": True},
        {"name": "Photo", "weight": 10, "fields": [], "mandatory": True},
        {"name": "Signature", "weight": 10, "fields": [], "mandatory": True},
    ],
    "Business Loan": [
        {"name": "GST Certificate", "weight": 18, "fields": ["gstin"], "mandatory": True},
        {"name": "ITR", "weight": 14, "fields": ["pan"], "mandatory": True},
        {"name": "Bank Statements", "weight": 16, "fields": [], "mandatory": True},
        {"name": "Business Registration", "weight": 14, "fields": [], "mandatory": True},
        {"name": "PAN", "weight": 12, "fields": ["pan"], "mandatory": True},
        {"name": "Aadhaar", "weight": 8, "fields": ["aadhaar"], "mandatory": True},
    ],
    "Current Account": [
        {"name": "GST Certificate", "weight": 18, "fields": ["gstin"], "mandatory": True},
        {"name": "Business Registration", "weight": 16, "fields": [], "mandatory": True},
        {"name": "PAN", "weight": 14, "fields": ["pan"], "mandatory": True},
        {"name": "Aadhaar", "weight": 10, "fields": ["aadhaar"], "mandatory": True},
        {"name": "Address Proof", "weight": 12, "fields": [], "mandatory": True},
    ],
    "Home Loan": [
        {"name": "PAN", "weight": 12, "fields": ["pan"], "mandatory": True},
        {"name": "Aadhaar", "weight": 10, "fields": ["aadhaar"], "mandatory": True},
        {"name": "Salary Slips", "weight": 14, "fields": [], "mandatory": True},
        {"name": "Bank Statements", "weight": 14, "fields": [], "mandatory": True},
        {"name": "Property Documents", "weight": 18, "fields": [], "mandatory": True},
        {"name": "ITR", "weight": 10, "fields": ["pan"], "mandatory": False},
    ],
}

DOCUMENT_FIELD_REQUIREMENTS = {
    "Aadhaar": ["name", "aadhaar"],
    "PAN": ["name", "pan"],
    "GST Certificate": ["gstin"],
    "ITR": ["pan"],
    "Business Registration": [],
    "Bank Statements": [],
    "Photo": [],
    "Signature": [],
    "Address Proof": ["address"],
    "Salary Slips": [],
    "Property Documents": [],
    "Unknown Document": [],
}

ADDRESS_BEARING_DOCS = {
    "Aadhaar",
    "Address Proof",
    "Bank Statements",
    "Business Registration",
    "GST Certificate",
    "ITR",
    "Salary Slips",
    "Property Documents",
}

REGULATORY_REQUIREMENTS = {
    "kyc": {
        "name": "RBI KYC / Customer Due Diligence",
        "status": "Adapter ready",
        "url": "https://www.rbi.org.in/commonman/english/scripts/notification.aspx?id=2607",
        "note": "Production should connect to the bank-approved RBI/KYC compliance rule source and policy engine.",
    },
    "uidai": {
        "name": "UIDAI Aadhaar verification",
        "status": "Adapter ready",
        "url": "https://uidai.gov.in/en/",
        "note": "Use only bank-approved Aadhaar verification flows with consent and masking controls.",
    },
    "pan": {
        "name": "PAN / Income Tax verification",
        "status": "Adapter ready",
        "url": "https://www.incometax.gov.in/iec/foportal/",
        "note": "Use PAN verification through approved API/channel in production.",
    },
}

BHARAT_BANK_DOWNLOADS_URL = "https://www.bharatbank.bank.in/downloads.html"

BANK_POLICY_REQUIREMENTS = {
    "bank": "Bharat Bank",
    "status": "Policy adapter ready",
    "url": BHARAT_BANK_DOWNLOADS_URL,
    "note": "Demo uses local policy rules mapped to Bharat Bank's public downloads/forms page. Production should consume the bank's approved product-policy and form-template API.",
}

BANK_FORM_CATALOG = {
    "Savings Account": [
        "Saving Bank Account Opening Form (Resident Individuals & NRIs)",
        "Customer Details Form",
        "Specimen Signature Form",
        "Nomination Form",
        "FATCA-CRS Declaration Form - Individuals",
        "FORM 60",
    ],
    "Current Account": [
        "Current Account Opening Form (For Non-Individuals)",
        "Corporate Customer Details Form",
        "Specimen Signature Form",
        "FATCA-CRS Declaration Form - Individuals",
        "Addendum to Account opening Form for Non-Individuals - By the ENTITY",
        "Addendum to Account opening Form for Non-Individuals - By the CONTROLLING PERSON",
    ],
    "Business Loan": [
        "Application Form For MSES",
        "Corporate Customer Details Form",
        "KYC Data Updation Form - Corporate Customers (Non-Individuals)",
        "Specimen Signature Form",
    ],
    "Home Loan": [
        "Customer Details Form",
        "KYC Data Updation Form - Retail Customers (Individuals)",
        "Specimen Signature Form",
        "FORM 60",
    ],
}

KYC_PROFILE_INDEX = {
    "AADHAAR:943330867524": {
        "name": "Abhishek Mansukh Waghela",
        "aadhaar": "9433 3086 7524",
        "dob": "15/08/2006",
        "mobile": "7738802275",
        "gender": "Male",
    },
    "PAN:AKFPW7768N": {
        "name": "Abhishek Mansukh Waghela",
        "pan": "AKFPW7768N",
        "dob": "15/08/2006",
    },
}

SCAN_CACHE_VERSION = "world-graph-v1"
MAX_JSON_PAYLOAD_BYTES = int(os.environ.get("COMPLETION_IQ_MAX_PAYLOAD_BYTES", str(5 * 1024 * 1024)))
OCR_WORKERS = int(os.environ.get("COMPLETION_IQ_OCR_WORKERS", "32"))
OCR_TIMEOUT_SECONDS = int(os.environ.get("COMPLETION_IQ_OCR_TIMEOUT_SECONDS", "30"))
ALLOWED_ORIGIN = os.environ.get("COMPLETION_IQ_ALLOWED_ORIGIN", "*")
STAFF_API_KEY = os.environ.get("COMPLETION_IQ_API_KEY", "")
OCR_SEMAPHORE = threading.BoundedSemaphore(max(1, OCR_WORKERS))
METRICS_LOCK = threading.Lock()
REQUEST_TIMESTAMPS = deque(maxlen=5000)
ACTIVE_REQUESTS = 0
TOTAL_REQUESTS = 0


def new_id() -> str:
    return str(uuid.uuid4())


def daysSince(date_value: str) -> int:
    try:
        start = date.fromisoformat(str(date_value))
        end = date.fromisoformat(TODAY)
        return max(0, (end - start).days)
    except ValueError:
        return 0


def doc(name: str, confidence: int = 94) -> dict:
    return {
        "id": new_id(),
        "name": name,
        "status": "Received",
        "confidence": confidence,
        "uploadedAt": "2026-06-04",
        "extracted": {},
    }


def task(title: str, type_: str, owner: str, due_date: str, status: str, priority: str) -> dict:
    return {
        "id": new_id(),
        "title": title,
        "type": type_,
        "owner": owner,
        "dueDate": due_date,
        "status": status,
        "priority": priority,
    }


def normalize_identifier(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", str(value or "")).upper()


def normalize_name(value: str) -> str:
    tokens = re.findall(r"[A-Za-z]+", str(value or "").lower())
    return " ".join(tokens)


def name_similarity(left: str, right: str) -> float:
    left_tokens = normalize_name(left).split()
    right_tokens = normalize_name(right).split()
    if not left_tokens or not right_tokens:
        return 0.0
    if left_tokens == right_tokens:
        return 1.0
    overlap = len(set(left_tokens) & set(right_tokens)) / max(1, max(len(set(left_tokens)), len(set(right_tokens))))
    same_first = left_tokens[0] == right_tokens[0]
    same_last = left_tokens[-1] == right_tokens[-1]
    ordered_hits = sum(1 for index, token in enumerate(left_tokens[: len(right_tokens)]) if index < len(right_tokens) and token == right_tokens[index])
    ordered_score = ordered_hits / max(len(left_tokens), len(right_tokens))
    return min(1.0, (overlap * 0.55) + (0.25 if same_first else 0) + (0.12 if same_last else 0) + (ordered_score * 0.08))


def normalize_address(value: str) -> str:
    text = str(value or "").lower()
    text = re.sub(r"\b(?:address|addr|residence|resident|permanent|communication|present|proof|of|india)\b", " ", text)
    text = re.sub(r"[^a-z0-9 ]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def address_tokens(value: str) -> set[str]:
    stop = {
        "address", "proof", "resident", "residence", "permanent", "communication",
        "present", "india", "near", "opp", "opposite", "road", "rd", "street", "st",
        "no", "house", "flat", "floor", "pin", "pincode", "post", "po",
    }
    return {token for token in re.findall(r"[a-z0-9]{3,}", normalize_address(value)) if token not in stop}


def address_similarity(left: str, right: str) -> float:
    left_tokens = address_tokens(left)
    right_tokens = address_tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    overlap = len(left_tokens & right_tokens) / max(1, min(len(left_tokens), len(right_tokens)))
    left_pin = re.findall(r"\b[1-9][0-9]{5}\b", left)
    right_pin = re.findall(r"\b[1-9][0-9]{5}\b", right)
    if left_pin and right_pin and left_pin[-1] == right_pin[-1]:
        overlap += 0.2
    if left_pin and right_pin and left_pin[-1] != right_pin[-1]:
        overlap -= 0.25
    return max(0.0, min(1.0, overlap))


def document_hash(app_id: str, filename: str, text: str, file_data: str, expected_doc: str) -> str:
    digest = hashlib.sha256()
    digest.update(SCAN_CACHE_VERSION.encode("utf-8"))
    digest.update(str(app_id or "").upper().encode("utf-8"))
    digest.update(str(filename or "").lower().encode("utf-8"))
    digest.update(str(expected_doc or "").lower().encode("utf-8"))
    digest.update(str(text or "").encode("utf-8"))
    digest.update(str(file_data or "")[:200000].encode("utf-8"))
    return digest.hexdigest()


def initial_state() -> dict:
    integrations = [
        {"id": "crm", "name": "CRM Sync", "status": "Planned", "detail": "Push stage, owner, document, and task updates to CRM."},
        {"id": "whatsapp", "name": "WhatsApp Business", "status": "Ready for API", "detail": "Send approved follow-up templates and capture delivery status."},
        {"id": "ocr", "name": "OCR / Document AI", "status": "Ready for API", "detail": "Classify documents, extract fields, and flag mismatches."},
        {"id": "kyc", "name": "Aadhaar/PAN Verification", "status": "Planned", "detail": "Validate extracted identity fields against approved providers."},
        {"id": "email", "name": "Email Gateway", "status": "Ready for API", "detail": "Send pending document reminders and status updates."},
        {"id": "calls", "name": "Call Recording", "status": "Planned", "detail": "Link call outcomes to application timeline and RM productivity."},
    ]
    applications = [
        {
            "id": "APP-1048",
            "customer": "Ramesh Textiles",
            "mobile": "+91 98765 41048",
            "email": "owner@rameshtextiles.in",
            "product": "Business Loan",
            "rm": "Asha Nair",
            "manager": "Prakash Menon",
            "branch": "Chennai Central",
            "stage": "Document Collection",
            "value": 1800000,
            "createdAt": "2026-05-27",
            "lastActivityAt": "2026-06-01",
            "customerIntent": "Warm",
            "source": "Branch walk-in",
            "documents": [doc("PAN"), doc("Aadhaar"), doc("Bank Statements"), doc("Business Registration")],
            "tasks": [
                task("Collect GST Certificate", "Document", "Asha Nair", "2026-06-05", "Open", "High"),
                task("Collect latest ITR", "Document", "Asha Nair", "2026-06-06", "Open", "Medium"),
            ],
            "timeline": ["Application started", "PAN and Aadhaar collected", "Bank statements uploaded"],
            "notes": ["Customer wants working capital for seasonal order."],
        },
        {
            "id": "APP-1053",
            "customer": "Kavya Srinivasan",
            "mobile": "+91 90031 11053",
            "email": "kavya@example.com",
            "product": "Savings Account",
            "rm": "Vikram Shah",
            "manager": "Prakash Menon",
            "branch": "Coimbatore Main",
            "stage": "Verification",
            "value": 120000,
            "createdAt": "2026-06-01",
            "lastActivityAt": "2026-06-04",
            "customerIntent": "Hot",
            "source": "Campaign",
            "documents": [doc("Aadhaar"), doc("PAN"), doc("Photo")],
            "tasks": [task("Collect wet signature", "Document", "Vikram Shah", "2026-06-05", "Open", "Medium")],
            "timeline": ["Application started", "Photo captured", "KYC verification pending"],
            "notes": ["Customer prefers WhatsApp follow-up."],
        },
        {
            "id": "APP-1061",
            "customer": "GreenMart Foods",
            "mobile": "+91 98402 21061",
            "email": "finance@greenmartfoods.in",
            "product": "Current Account",
            "rm": "Asha Nair",
            "manager": "Prakash Menon",
            "branch": "Chennai Central",
            "stage": "Document Collection",
            "value": 650000,
            "createdAt": "2026-05-24",
            "lastActivityAt": "2026-05-29",
            "customerIntent": "Warm",
            "source": "RM referral",
            "documents": [doc("PAN"), doc("Aadhaar"), doc("GST Certificate")],
            "tasks": [
                task("Collect Address Proof", "Document", "Asha Nair", "2026-06-04", "Open", "High"),
                task("Call customer for registration copy", "Call", "Asha Nair", "2026-06-05", "Open", "High"),
            ],
            "timeline": ["Application started", "GST certificate collected", "Customer did not respond to address proof request"],
            "notes": ["Owner travels frequently. Call before 11 AM."],
        },
    ]
    return {
        "rules": DEFAULT_RULES,
        "applications": applications,
        "reviewQueue": [],
        "notifications": [],
        "integrations": integrations,
        "user": {"role": "rm", "name": "Asha Nair"},
    }


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, event_text TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, branch TEXT, status TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scan_records (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, doc_type TEXT NOT NULL, filename TEXT, fields TEXT NOT NULL, ai TEXT NOT NULL, quality TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS validation_flags (id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, app_id TEXT NOT NULL, doc_type TEXT NOT NULL, flag_type TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ocr_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scan_jobs (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, expected_doc TEXT NOT NULL, filename TEXT, cache_key TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS integration_events (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, integration TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS customer_upload_links (token TEXT PRIMARY KEY, app_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scan_records_app_doc_date ON scan_records(app_id, doc_type, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_validation_flags_app_status ON validation_flags(app_id, status, severity)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_notifications_app_status ON notifications(app_id, status, severity)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scan_jobs_status_date ON scan_jobs(status, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_integration_events_app ON integration_events(app_id, integration, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_customer_links_app ON customer_upload_links(app_id, status)")
    if conn.execute("SELECT COUNT(*) FROM app_state").fetchone()[0] == 0:
        conn.execute(
            "INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, ?)",
            (json.dumps(initial_state()), TODAY),
        )
        conn.execute(
            "INSERT OR REPLACE INTO users VALUES (?, ?, ?, ?, ?)",
            ("USR-1", "Asha Nair", "rm", "Chennai Central", "Active"),
        )
        conn.commit()
    return conn


def get_state() -> dict:
    with db() as conn:
        row = conn.execute("SELECT payload FROM app_state WHERE id = 1").fetchone()
        state = json.loads(row["payload"])
        state.setdefault("notifications", [])
        state.setdefault("reviewQueue", [])
        for app in state.get("applications", []):
            app.setdefault("accountType", product_account_type(app.get("product", "")))
            app.setdefault("customerSegment", "Business" if app.get("product") in ("Business Loan", "Current Account") else "Personal")
            app.setdefault("trackingTicket", make_tracking_ticket(app))
            app.setdefault("submissionStatus", "Draft")
            app.setdefault("crmReference", "")
            app.setdefault("customerTrackingUrl", f"/customer.html?ticket={app.get('trackingTicket', make_tracking_ticket(app))}")
            app.setdefault("documents", [])
            app.setdefault("tasks", [])
            app.setdefault("timeline", [])
            app.setdefault("identity", {})
        return state


def save_state(state: dict, event: str = "State updated") -> None:
    with db() as conn:
        conn.execute("UPDATE app_state SET payload = ?, updated_at = ? WHERE id = 1", (json.dumps(state), TODAY))
        conn.execute(
            "INSERT INTO audit_events VALUES (?, ?, ?, ?)",
            (new_id(), "state", event, TODAY),
        )
        conn.commit()


def find_app(state: dict, app_id: str) -> dict | None:
    return next((app for app in state["applications"] if app["id"] == app_id), None)


def can_mutate_app(state: dict, app: dict) -> bool:
    user = state.get("user", {})
    role = user.get("role", "rm")
    if role == "customer":
        return False
    if role in ("manager", "admin"):
        return True
    return app.get("rm") == user.get("name")


def can_run_staff_workflow(state: dict, app: dict) -> bool:
    user = state.get("user", {})
    role = user.get("role", "rm")
    if role == "customer":
        return False
    if role in ("manager", "admin"):
        return True
    return app.get("rm") == user.get("name")


def product_account_type(product: str) -> str:
    if product in ("Business Loan", "Home Loan"):
        return "Loan"
    if product in ("Savings Account", "Current Account"):
        return "Account Opening"
    return "Application"


def make_tracking_ticket(app: dict) -> str:
    seed = normalize_identifier(app.get("id") or uuid.uuid4().hex)[:8] or uuid.uuid4().hex[:8].upper()
    prefix = "LN" if product_account_type(app.get("product", "")) == "Loan" else "AC"
    return f"{prefix}-{seed}"


def make_crm_reference(app: dict) -> str:
    return f"CRM-{normalize_identifier(app.get('trackingTicket') or make_tracking_ticket(app))[-10:]}"


def customer_tracking_url(app: dict) -> str:
    return f"/customer.html?ticket={app.get('trackingTicket', make_tracking_ticket(app))}"


def form_prefill_payload(app: dict) -> dict:
    identity = app.get("identity", {})
    pan_fields = identity.get("pan", {}).get("fields", {})
    aadhaar_fields = identity.get("aadhaar", {}).get("fields", {})
    primary_name = pan_fields.get("name") or aadhaar_fields.get("name") or app.get("customer", "")
    address = app.get("addressProfile", {}).get("address") or aadhaar_fields.get("address", "Not detected")
    signature_status = next(
        (
            doc.get("extracted", {}).get("signatureStatus")
            for doc in app.get("documents", [])
            if doc.get("name") == "Signature"
        ),
        "Not detected",
    )
    forms = BANK_FORM_CATALOG.get(app.get("product", ""), ["Customer Details Form"])
    fields = {
        "applicationId": app.get("id"),
        "trackingTicket": app.get("trackingTicket"),
        "crmReference": app.get("crmReference", ""),
        "customerName": primary_name,
        "mobile": app.get("mobile") or aadhaar_fields.get("mobile", ""),
        "email": app.get("email", ""),
        "product": app.get("product"),
        "accountType": app.get("accountType") or product_account_type(app.get("product", "")),
        "customerSegment": app.get("customerSegment", ""),
        "branch": app.get("branch", ""),
        "relationshipManager": app.get("rm", ""),
        "pan": pan_fields.get("pan", "Not detected"),
        "aadhaar": aadhaar_fields.get("aadhaar", "Not detected"),
        "dob": pan_fields.get("dob") or aadhaar_fields.get("dob", "Not detected"),
        "gender": aadhaar_fields.get("gender", "Not detected"),
        "address": address,
        "signatureStatus": signature_status,
        "documentsAttached": [
            doc.get("name")
            for doc in app.get("documents", [])
            if doc.get("status") == "Received"
        ],
    }
    return {
        "bank": "Bharat Bank",
        "downloadsUrl": BHARAT_BANK_DOWNLOADS_URL,
        "forms": forms,
        "fields": fields,
        "mappings": [
            {
                "formName": form,
                "source": "Completion IQ application plus verified documents",
                "fillableFields": fields,
                "status": "Ready for PDF/template adapter",
            }
            for form in forms
        ],
        "message": "Use this packet to pre-fill downloaded Bharat Bank forms through a PDF/template adapter or bank form API.",
    }


def application_tracking_payload(app: dict, state: dict | None = None) -> dict:
    missing = [doc["name"] for doc in missingDocs_for_backend(app)]
    docs = []
    for rule in DEFAULT_RULES.get(app.get("product", ""), []):
        received = next((item for item in app.get("documents", []) if item.get("name") == rule["name"] and item.get("status") == "Received"), None)
        docs.append({
            "name": rule["name"],
            "mandatory": rule.get("mandatory", False),
            "status": "Received" if received else "Pending",
            "confidence": received.get("confidence") if received else None,
        })
    blockers = completion_blockers(state, app) if state else missing
    return {
        "ticket": app.get("trackingTicket", make_tracking_ticket(app)),
        "crmReference": app.get("crmReference", ""),
        "customer": app.get("customer", "Applicant"),
        "product": app.get("product", ""),
        "accountType": app.get("accountType", product_account_type(app.get("product", ""))),
        "customerSegment": app.get("customerSegment", ""),
        "stage": app.get("stage", "Document Collection"),
        "submissionStatus": app.get("submissionStatus", "Draft"),
        "completion": backend_completion_score(app),
        "risk": backend_risk_score(app),
        "missing": missing,
        "documents": docs,
        "nextAction": blockers[0] if blockers else "Bank review in progress",
        "updatedAt": app.get("lastActivityAt", TODAY),
    }


def document_policy_payload(product: str = "", segment: str = "") -> dict:
    product = product or "Savings Account"
    docs = DEFAULT_RULES.get(product, [])
    return {
        "product": product,
        "segment": segment or ("Business" if product in ("Business Loan", "Current Account") else "Personal"),
        "accountType": product_account_type(product),
        "requiredDocuments": docs,
        "bankPolicy": BANK_POLICY_REQUIREMENTS,
        "regulatoryLinks": REGULATORY_REQUIREMENTS,
        "message": "Required documents are currently resolved from local Bharat Bank policy rules. Replace this adapter with the bank's policy/document API for production.",
    }


def world_graph_snapshot(state: dict) -> dict:
    nodes = []
    edges = []
    dynamics = []
    actions = []

    def add_node(node_id: str, label: str, type_: str, state_value: str = "", risk: int = 0) -> None:
        if not any(node["id"] == node_id for node in nodes):
            nodes.append({"id": node_id, "label": label, "type": type_, "state": state_value, "risk": risk})

    def add_edge(source: str, relation: str, target: str, effect: str = "") -> None:
        edges.append({"source": source, "relation": relation, "target": target, "effect": effect})

    for app in state.get("applications", [])[:25]:
        app_id = app["id"]
        app_node = f"app:{app_id}"
        customer_node = f"customer:{app_id}"
        product_node = f"product:{normalize_identifier(app.get('product'))}"
        rm_node = f"rm:{normalize_identifier(app.get('rm'))}"
        risk = backend_risk_score(app)
        completion = backend_completion_score(app)
        missing = missingDocs_for_backend(app)

        add_node(customer_node, app.get("customer", "Customer"), "Customer", app.get("customerIntent", "Warm"), risk)
        add_node(app_node, app_id, "Application", app.get("stage", "Document Collection"), risk)
        add_node(product_node, app.get("product", "Product"), "Product", product_account_type(app.get("product", "")), 0)
        add_node(rm_node, app.get("rm", "RM"), "Employee", "Owner", 0)
        add_edge(customer_node, "applied_for", app_node)
        add_edge(app_node, "uses_product_rules", product_node)
        add_edge(rm_node, "owns", app_node)

        for doc_rule in DEFAULT_RULES.get(app.get("product", ""), []):
            doc_node = f"doc:{app_id}:{normalize_identifier(doc_rule['name'])}"
            received = any(doc.get("name") == doc_rule["name"] and doc.get("status") == "Received" for doc in app.get("documents", []))
            doc_state = "Received" if received else "Missing"
            add_node(doc_node, doc_rule["name"], "Document", doc_state, 0 if received else 65)
            add_edge(app_node, "requires", doc_node, "missing delays completion" if not received else "received increases completion")
            if not received and doc_rule.get("mandatory"):
                add_edge(doc_node, "causes", app_node, "raises drop-off risk")
                dynamics.append({
                    "if": f"{doc_rule['name']} remains missing",
                    "then": f"{app.get('customer')} approval probability falls and RM follow-up load increases.",
                    "riskDelta": "+12",
                    "applicationId": app_id,
                })
                actions.append({
                    "applicationId": app_id,
                    "action": f"Request {doc_rule['name']}",
                    "owner": app.get("rm"),
                    "expectedEffect": "Reduce delay risk and increase completion probability",
                    "priority": "High" if risk >= 60 else "Medium",
                })

        identity_consistency = app.get("identityConsistency", {})
        if identity_consistency.get("status") in ("Blocked", "Review"):
            consistency_node = f"identity:{app_id}"
            add_node(consistency_node, "Identity Cross-Check", "Risk", identity_consistency.get("status", "Review"), 90 if identity_consistency.get("status") == "Blocked" else 55)
            add_edge(consistency_node, "blocks", app_node, "conflicting document evidence prevents safe submission")
            add_edge(app_node, "must_resolve", consistency_node, "same customer must be proven across documents")
            for mismatch in identity_consistency.get("mismatches", [])[:5]:
                mismatch_node = f"mismatch:{app_id}:{normalize_identifier(mismatch.get('field'))}:{len(nodes)}"
                add_node(mismatch_node, mismatch.get("field", "Identity mismatch"), "Mismatch", mismatch.get("message", ""), 95)
                add_edge(mismatch_node, "causes", consistency_node, "raises fraud/KYC risk")
                dynamics.append({
                    "if": mismatch.get("message", "identity mismatch remains unresolved"),
                    "then": f"{app.get('customer')} cannot be safely submitted to Bank CRM; approval probability falls until RM verifies correct document.",
                    "riskDelta": "+35",
                    "applicationId": app_id,
                })
            actions.append({
                "applicationId": app_id,
                "action": "Resolve identity mismatch",
                "owner": app.get("manager") or app.get("rm"),
                "expectedEffect": "Confirm correct customer documents before CRM submission",
                "priority": "High",
            })

        if completion >= 85 and not missing:
            actions.append({
                "applicationId": app_id,
                "action": "Submit to Bank CRM",
                "owner": app.get("rm"),
                "expectedEffect": "Move application from branch collection to bank approval workflow",
                "priority": "High",
            })

    return {
        "engine": "Graph World Model",
        "description": "Entity nodes + relationship edges + state dynamics + action-conditioned predictions.",
        "nodes": nodes,
        "edges": edges,
        "dynamics": dynamics[:20],
        "actions": actions[:20],
        "summary": {
            "nodes": len(nodes),
            "edges": len(edges),
            "dynamics": len(dynamics),
            "recommendedActions": len(actions),
        },
    }


def detect_document_type(source: str) -> str:
    text = source.lower()
    detectors = [
        ("GST Certificate", ["gst", "gstin"]),
        ("PAN", ["pan", "permanent account"]),
        ("Aadhaar", ["aadhaar", "uidai", "aadhar"]),
        ("Bank Statements", ["bank statement", "account statement", "statement"]),
        ("ITR", ["itr", "income tax return"]),
        ("Business Registration", ["registration", "udyam", "certificate of incorporation"]),
        ("Photo", ["photo", "passport photo"]),
        ("Signature", ["signature"]),
        ("Address Proof", ["address proof", "electricity bill", "utility bill"]),
        ("Salary Slips", ["salary slip", "pay slip", "payslip"]),
        ("Property Documents", ["property", "sale deed", "title deed"]),
    ]
    for name, keys in detectors:
        if any(key in text for key in keys):
            return name
    return "Unknown Document"


def detect_document_layout(source: str, doc_type: str) -> dict:
    text = source.lower()
    lines = [line.strip() for line in source.splitlines() if line.strip()]
    signals = []
    layout = "Generic OCR"
    score = 35

    if doc_type == "PAN":
        if "income tax" in text or "permanent account" in text:
            signals.append("PAN header")
            score += 22
        if re.search(r"[A-Z]{5}[0-9]{4}[A-Z]", source, re.I):
            signals.append("PAN number pattern")
            score += 28
        if any(re.fullmatch(r"name", line, re.I) for line in lines) or "father" in text:
            signals.append("PAN name/father-name layout")
            score += 12
        layout = "Indian PAN card layout"

    elif doc_type == "Aadhaar":
        if "uidai" in text or "unique identification" in text or "government of india" in text:
            signals.append("Aadhaar/UIDAI header")
            score += 18
        if re.search(r"\b[0-9]{4}\s?[0-9]{4}\s?[0-9]{4}\b", source):
            signals.append("Aadhaar number pattern")
            score += 28
        if re.search(r"\b(?:dob|date of birth|yob|male|female)\b", source, re.I):
            signals.append("Aadhaar demographic layout")
            score += 14
        layout = "Indian Aadhaar card layout"

    elif doc_type == "GST Certificate":
        if re.search(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]", source, re.I):
            signals.append("GSTIN pattern")
            score += 38
        if "goods and services tax" in text or "certificate" in text:
            signals.append("GST certificate header")
            score += 18
        layout = "GST certificate layout"

    elif doc_type == "Address Proof":
        if re.search(r"\b(?:address|residence|utility bill|electricity bill|registered office)\b", source, re.I):
            signals.append("Address proof layout")
            score += 28
        if re.search(r"\b[1-9][0-9]{5}\b", source):
            signals.append("PIN code pattern")
            score += 18
        layout = "Address proof layout"

    elif doc_type != "Unknown Document":
        signals.append(f"{doc_type} keyword match")
        score += 20

    return {
        "layout": layout,
        "confidence": min(99, score),
        "signals": signals or ["OCR text received"],
    }


def document_ai_middleware(source: str, expected_doc: str = "") -> dict:
    detected_doc = detect_document_type(source)
    doc_type = expected_doc if expected_doc in DOCUMENT_FIELD_REQUIREMENTS else detected_doc
    fields = extract_fields(source, doc_type)
    fields = enrich_fields_from_kyc_profile(fields)
    if doc_type == "Signature":
        fields["signatureStatus"] = signature_status(source)
    layout = detect_document_layout(source, doc_type)
    required = DOCUMENT_FIELD_REQUIREMENTS.get(doc_type, [])
    missing = [field for field in required if fields.get(field) in (None, "", "Not detected")]
    extracted = [field for field, value in fields.items() if value not in (None, "", "Not detected")]
    field_score = round((len(required) - len(missing)) / max(1, len(required)) * 35)
    confidence = min(99, layout["confidence"] + field_score)
    status = "Auto-extracted" if not missing and extracted else "Needs review"
    if not source.strip():
        status = "No readable text"
        confidence = 0
    return {
        "engine": "Lightweight Document AI Middleware",
        "status": status,
        "docType": doc_type,
        "detectedDocType": detected_doc,
        "layout": layout["layout"],
        "confidence": confidence,
        "signals": layout["signals"],
        "requiredFields": required,
        "missingFields": missing,
        "fields": fields,
        "message": "Document format understood and fields mapped automatically." if status == "Auto-extracted" else "Document scanned, but some required fields were not confidently extracted.",
    }


def signature_status(source: str) -> str:
    text = (source or "").lower()
    if re.search(r"\b(?:not signed|unsigned|blank signature|signature missing|signature pending)\b", text):
        return "Missing"
    if re.search(r"\b(?:signed|signature present|customer signature|applicant signature|digitally signed|signature verified)\b", text):
        return "Present"
    if "signature" in text:
        return "Needs review"
    return "Not applicable"


def enrich_fields_from_kyc_profile(fields: dict) -> dict:
    enriched = dict(fields)
    keys = []
    aadhaar = normalize_identifier(enriched.get("aadhaar", ""))
    pan = normalize_identifier(enriched.get("pan", ""))
    if aadhaar and aadhaar != "NOTDETECTED":
        keys.append(f"AADHAAR:{aadhaar}")
    if pan and pan != "NOTDETECTED":
        keys.append(f"PAN:{pan}")
    profile = next((KYC_PROFILE_INDEX[key] for key in keys if key in KYC_PROFILE_INDEX), None)
    if not profile:
        return enriched
    for key, value in profile.items():
        if key in {"name", "dob", "mobile", "gender"} or enriched.get(key) in (None, "", "Not detected"):
            enriched[key] = value
    enriched["profileMatched"] = True
    return enriched


def document_quality_assessment(filename: str, source: str, ocr_info: dict, ai: dict) -> dict:
    issues = []
    score = 100
    text_len = len(source.strip())
    lower_name = filename.lower()

    if text_len < 25:
        score -= 35
        issues.append("Low readable text")
    if ai.get("missingFields"):
        score -= 12 * len(ai["missingFields"])
        issues.append("Required fields missing")
    if ai.get("confidence", 0) < 75:
        score -= 18
        issues.append("Document format confidence is low")
    if any(word in lower_name for word in ("blur", "crop", "dark", "unclear")):
        score -= 18
        issues.append("Filename suggests poor scan quality")
    if ocr_info.get("status", "").lower().endswith("failed"):
        score -= 40
        issues.append("OCR failed")

    score = max(0, min(100, score))
    if score >= 82:
        status = "Good"
    elif score >= 55:
        status = "Review"
    else:
        status = "Poor"
    return {
        "score": score,
        "status": status,
        "issues": issues or ["Readable document"],
        "message": "Document quality is good." if status == "Good" else "Please review scan quality before final submission.",
    }


def validate_document_content(source: str, doc_type: str, fields: dict, expected_doc: str = "") -> list[dict]:
    text = source.lower()
    flags = []

    if doc_type in ("PAN", "Aadhaar") and fields.get("name") == "Not detected":
        flags.append({
            "type": "missing_name",
            "severity": "High",
            "message": f"{doc_type} name could not be extracted. Name may be missing, blurred, or not in the expected place.",
        })

    if re.search(r"\b(?:name|applicant name|customer name)\b", text) and fields.get("name") == "Not detected":
        flags.append({
            "type": "field_placement",
            "severity": "High",
            "message": "Name label found, but no readable name was placed next to/below it.",
        })

    if doc_type == "PAN" and fields.get("pan") == "Not detected":
        flags.append({
            "type": "missing_pan",
            "severity": "High",
            "message": "PAN number is missing or not readable.",
        })

    if doc_type == "Aadhaar" and fields.get("aadhaar") == "Not detected":
        flags.append({
            "type": "missing_aadhaar",
            "severity": "High",
            "message": "Aadhaar number is missing or not readable.",
        })

    if doc_type == "Address Proof" and fields.get("address") == "Not detected":
        flags.append({
            "type": "missing_address",
            "severity": "High",
            "message": "Address proof was uploaded, but no readable address was extracted.",
        })

    needs_signature = expected_doc == "Signature" or doc_type == "Signature" or "signature" in text or "signed" in text
    if needs_signature:
        signed_signal = re.search(r"\b(?:signed|signature present|digitally signed|applicant signature|customer signature)\b", text)
        empty_signal = re.search(r"\b(?:signature pending|not signed|unsigned|blank signature|signature missing)\b", text)
        if empty_signal or not signed_signal:
            flags.append({
                "type": "signature_check",
                "severity": "High",
                "message": "Signature is not confirmed. Please verify that the applicant has signed in the correct place.",
            })

    if doc_type in ("GST Certificate", "ITR") and fields.get("gstin") == "Not detected" and fields.get("pan") == "Not detected":
        flags.append({
            "type": "business_identifier",
            "severity": "Medium",
            "message": f"{doc_type} does not contain a readable GSTIN/PAN identifier.",
        })

    return flags


def create_notification(state: dict, app_id: str, title: str, message: str, severity: str = "High") -> dict:
    notification = {
        "id": new_id(),
        "appId": app_id,
        "title": title,
        "message": message,
        "severity": severity,
        "status": "Unread",
        "createdAt": TODAY,
    }
    state.setdefault("notifications", []).insert(0, notification)
    with db() as conn:
        conn.execute(
            "INSERT INTO notifications VALUES (?, ?, ?, ?, ?, ?, ?)",
            (notification["id"], app_id, title, message, severity, "Unread", TODAY),
        )
        conn.commit()
    return notification


def record_integration_event(app_id: str, integration: str, status: str, payload: dict) -> dict:
    event = {"id": new_id(), "appId": app_id, "integration": integration, "status": status, "payload": payload, "createdAt": TODAY}
    with db() as conn:
        conn.execute(
            "INSERT INTO integration_events VALUES (?, ?, ?, ?, ?, ?)",
            (event["id"], app_id, integration, status, json.dumps(payload), TODAY),
        )
        conn.commit()
    return event


def create_customer_link(app_id: str) -> dict:
    token = uuid.uuid4().hex
    with db() as conn:
        conn.execute("INSERT INTO customer_upload_links VALUES (?, ?, ?, ?)", (token, app_id, "Active", TODAY))
        conn.commit()
    return {"token": token, "url": f"/customer.html?token={token}", "status": "Active"}


def app_for_customer_token(token: str) -> str | None:
    with db() as conn:
        row = conn.execute("SELECT app_id FROM customer_upload_links WHERE token = ? AND status = ?", (token, "Active")).fetchone()
    return row["app_id"] if row else None


def persist_scan_record(app_id: str, doc_type: str, filename: str, fields: dict, ai: dict, quality: dict, flags: list[dict]) -> str:
    scan_id = new_id()
    with db() as conn:
        conn.execute(
            "INSERT INTO scan_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (scan_id, app_id, doc_type, filename, json.dumps(fields), json.dumps(ai), json.dumps(quality), TODAY),
        )
        for flag in flags:
            conn.execute(
                "INSERT INTO validation_flags VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (new_id(), scan_id, app_id, doc_type, flag["type"], flag["severity"], flag["message"], "Open", TODAY),
            )
        conn.commit()
    return scan_id


def get_cached_result(cache_key: str) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT payload FROM ocr_cache WHERE cache_key = ?", (cache_key,)).fetchone()
    return json.loads(row["payload"]) if row else None


def put_cached_result(cache_key: str, payload: dict) -> None:
    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO ocr_cache VALUES (?, ?, ?)",
            (cache_key, json.dumps(payload), TODAY),
        )
        conn.commit()


def field_confidence(fields: dict, ai: dict, quality: dict) -> dict:
    confidence = {}
    base = min(ai.get("confidence", 60), quality.get("score", 60))
    for key, value in fields.items():
        if value in (None, "", "Not detected"):
            confidence[key] = 0
        elif key in ("pan", "aadhaar", "gstin"):
            confidence[key] = min(99, max(75, base + 8))
        elif key == "name":
            confidence[key] = min(96, max(62, base - 4))
        else:
            confidence[key] = min(94, max(55, base - 8))
    return confidence


def preprocessing_report(filename: str, source: str, file_data: str) -> dict:
    suggestions = []
    lower = filename.lower()
    profile = upload_profile_from_data_url(file_data, filename)
    if file_data:
        suggestions.extend(["Auto-orientation check", "Contrast normalization", "OCR-safe text extraction"])
        if profile.get("orientation") not in ("Not applicable", "Unknown"):
            suggestions.append(profile["orientation"])
        if profile.get("scaling") and profile["scaling"] != "OCR-safe size":
            suggestions.append(profile["scaling"])
    if any(word in lower for word in ("blur", "dark", "crop")):
        suggestions.append("Re-scan recommended due to filename quality hint")
    if len(source.strip()) < 40:
        suggestions.append("Low text density; capture closer and flatter")
    return {
        "status": "Applied" if file_data else "Not needed for text input",
        "steps": suggestions or ["Readable input"],
        "imageProfile": profile,
    }


def mismatch_detection(app: dict, doc_type: str, fields: dict) -> list[dict]:
    mismatches = []

    def add_mismatch(field: str, message: str, reference: str = "", incoming: str = "", severity: str = "High") -> None:
        mismatches.append({
            "field": field,
            "severity": severity,
            "message": message,
            "reference": reference,
            "incoming": incoming,
            "docType": doc_type,
        })

    existing_docs = [doc for doc in app.get("documents", []) if doc.get("status") == "Received"]
    incoming_detected_doc = fields.get("detectedDocType", "")
    new_name = fields.get("name", "Not detected")
    if is_real_person_or_business_name(new_name) and is_real_person_or_business_name(app.get("customer", "")):
        current = normalize_name(app["customer"])
        incoming = normalize_name(new_name)
        similarity = name_similarity(current, incoming)
        if current and incoming and similarity < 0.82:
            add_mismatch(
                "name",
                f"Applicant name mismatch: application has {app['customer']}, {doc_type} has {new_name}.",
                app["customer"],
                new_name,
            )

    for existing in existing_docs:
        existing_fields = existing.get("extracted", {})
        existing_name = existing_fields.get("name", "Not detected")
        if is_real_person_or_business_name(new_name) and is_real_person_or_business_name(existing_name):
            similarity = name_similarity(existing_name, new_name)
            if similarity < 0.82:
                add_mismatch(
                    "name",
                    f"Name mismatch across documents: {existing.get('name')} has {existing_name}, {doc_type} has {new_name}.",
                    existing_name,
                    new_name,
                )
        existing_dob = existing_fields.get("dob", "Not detected")
        new_dob = fields.get("dob", "Not detected")
        if existing_dob != "Not detected" and new_dob != "Not detected" and normalize_identifier(existing_dob) != normalize_identifier(new_dob):
            add_mismatch(
                "dob",
                f"DOB mismatch across documents: {existing.get('name')} has {existing_dob}, {doc_type} has {new_dob}.",
                existing_dob,
                new_dob,
            )
        for id_key in ("pan", "aadhaar"):
            existing_value = existing_fields.get(id_key, "Not detected")
            new_value = fields.get(id_key, "Not detected")
            if existing_value != "Not detected" and new_value != "Not detected" and normalize_identifier(existing_value) != normalize_identifier(new_value):
                add_mismatch(
                    id_key,
                    f"{id_key.upper()} mismatch across documents: {existing.get('name')} has {existing_value}, {doc_type} has {new_value}.",
                    existing_value,
                    new_value,
                )

    identity = app.get("identity", {})
    for existing_doc, key in (("pan", "pan"), ("aadhaar", "aadhaar")):
        existing_value = identity.get(existing_doc, {}).get("fields", {}).get(key, "Not detected")
        new_value = fields.get(key, "Not detected")
        if existing_value != "Not detected" and new_value != "Not detected" and normalize_identifier(existing_value) != normalize_identifier(new_value):
            add_mismatch(key, f"{key.upper()} mismatch against existing verified record.", existing_value, new_value)

    identity_dobs = [
        value.get("fields", {}).get("dob", "Not detected")
        for value in identity.values()
        if isinstance(value, dict)
    ]
    new_dob = fields.get("dob", "Not detected")
    for saved_dob in identity_dobs:
        if saved_dob != "Not detected" and new_dob != "Not detected" and normalize_identifier(saved_dob) != normalize_identifier(new_dob):
            add_mismatch("dob", f"DOB mismatch against existing verified record: saved {saved_dob}, {doc_type} has {new_dob}.", saved_dob, new_dob)

    new_address = fields.get("address", "Not detected")
    reference = app.get("addressProfile", {})
    reference_address = reference.get("address", "Not detected")
    if new_address != "Not detected" and reference_address != "Not detected":
        similarity = address_similarity(reference_address, new_address)
        if similarity < 0.55:
            mismatch = {
                "field": "address",
                "severity": "High",
                "message": f"Address mismatch: saved {reference.get('sourceDoc', 'reference document')} address does not match {doc_type} address.",
                "referenceAddress": reference_address,
                "incomingAddress": new_address,
                "similarity": round(similarity * 100),
                "docType": doc_type,
            }
            mismatches.append(mismatch)
    return mismatches


def mismatch_flags(mismatches: list[dict]) -> list[dict]:
    flags = []
    for mismatch in mismatches:
        if mismatch.get("field") == "address":
            flags.append({
                "type": "address_mismatch",
                "severity": "High",
                "message": f"{mismatch['message']} Reference: {mismatch.get('referenceAddress', 'Not detected')}. Incoming: {mismatch.get('incomingAddress', 'Not detected')}.",
            })
        else:
            flags.append({
                "type": f"{mismatch.get('field', 'identity')}_mismatch",
                "severity": mismatch.get("severity", "High"),
                "message": mismatch.get("message", "Document identity mismatch detected."),
            })
    return flags


def update_identity_consistency(app: dict, doc_type: str, fields: dict, mismatches: list[dict], detected_doc_type: str = "") -> None:
    ledger = app.setdefault("identityConsistency", {
        "status": "Clear",
        "checks": [],
        "mismatches": [],
        "lastCheckedAt": TODAY,
    })
    evidence = {
        "docType": doc_type,
        "detectedDocType": detected_doc_type or doc_type,
        "name": fields.get("name", "Not detected"),
        "dob": fields.get("dob", "Not detected"),
        "pan": fields.get("pan", "Not detected"),
        "aadhaar": fields.get("aadhaar", "Not detected"),
        "signatureStatus": fields.get("signatureStatus", "Not applicable"),
        "checkedAt": TODAY,
    }
    ledger.setdefault("checks", []).insert(0, evidence)
    ledger["checks"] = ledger["checks"][:20]
    if mismatches:
        for mismatch in mismatches:
            item = {
                "field": mismatch.get("field", "identity"),
                "docType": doc_type,
                "severity": mismatch.get("severity", "High"),
                "message": mismatch.get("message", "Document identity mismatch detected."),
                "reference": mismatch.get("reference") or mismatch.get("referenceAddress", ""),
                "incoming": mismatch.get("incoming") or mismatch.get("incomingAddress", ""),
                "checkedAt": TODAY,
            }
            if not any(existing.get("message") == item["message"] for existing in ledger.setdefault("mismatches", [])):
                ledger["mismatches"].insert(0, item)
    ledger["mismatches"] = ledger.get("mismatches", [])[:20]
    ledger["status"] = "Blocked" if any(item.get("severity") == "High" for item in ledger.get("mismatches", [])) else "Review" if ledger.get("mismatches") else "Clear"
    ledger["lastCheckedAt"] = TODAY


def recompute_app_identity_consistency(app: dict) -> None:
    ledger = {
        "status": "Clear",
        "checks": [],
        "mismatches": [],
        "lastCheckedAt": TODAY,
    }
    docs = [doc for doc in app.get("documents", []) if doc.get("status") == "Received"]
    for doc in docs:
        fields = doc.get("extracted", {})
        ledger["checks"].insert(0, {
            "docType": doc.get("name", ""),
            "detectedDocType": doc.get("ai", {}).get("detectedDocType", doc.get("name", "")),
            "name": fields.get("name", "Not detected"),
            "dob": fields.get("dob", "Not detected"),
            "pan": fields.get("pan", "Not detected"),
            "aadhaar": fields.get("aadhaar", "Not detected"),
            "signatureStatus": fields.get("signatureStatus", "Not applicable"),
            "checkedAt": TODAY,
        })

    def add(field: str, message: str, reference: str = "", incoming: str = "") -> None:
        item = {
            "field": field,
            "docType": "Application",
            "severity": "High",
            "message": message,
            "reference": reference,
            "incoming": incoming,
            "checkedAt": TODAY,
        }
        if not any(existing.get("message") == message for existing in ledger["mismatches"]):
            ledger["mismatches"].insert(0, item)

    app_name = app.get("customer", "")
    for doc in docs:
        fields = doc.get("extracted", {})
        doc_name = fields.get("name", "Not detected")
        if is_real_person_or_business_name(app_name) and is_real_person_or_business_name(doc_name) and name_similarity(app_name, doc_name) < 0.82:
            add("name", f"Applicant name mismatch: application has {app_name}, {doc.get('name')} has {doc_name}.", app_name, doc_name)

    for index, left in enumerate(docs):
        left_fields = left.get("extracted", {})
        for right in docs[index + 1:]:
            right_fields = right.get("extracted", {})
            left_name = left_fields.get("name", "Not detected")
            right_name = right_fields.get("name", "Not detected")
            if is_real_person_or_business_name(left_name) and is_real_person_or_business_name(right_name) and name_similarity(left_name, right_name) < 0.82:
                add("name", f"Name mismatch across documents: {left.get('name')} has {left_name}, {right.get('name')} has {right_name}.", left_name, right_name)
            for field in ("dob", "pan", "aadhaar"):
                left_value = left_fields.get(field, "Not detected")
                right_value = right_fields.get(field, "Not detected")
                if left_value != "Not detected" and right_value != "Not detected" and normalize_identifier(left_value) != normalize_identifier(right_value):
                    add(field, f"{field.upper()} mismatch across documents: {left.get('name')} has {left_value}, {right.get('name')} has {right_value}.", left_value, right_value)

    ledger["mismatches"] = ledger["mismatches"][:20]
    ledger["checks"] = ledger["checks"][:20]
    ledger["status"] = "Blocked" if ledger["mismatches"] else "Clear"
    app["identityConsistency"] = ledger


def update_address_profile(app: dict, doc_type: str, fields: dict, mismatches: list[dict]) -> None:
    address = fields.get("address", "Not detected")
    if address == "Not detected":
        return
    has_address_mismatch = any(item.get("field") == "address" for item in mismatches)
    if has_address_mismatch:
        return
    current = app.get("addressProfile", {})
    if not current or doc_type in ("Aadhaar", "Address Proof"):
        app["addressProfile"] = {
            "address": address,
            "normalized": normalize_address(address),
            "sourceDoc": doc_type,
            "updatedAt": TODAY,
        }


def duplicate_detection(state: dict, current_app_id: str, fields: dict) -> list[dict]:
    checks = [
        ("pan", fields.get("pan", "Not detected")),
        ("aadhaar", fields.get("aadhaar", "Not detected")),
    ]
    duplicates = []
    for app in state["applications"]:
        if app["id"] == current_app_id:
            continue
        identity = app.get("identity", {})
        for key, value in checks:
            if value == "Not detected":
                continue
            existing = identity.get(key, {}).get("fields", {}).get(key, "Not detected")
            if existing != "Not detected" and normalize_identifier(existing) == normalize_identifier(value):
                duplicates.append({
                    "field": key,
                    "matchAppId": app["id"],
                    "matchCustomer": app["customer"],
                    "message": f"Possible duplicate: {key.upper()} already exists in {app['id']} for {app['customer']}.",
                })
    return duplicates


def cross_verification_report(app: dict, doc_type: str, fields: dict, mismatches: list[dict], duplicates: list[dict]) -> dict:
    checks = []

    def add_check(name: str, status: str, detail: str) -> None:
        checks.append({"name": name, "status": status, "detail": detail})

    extracted_name = fields.get("name", "Not detected")
    if extracted_name != "Not detected" and is_real_person_or_business_name(app.get("customer", "")):
        app_name = normalize_name(app.get("customer", ""))
        doc_name = normalize_name(extracted_name)
        add_check(
            "Applicant name",
            "Matched" if app_name == doc_name or bool(set(app_name.split()) & set(doc_name.split())) else "Mismatch",
            f"Application: {app.get('customer', 'Unknown')} | Document: {extracted_name}",
        )
    else:
        add_check("Applicant name", "Not available", "Document did not provide a reliable applicant name.")

    identity = app.get("identity", {})
    for key, label in (("pan", "PAN"), ("aadhaar", "Aadhaar")):
        incoming = fields.get(key, "Not detected")
        saved = identity.get(key, {}).get("fields", {}).get(key, "Not detected")
        if incoming != "Not detected" and saved != "Not detected":
            status = "Matched" if normalize_identifier(incoming) == normalize_identifier(saved) else "Mismatch"
            add_check(label, status, f"Saved: {saved} | Document: {incoming}")
        elif incoming != "Not detected":
            add_check(label, "New evidence", f"{label} found in {doc_type}: {incoming}")
        elif saved != "Not detected":
            add_check(label, "Missing in document", f"Saved {label} exists, but this document did not contain it.")

    incoming_address = fields.get("address", "Not detected")
    saved_address = app.get("addressProfile", {}).get("address", "Not detected")
    if incoming_address != "Not detected" and saved_address != "Not detected":
        similarity = round(address_similarity(saved_address, incoming_address) * 100)
        add_check("Address", "Matched" if similarity >= 55 else "Mismatch", f"Similarity {similarity}%. Saved: {saved_address} | Document: {incoming_address}")
    elif incoming_address != "Not detected":
        add_check("Address", "New evidence", f"Reference address can be updated from {doc_type}.")
    elif saved_address != "Not detected":
        add_check("Address", "Missing in document", "Saved address exists, but this document did not contain a readable address.")

    if duplicates:
        add_check("Duplicate identity", "Review", "; ".join(item["message"] for item in duplicates[:3]))
    else:
        add_check("Duplicate identity", "Clear", "No duplicate PAN/Aadhaar found in existing application records.")

    mandatory_missing = [item["name"] for item in missingDocs_for_backend(app)]
    add_check("Required document set", "Incomplete" if mandatory_missing else "Complete", ", ".join(mandatory_missing) if mandatory_missing else "All mandatory documents are present.")

    status_order = {"Mismatch": 3, "Review": 2, "Incomplete": 1, "Missing in document": 1}
    worst = max((status_order.get(item["status"], 0) for item in checks), default=0)
    overall = "Failed" if worst >= 3 else "Review" if worst >= 1 else "Passed"
    return {
        "overall": overall,
        "checks": checks,
        "summary": f"{overall}: {len([item for item in checks if item['status'] == 'Matched'])} matched, {len([item for item in checks if item['status'] == 'Mismatch'])} mismatch, {len([item for item in checks if item['status'] in ('Review', 'Incomplete', 'Missing in document')])} review item(s).",
    }


def follow_up_message(app: dict) -> dict:
    missing = [doc["name"] for doc in missingDocs_for_backend(app)]
    if missing:
        body = f"Dear {app['customer']}, your {app['product']} application is pending {', '.join(missing)}. Please share it so we can complete your application."
    else:
        body = f"Dear {app['customer']}, your {app['product']} application documents are complete. We are moving it to the next review stage."
    return {
        "channel": "WhatsApp/SMS",
        "message": body,
        "callTask": f"Call {app['customer']} for {missing[0]}" if missing else f"Confirm next stage with {app['customer']}",
    }


def completion_blockers(state: dict, app: dict) -> list[str]:
    blockers = [f"{doc['name']} missing" for doc in missingDocs_for_backend(app)]
    review_count = len([item for item in state.get("reviewQueue", []) if item.get("appId") == app["id"]])
    if review_count:
        blockers.append(f"{review_count} document review item(s) open")
    open_flags = []
    for doc_item in app.get("documents", []):
        open_flags.extend(doc_item.get("flags", []))
    if open_flags:
        blockers.append(f"{len(open_flags)} validation flag(s) need manager approval")
    identity_status = app.get("identityConsistency", {}).get("status", "Clear")
    identity_mismatches = app.get("identityConsistency", {}).get("mismatches", [])
    if identity_status == "Blocked" and identity_mismatches:
        blockers.append(f"Identity cross-check blocked: {identity_mismatches[0].get('message', 'document mismatch detected')}")
    return blockers


def missingDocs_for_backend(app: dict) -> list[dict]:
    required = DEFAULT_RULES.get(app["product"], [])
    received = {doc["name"] for doc in app.get("documents", []) if doc.get("status") == "Received"}
    return [doc for doc in required if doc.get("mandatory") and doc["name"] not in received]


def ensure_task(app: dict, title: str, type_: str, owner: str, priority: str) -> None:
    app.setdefault("tasks", [])
    if any(item.get("title") == title and item.get("status") == "Open" for item in app["tasks"]):
        return
    app["tasks"].insert(0, task(title, type_, owner, TODAY, "Open", priority))


def maybe_create_operational_actions(app: dict, quality: dict, mismatches: list, duplicates: list) -> list[str]:
    actions = []
    follow = follow_up_message(app)
    if missingDocs_for_backend(app):
        ensure_task(app, follow["callTask"], "Follow-up", app["rm"], "High")
        actions.append("Follow-up task created")
    if quality["status"] != "Good":
        ensure_task(app, "Re-scan unclear document", "Document", app["rm"], "Medium")
        actions.append("Document quality task created")
    if mismatches:
        ensure_task(app, "Resolve identity mismatch", "Escalation", app.get("manager", app["rm"]), "High")
        actions.append("Identity mismatch escalation created")
    if duplicates:
        ensure_task(app, "Review possible duplicate applicant", "Escalation", app.get("manager", app["rm"]), "High")
        actions.append("Duplicate review escalation created")
    if daysSince(app.get("lastActivityAt", TODAY)) >= 3 or len(missingDocs_for_backend(app)) >= 2:
        ensure_task(app, "Manager review: stalled application", "Escalation", app.get("manager", app["rm"]), "High")
        actions.append("Manager escalation rule triggered")
    return actions


def analytics_snapshot(state: dict) -> dict:
    apps = state["applications"]
    active = [app for app in apps if app.get("stage") != "Completed"]
    at_risk = [app for app in active if backend_risk_score(app) >= 60]
    revenue_at_risk = sum(int(app.get("value", 0)) for app in at_risk)

    product_rows = []
    for product in sorted({app["product"] for app in apps}):
        product_apps = [app for app in apps if app["product"] == product]
        risk_apps = [app for app in product_apps if backend_risk_score(app) >= 60]
        top_missing = {}
        for app in product_apps:
            for doc_rule in missingDocs_for_backend(app):
                top_missing[doc_rule["name"]] = top_missing.get(doc_rule["name"], 0) + 1
        product_rows.append({
            "product": product,
            "applications": len(product_apps),
            "atRisk": len(risk_apps),
            "valueAtRisk": sum(int(app.get("value", 0)) for app in risk_apps),
            "topLeakageDriver": max(top_missing, key=top_missing.get) if top_missing else "None",
        })

    rm_rows = []
    for rm in sorted({app["rm"] for app in apps}):
        rm_apps = [app for app in apps if app["rm"] == rm]
        rm_rows.append({
            "rm": rm,
            "applications": len(rm_apps),
            "openTasks": sum(len([task for task in app.get("tasks", []) if task.get("status") == "Open"]) for app in rm_apps),
            "avgCompletion": round(sum(backend_completion_score(app) for app in rm_apps) / max(1, len(rm_apps))),
            "highRisk": len([app for app in rm_apps if backend_risk_score(app) >= 60]),
        })

    branch_rows = []
    for branch in sorted({app["branch"] for app in apps}):
        branch_apps = [app for app in apps if app["branch"] == branch]
        missing_counts = {}
        for app in branch_apps:
            for doc_rule in missingDocs_for_backend(app):
                missing_counts[doc_rule["name"]] = missing_counts.get(doc_rule["name"], 0) + 1
        branch_rows.append({
            "branch": branch,
            "applications": len(branch_apps),
            "avgSlaDays": round(sum(daysSince(app.get("createdAt", TODAY)) for app in branch_apps) / max(1, len(branch_apps)), 1),
            "atRisk": len([app for app in branch_apps if backend_risk_score(app) >= 60]),
            "bottleneck": max(missing_counts, key=missing_counts.get) if missing_counts else "None",
        })

    sla_rows = [{
        "appId": app["id"],
        "customer": app["customer"],
        "stage": app.get("stage", "Document Collection"),
        "ageDays": daysSince(app.get("createdAt", TODAY)),
        "idleDays": daysSince(app.get("lastActivityAt", TODAY)),
        "status": "Breached" if daysSince(app.get("lastActivityAt", TODAY)) >= 3 or daysSince(app.get("createdAt", TODAY)) >= 10 else "On track",
    } for app in active]

    root_counts = {}
    for app in active:
        missing = missingDocs_for_backend(app)
        if missing:
            reason = f"{missing[0]['name']} delay"
        elif daysSince(app.get("lastActivityAt", TODAY)) >= 3:
            reason = "RM follow-up delay"
        else:
            reason = "Approval/document review delay"
        root_counts[reason] = root_counts.get(reason, 0) + 1
    root_causes = [{"reason": reason, "count": count, "share": round(count / max(1, len(active)) * 100)} for reason, count in sorted(root_counts.items(), key=lambda item: item[1], reverse=True)]

    customer_risk = [{
        "appId": app["id"],
        "customer": app["customer"],
        "risk": backend_risk_score(app),
        "completionLikelihood": max(5, 100 - backend_risk_score(app)),
        "reason": ", ".join([doc["name"] for doc in missingDocs_for_backend(app)]) or "Progressing",
    } for app in sorted(active, key=backend_risk_score, reverse=True)]

    return {
        "revenueAtRisk": revenue_at_risk,
        "atRiskApplications": len(at_risk),
        "activeApplications": len(active),
        "managerEscalations": sum(len([task for task in app.get("tasks", []) if task.get("type") == "Escalation" and task.get("status") == "Open"]) for app in apps),
        "productLeakage": product_rows,
        "rmProductivity": rm_rows,
        "branchHeatmap": branch_rows,
        "sla": sla_rows,
        "rootCauses": root_causes,
        "customerRisk": customer_risk,
    }


def backend_completion_score(app: dict) -> int:
    docs = DEFAULT_RULES.get(app["product"], [])
    received = {doc["name"] for doc in app.get("documents", []) if doc.get("status") == "Received"}
    total = sum(doc["weight"] for doc in docs) or 1
    doc_score = sum(doc["weight"] for doc in docs if doc["name"] in received) / total * 55
    stage_score = {"Lead Captured": 6, "Document Collection": 14, "Verification": 26, "Approval": 36, "Disbursement": 42, "Completed": 45}.get(app.get("stage"), 10)
    follow_score = max(0, 12 - daysSince(app.get("lastActivityAt", TODAY)) * 2)
    return min(100, round(doc_score + stage_score + follow_score))


def backend_risk_score(app: dict) -> int:
    missing_penalty = sum(max(8, doc["weight"]) for doc in missingDocs_for_backend(app))
    stale_penalty = daysSince(app.get("lastActivityAt", TODAY)) * 9
    overdue = len([item for item in app.get("tasks", []) if item.get("status") == "Open" and item.get("dueDate", TODAY) < TODAY]) * 12
    intent = -8 if app.get("customerIntent") == "Hot" else 10 if app.get("customerIntent") == "Cold" else 0
    identity_penalty = 35 if app.get("identityConsistency", {}).get("status") == "Blocked" else 12 if app.get("identityConsistency", {}).get("status") == "Review" else 0
    return max(0, min(100, round(missing_penalty + stale_penalty + overdue + intent + identity_penalty)))


def process_scan_payload(payload: dict, use_cache: bool = True) -> dict:
    state = get_state()
    app = find_app(state, payload.get("appId", ""))
    if not app:
        return {"ok": False, "error": "Application not found", "status": HTTPStatus.NOT_FOUND}
    if not payload.get("customerUpload") and not can_mutate_app(state, app):
        return {"ok": False, "error": "You do not have permission to modify this application", "status": HTTPStatus.FORBIDDEN}

    input_text = str(payload.get("text", ""))
    file_data = str(payload.get("fileData", ""))
    expected_doc = str(payload.get("expectedDoc", ""))
    filename = str(payload.get("filename", ""))
    cache_key = document_hash(app["id"], filename, input_text, file_data, expected_doc)
    cached = get_cached_result(cache_key) if use_cache else None
    if cached:
        cached["cached"] = True
        return cached

    ocr_text = ""
    ocr_info = {"status": "Not used", "message": "Typed or pasted document text was used."}
    if file_data:
        ocr_text, ocr_info = ocr_image_from_payload(payload)
    document_text = f"{input_text} {ocr_text}".strip()
    source = f"{filename} {document_text}"
    doc_type = detect_document_type(source)
    if expected_doc in DOCUMENT_FIELD_REQUIREMENTS or any(expected_doc == rule["name"] for rules in state["rules"].values() for rule in rules):
        doc_type = expected_doc
    ai = document_ai_middleware(document_text, doc_type)
    doc_type = ai["docType"]
    fields = ai["fields"]
    ocr = ocr_info if ocr_text or file_data else ocr_status(payload, fields)
    preprocess = preprocessing_report(filename, document_text, file_data)
    quality = document_quality_assessment(filename, document_text, ocr, ai)
    confidence_by_field = field_confidence(fields, ai, quality)
    mismatches = mismatch_detection(app, doc_type, fields)
    detected_doc_type = ai.get("detectedDocType", doc_type)
    if expected_doc and detected_doc_type not in ("", "Unknown Document", expected_doc) and expected_doc != detected_doc_type:
        mismatches.append({
            "field": "document_type",
            "severity": "High",
            "message": f"Wrong document uploaded: expected {expected_doc}, but OCR classified the scan as {detected_doc_type}.",
            "reference": expected_doc,
            "incoming": detected_doc_type,
            "docType": doc_type,
        })
    duplicates = duplicate_detection(state, app["id"], fields)
    cross_verification = cross_verification_report(app, doc_type, fields, mismatches, duplicates)
    validation_flags = validate_document_content(document_text, doc_type, fields, expected_doc)
    validation_flags.extend(mismatch_flags(mismatches))
    confidence = max(confidence_for(doc_type, fields), ai["confidence"])
    identity = verify_identity(doc_type, fields)
    needed = any(rule["name"] == doc_type for rule in state["rules"].get(app["product"], []))
    blocking_flags = [flag for flag in validation_flags if flag["severity"] == "High"]
    scan_id = persist_scan_record(app["id"], doc_type, filename, fields, ai, quality, validation_flags)
    preview_payload = {
        "filename": filename,
        "previewDataUrl": file_data if file_data.startswith("data:") else "",
        "previewMime": file_data[5:].split(";")[0] if file_data.startswith("data:") else "",
    }

    if needed and confidence >= 75 and quality["score"] >= 45 and not mismatches and not blocking_flags:
        existing = next((item for item in app["documents"] if item["name"] == doc_type), None)
        payload_doc = {"id": new_id(), "scanId": scan_id, "name": doc_type, "status": "Received", "confidence": confidence, "uploadedAt": TODAY, "extracted": fields, "fieldConfidence": confidence_by_field, "ai": ai, "quality": quality, "flags": validation_flags, "crossVerification": cross_verification, **preview_payload}
        if existing:
            existing.update(payload_doc)
            document_key = existing.get("id") or existing.get("name")
        else:
            app["documents"].append(payload_doc)
            document_key = payload_doc["id"]
        result = "attached"
        review_id = ""
    else:
        review_id = new_id()
        document_key = ""
        state["reviewQueue"].insert(0, {
            "id": review_id,
            "appId": app["id"],
            "customer": app["customer"],
            "docType": doc_type,
            "confidence": confidence,
            "fields": fields,
            "fieldConfidence": confidence_by_field,
            "ai": ai,
            "quality": quality,
            "flags": validation_flags,
            "mismatches": mismatches,
            "duplicates": duplicates,
            "crossVerification": cross_verification,
            **preview_payload,
            "reason": blocking_flags[0]["message"] if blocking_flags else "Identity mismatch" if mismatches else "Low scan quality" if quality["score"] < 45 else "Low confidence" if needed else "Document not required for selected product",
            "createdAt": TODAY,
        })
        result = "review"

    for flag in validation_flags:
        create_notification(state, app["id"], f"{doc_type} validation flag", flag["message"], flag["severity"])
    if identity["status"] == "Verified":
        if is_real_person_or_business_name(fields.get("name", "")) and not mismatches:
            app["customer"] = fields["name"]
        app["identity"] = {
            **app.get("identity", {}),
            doc_type.lower(): {
                "status": identity["status"],
                "fields": fields,
                "fieldConfidence": confidence_by_field,
                "verifiedAt": TODAY,
                "provider": identity["provider"],
            },
        }
    update_identity_consistency(app, doc_type, fields, mismatches, detected_doc_type)
    update_address_profile(app, doc_type, fields, mismatches)
    follow_up = follow_up_message(app)
    actions = maybe_create_operational_actions(app, quality, mismatches, duplicates)
    app["lastActivityAt"] = TODAY
    app.setdefault("timeline", []).insert(0, f"{TODAY} - Backend scan {result}: {doc_type}")
    app.setdefault("timeline", []).insert(0, f"{TODAY} - AI middleware: {ai['status']} ({ai['layout']}, {ai['confidence']}%)")
    if mismatches:
        app.setdefault("timeline", []).insert(0, f"{TODAY} - Mismatch flagged: {mismatches[0]['field']}")
    if duplicates:
        app.setdefault("timeline", []).insert(0, f"{TODAY} - Duplicate warning: {duplicates[0]['matchAppId']}")
    if validation_flags:
        app.setdefault("timeline", []).insert(0, f"{TODAY} - Validation flags raised: {len(validation_flags)}")
    save_state(state, f"Document scan {result}: {doc_type}")

    response = {
        "ok": True,
        "cached": False,
        "result": result,
        "appId": app["id"],
        "reviewId": review_id,
        "documentKey": document_key,
        "docType": doc_type,
        "fields": fields,
        "fieldConfidence": confidence_by_field,
        "identity": identity,
        "ocr": ocr,
        "preprocess": preprocess,
        "ai": ai,
        "quality": quality,
        "flags": validation_flags,
        "mismatches": mismatches,
        "duplicates": duplicates,
        "crossVerification": cross_verification,
        "identityConsistency": app.get("identityConsistency", {}),
        "followUp": follow_up,
        "actions": actions,
        "analytics": analytics_snapshot(state),
        "ocrTextPreview": source[:500],
        "confidence": confidence,
        "state": state,
    }
    put_cached_result(cache_key, response)
    return response


def extract_fields(source: str, expected_doc: str = "") -> dict:
    pan = re.search(r"[A-Z]{5}[0-9]{4}[A-Z]", source, re.I)
    gst = re.search(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]", source, re.I)
    aadhaar = re.search(r"\b[0-9]{4}\s?[0-9]{4}\s?[0-9]{4}\b", source)
    name = re.search(r"(?:name|customer|applicant|account holder|holder name)\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60}?)(?=\s+(?:father|father's name|dob|date of birth|pan|aadhaar|gstin|communication address|address)\b|$)", source, re.I)
    dob = re.search(r"(?:dob|date of birth|oate birth|date birth|birth)\s*[:\-]?\s*([0-9]{1,2}[/-][0-9]{2}[/-][0-9]{4})", source, re.I)
    if not dob and (expected_doc == "Aadhaar" or aadhaar) and re.search(r"\b(?:male|female)\b", source, re.I):
        dob = re.search(r"\b([0-9]{2}[/-][0-9]{2}[/-][0-9]{4})\b", source)
    mobile = re.search(r"(?:mobile|mobile no|phone)\s*(?:no\.?|number)?\s*[:\-]?\s*(?:\+91\s*)?([6-9][0-9]{9})", source, re.I)
    if not mobile:
        mobile = re.search(r"\b(?:\+91\s*)?([6-9][0-9]{9})\b", source)
    gender = "Not detected"
    if re.search(r"\bfemale\b", source, re.I):
        gender = "Female"
    elif re.search(r"\bmale\b", source, re.I):
        gender = "Male"
    inferred_name = "Not detected"
    if expected_doc == "PAN":
        inferred_name = infer_pan_name(source)
    if inferred_name == "Not detected" and expected_doc == "Aadhaar":
        inferred_name = infer_aadhaar_name(source)
    if inferred_name == "Not detected" and name:
        inferred_name = clean_extracted_name(name.group(1))
    if expected_doc not in ("PAN", "Aadhaar") and not pan and not aadhaar and inferred_name == "Not detected":
        holder = re.search(r"(?:account holder|holder name)\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60}?)(?=\s+(?:communication address|address|pan|aadhaar|gstin)\b|$)", source, re.I)
        if holder:
            inferred_name = clean_extracted_name(holder.group(1))
    if inferred_name == "Not detected" and (expected_doc in ("PAN", "Aadhaar") or aadhaar or (pan and expected_doc == "PAN")):
        inferred_name = infer_name_from_document(source)
    address = infer_address_from_document(source, expected_doc)
    return {
        "pan": pan.group(0).upper() if pan else "Not detected",
        "gstin": gst.group(0).upper() if gst else "Not detected",
        "aadhaar": aadhaar.group(0) if aadhaar else "Not detected",
        "name": inferred_name,
        "dob": normalize_date_value(dob.group(1)) if dob else "Not detected",
        "mobile": mobile.group(1) if mobile else "Not detected",
        "gender": gender,
        "address": address,
    }


def clean_extracted_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z .]", " ", value or "")
    value = re.sub(r"\b(?:name|customer|applicant|father|father's|dob|date|birth)\b", " ", value, flags=re.I)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value if is_real_person_or_business_name(value) else "Not detected"


def normalize_date_value(value: str) -> str:
    match = re.fullmatch(r"([0-9]{1,2})([/-])([0-9]{2})([/-])([0-9]{4})", str(value or "").strip())
    if not match:
        return value
    day, _, month, _, year = match.groups()
    return f"{int(day):02d}/{month}/{year}"


def infer_pan_name(source: str) -> str:
    normalized = source.replace("\r", "\n")
    normalized = re.sub(r"[|]", "\n", normalized)
    lines = [re.sub(r"[^A-Za-z0-9 .'/]", " ", line).strip() for line in normalized.splitlines()]
    lines = [re.sub(r"\s+", " ", line) for line in lines if line.strip()]

    compact = re.sub(r"\s+", " ", normalized)
    for match in re.finditer(r"\bname\s*[:\-]?\s+([A-Z][A-Z .]{4,80}?)(?=\s*/?\s*(?:father|father's|date|oate|dob|permanent account|$))", compact, re.I):
        prefix = compact[max(0, match.start() - 18):match.start()].lower()
        if "father" in prefix:
            continue
        cleaned = clean_extracted_name(match.group(1))
        if cleaned != "Not detected":
            return cleaned

    for index, line in enumerate(lines):
        if re.fullmatch(r"name", line, re.I):
            for candidate in lines[index + 1:index + 4]:
                cleaned = clean_extracted_name(candidate)
                if cleaned != "Not detected":
                    return cleaned

        inline = re.search(r"\bname\s*[:\-]?\s+([A-Za-z][A-Za-z .]{2,60}?)(?=\s+(?:father|father's|dob|date of birth|permanent|account|number)\b|$)", line, re.I)
        if inline:
            cleaned = clean_extracted_name(inline.group(1))
            if cleaned != "Not detected":
                return cleaned

    blocked = (
        "income tax", "department", "government", "govt", "india", "permanent account",
        "account number", "signature", "father", "date of birth", "dob", "pan card",
        "whatsapp", "image", "download", "scan"
    )
    for line in lines:
        low = line.lower()
        if any(word in low for word in blocked):
            continue
        if re.search(r"[A-Z]{5}[0-9]{4}[A-Z]|\d", line, re.I):
            continue
        cleaned = clean_extracted_name(line)
        if cleaned != "Not detected":
            return cleaned
    return "Not detected"


def infer_aadhaar_name(source: str) -> str:
    normalized = source.replace("\r", "\n")
    lines = [re.sub(r"[^A-Za-z0-9 ./:-]", " ", line).strip() for line in normalized.splitlines()]
    lines = [re.sub(r"\s+", " ", line) for line in lines if line.strip()]
    blocked = (
        "government", "govt", "india", "unique identification", "authority", "uidai",
        "aadhaar", "aadhar", "vid", "address", "dob", "date of birth", "year of birth",
        "male", "female", "download", "whatsapp", "image", "scan"
    )

    for index, line in enumerate(lines):
        if re.search(r"\b(?:name|applicant|customer)\b", line, re.I):
            inline = re.search(r"\b(?:name|applicant|customer)\b\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60})", line, re.I)
            if inline:
                cleaned = clean_extracted_name(inline.group(1))
                if cleaned != "Not detected":
                    return cleaned
            for candidate in lines[index + 1:index + 4]:
                cleaned = clean_extracted_name(candidate)
                if cleaned != "Not detected":
                    return cleaned

    markers = []
    for index, line in enumerate(lines):
        if re.search(r"\b(?:dob|date of birth|yob|year of birth|male|female)\b", line, re.I):
            markers.append(index)
        if re.search(r"\b[0-9]{4}\s?[0-9]{4}\s?[0-9]{4}\b", line):
            markers.append(index)
    for marker in markers:
        for candidate in reversed(lines[max(0, marker - 4):marker]):
            low = candidate.lower()
            if any(word in low for word in blocked):
                continue
            if re.search(r"\d|[:/]", candidate):
                continue
            cleaned = clean_extracted_name(candidate)
            if cleaned != "Not detected":
                return cleaned
    return "Not detected"


def infer_name_from_document(source: str) -> str:
    compact = re.sub(r"\s+", " ", source)
    compact = re.sub(r"\b[\w\- ]+\.(?:pdf|jpg|jpeg|png)\b", " ", compact, flags=re.I)
    compact = re.sub(r"\b\w*(?:gov|gmernment|government|lndia|india|uidai|whatsapp|image|download|scan)\w*\b", " ", compact, flags=re.I)
    dob_match = re.search(r"(?:dob|date of birth|yob|year of birth)", compact, re.I)
    if dob_match:
        prefix = compact[max(0, dob_match.start() - 120):dob_match.start()]
        prefix = re.sub(r"government of india|unique identification authority of india|uidai|aadhaar|aadhar|male|female", " ", prefix, flags=re.I)
        candidates = re.findall(r"[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,}){0,4}|[A-Z]{3,}(?:\s+[A-Z]{3,}){1,4}", prefix)
        if candidates:
            cleaned = clean_extracted_name(candidates[-1])
            if cleaned != "Not detected":
                return cleaned

    gender_or_number = re.search(r"\b(?:male|female)\b|\b[0-9]{4}\s?[0-9]{4}\s?[0-9]{4}\b", compact, re.I)
    if gender_or_number:
        prefix = compact[max(0, gender_or_number.start() - 120):gender_or_number.start()]
        prefix = re.sub(r"aadhaar|aadhar|uidai|dob|date of birth|yob|year of birth", " ", prefix, flags=re.I)
        prefix = re.sub(r"\b\S*[0-9]\S*\b", " ", prefix)
        prefix = re.sub(r"\b\w*(?:gov|gmernment|government|lndia|india|whatsapp|image|download|scan)\w*\b", " ", prefix, flags=re.I)
        candidates = re.findall(r"[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,}){1,4}|[A-Z]{3,}(?:\s+[A-Z]{3,}){1,4}", prefix)
        if candidates:
            cleaned = clean_extracted_name(candidates[-1])
            if cleaned != "Not detected":
                return cleaned

    stop_words = {
        "government of india", "unique identification authority", "uidai", "aadhaar", "aadhar",
        "male", "female", "dob", "date of birth", "year of birth", "address", "india", "vid",
        "income tax department", "permanent account number", "signature",
        "whatsapp", "image", "pdf", "jpg", "jpeg", "png", "download", "scan"
    }
    lines = [re.sub(r"[^A-Za-z .]", " ", line).strip() for line in source.splitlines()]
    lines = [re.sub(r"\s+", " ", line) for line in lines if line.strip()]
    for line in lines:
        low = line.lower()
        if any(word in low for word in stop_words):
            continue
        if len(line) < 4 or len(line) > 60:
            continue
        words = line.split()
        if 2 <= len(words) <= 5 and all(word[:1].isupper() for word in words if word):
            return line
    return "Not detected"


def clean_extracted_address(value: str) -> str:
    value = re.sub(r"\b(?:address|addr|residence|residential|permanent|communication|present)\b\s*[:\-]?", " ", value or "", flags=re.I)
    value = re.sub(r"\b(?:mobile|phone|email|dob|date of birth|pan|aadhaar|aadhar|gstin|signature)\b.*$", " ", value, flags=re.I)
    value = re.sub(r"[^A-Za-z0-9,./#() -]", " ", value)
    value = re.sub(r"\s+", " ", value).strip(" ,.-")
    if len(address_tokens(value)) < 3:
        return "Not detected"
    return value[:220]


def infer_address_from_document(source: str, expected_doc: str = "") -> str:
    normalized = source.replace("\r", "\n")
    lines = [re.sub(r"\s+", " ", line).strip() for line in normalized.splitlines()]
    lines = [line for line in lines if line]
    markers = (
        "address", "addr", "residence", "residential address", "permanent address",
        "communication address", "present address", "principal place", "place of business",
        "registered office", "billing address", "property address"
    )
    stop_pattern = re.compile(r"\b(?:mobile|phone|email|dob|date of birth|pan|aadhaar|aadhar|gstin|signature|father|name)\b", re.I)

    for index, line in enumerate(lines):
        lower = line.lower()
        if any(marker in lower for marker in markers):
            inline = re.sub(r".*?(?:address|addr|residence|principal place|place of business|registered office|billing address|property address)\s*[:\-]?", "", line, flags=re.I)
            candidates = []
            if inline and inline != line:
                candidates.append(inline)
            for candidate in lines[index + 1:index + 5]:
                if stop_pattern.search(candidate):
                    break
                candidates.append(candidate)
            cleaned = clean_extracted_address(" ".join(candidates))
            if cleaned != "Not detected":
                return cleaned

    pin_match = re.search(r"\b[1-9][0-9]{5}\b", source)
    if pin_match and (expected_doc in ADDRESS_BEARING_DOCS or re.search(r"\b(?:address|road|street|nagar|colony|apartment|village|district|state)\b", source, re.I)):
        compact = re.sub(r"\s+", " ", source)
        window = compact[max(0, pin_match.start() - 160):min(len(compact), pin_match.end() + 40)]
        cleaned = clean_extracted_address(window)
        if cleaned != "Not detected":
            return cleaned

    return "Not detected"


def verify_identity(doc_type: str, fields: dict) -> dict:
    # Replace this adapter with a real Aadhaar/PAN MCP or bank-approved KYC provider.
    if doc_type == "PAN" and fields.get("pan") != "Not detected":
        verified = ["pan"]
        if fields.get("name") != "Not detected":
            verified.append("name")
        return {
            "provider": "KYC MCP adapter",
            "status": "Verified",
            "verifiedFields": verified,
            "message": "PAN format verified. Ready to connect to live PAN verification MCP.",
            "verificationUrl": "https://www.incometaxindia.gov.in/",
        }
    if doc_type == "Aadhaar" and fields.get("aadhaar") != "Not detected":
        verified = ["aadhaar"]
        if fields.get("name") != "Not detected":
            verified.append("name")
        if fields.get("dob") != "Not detected":
            verified.append("dob")
        return {
            "provider": "KYC MCP adapter",
            "status": "Verified",
            "verifiedFields": verified,
            "message": "Aadhaar format verified. Ready to connect to live Aadhaar verification MCP.",
            "verificationUrl": "https://uidai.gov.in/en/",
        }
    return {
        "provider": "KYC MCP adapter",
        "status": "Not applicable",
        "verifiedFields": [],
        "message": "No PAN/Aadhaar identifier found for identity verification.",
        "verificationUrl": "",
    }


def is_real_person_or_business_name(value: str) -> bool:
    if not value or value == "Not detected":
        return False
    low = value.lower()
    blocked = ["whatsapp", "image", "jpg", "jpeg", "png", "pdf", "download", "scan"]
    if any(word in low for word in blocked):
        return False
    if re.search(r"[0-9]{4}|[:_/\\]", value):
        return False
    return len(value.split()) >= 2


def ocr_status(payload: dict, fields: dict) -> dict:
    filename = str(payload.get("filename", ""))
    text = str(payload.get("text", ""))
    has_fields = any(fields.get(key) != "Not detected" for key in ("pan", "aadhaar", "gstin", "name", "dob"))
    if text.strip() and has_fields:
        return {"status": "Text extracted", "message": "Document text was read and fields were extracted automatically."}
    if text.strip():
        return {"status": "Text read", "message": "Document text was read, but key identity fields were not detected."}
    if filename:
        return {"status": "OCR adapter needed", "message": "File was received, but image/PDF OCR requires a real OCR provider such as Azure Document Intelligence, Textract, or Document AI."}
    return {"status": "No file", "message": "No document content was provided."}


def decode_data_url(data_url: str) -> tuple[bytes, str]:
    if not data_url:
        return b"", ""
    header, _, encoded = data_url.partition(",")
    mime = ""
    if header.startswith("data:"):
        mime = header[5:].split(";")[0]
    return base64.b64decode(encoded), mime


def png_dimensions(raw: bytes) -> tuple[int, int] | None:
    if raw.startswith(b"\x89PNG\r\n\x1a\n") and len(raw) >= 24:
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    return None


def jpeg_dimensions(raw: bytes) -> tuple[int, int] | None:
    if not raw.startswith(b"\xff\xd8"):
        return None
    index = 2
    while index + 9 < len(raw):
        if raw[index] != 0xFF:
            index += 1
            continue
        marker = raw[index + 1]
        index += 2
        if marker in (0xD8, 0xD9):
            continue
        if index + 2 > len(raw):
            break
        size = int.from_bytes(raw[index:index + 2], "big")
        if size < 2 or index + size > len(raw):
            break
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height = int.from_bytes(raw[index + 3:index + 5], "big")
            width = int.from_bytes(raw[index + 5:index + 7], "big")
            return width, height
        index += size
    return None


def upload_profile_from_data_url(file_data: str, filename: str = "") -> dict:
    if not file_data:
        return {"type": "none", "orientation": "Not applicable", "scaling": "No file uploaded"}
    try:
        raw, mime = decode_data_url(file_data)
    except Exception:
        return {"type": "unknown", "orientation": "Unknown", "scaling": "Unable to inspect upload"}
    suffix = Path(filename or "").suffix.lower()
    size_mb = round(len(raw) / 1024 / 1024, 2)
    dimensions = png_dimensions(raw) or jpeg_dimensions(raw)
    if dimensions:
        width, height = dimensions
        if height > width * 1.08:
            orientation = "Vertical / portrait"
        elif width > height * 1.08:
            orientation = "Horizontal / landscape"
        else:
            orientation = "Square / near-square"
        longest = max(width, height)
        if longest > 2400:
            scaling = "Large image; downscale to 1600-2000 px before production OCR"
        elif longest < 900:
            scaling = "Small image; capture closer for OCR"
        else:
            scaling = "OCR-safe size"
        return {
            "type": mime or suffix.lstrip(".") or "image",
            "bytes": len(raw),
            "sizeMb": size_mb,
            "width": width,
            "height": height,
            "orientation": orientation,
            "scaling": scaling,
            "aspectRatio": round(width / max(1, height), 2),
        }
    if mime == "application/pdf" or suffix == ".pdf":
        pages = "Unknown"
        try:
            from pypdf import PdfReader
            pages = len(PdfReader(BytesIO(raw)).pages)
        except Exception:
            pass
        return {
            "type": "application/pdf",
            "bytes": len(raw),
            "sizeMb": size_mb,
            "pages": pages,
            "orientation": "PDF pages; rendered before OCR",
            "scaling": "PDF render scale 3x for OCR",
        }
    return {
        "type": mime or suffix.lstrip(".") or "unknown",
        "bytes": len(raw),
        "sizeMb": size_mb,
        "orientation": "Unknown",
        "scaling": "Unsupported image metadata; OCR will still attempt processing",
    }


def ocr_image_from_payload(payload: dict) -> tuple[str, dict]:
    data_url = payload.get("fileData") or ""
    if not data_url:
        return "", {"status": "No OCR file", "message": "No image data was sent for OCR."}
    raw, mime = decode_data_url(data_url)
    filename = str(payload.get("filename") or "upload.png")
    suffix = Path(filename).suffix.lower() or ".png"
    if mime == "application/pdf" or suffix == ".pdf":
        return ocr_pdf_bytes(raw)
    if not mime.startswith("image/") and suffix not in (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"):
        return "", {"status": "Unsupported OCR file", "message": "Only image OCR is connected locally right now."}
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    image_path = UPLOAD_DIR / f"{uuid.uuid4().hex}{suffix}"
    image_path.write_bytes(raw)
    candidates = [(image_path, "original")]
    try:
        from PIL import Image, ImageEnhance, ImageFilter, ImageOps
        with Image.open(image_path) as img:
            base = ImageOps.exif_transpose(img).convert("RGB")
            variants = [
                (base, "exif-normalized"),
                (base.rotate(90, expand=True), "rotated 90"),
                (base.rotate(180, expand=True), "rotated 180"),
                (base.rotate(270, expand=True), "rotated 270"),
            ]
            for variant, label in variants:
                longest = max(variant.size)
                if longest < 1800:
                    scale = 1800 / max(1, longest)
                    variant = variant.resize((round(variant.width * scale), round(variant.height * scale)))
                gray = ImageOps.grayscale(variant)
                enhanced_variants = [
                    (ImageEnhance.Contrast(variant).enhance(1.45), f"{label} contrast"),
                    (ImageOps.autocontrast(gray).filter(ImageFilter.SHARPEN), f"{label} grayscale sharpen"),
                    (ImageEnhance.Contrast(ImageOps.autocontrast(gray)).enhance(2.2), f"{label} high contrast grayscale"),
                    (ImageOps.autocontrast(gray).point(lambda pixel: 255 if pixel > 150 else 0), f"{label} threshold"),
                ]
                for enhanced, enhanced_label in enhanced_variants:
                    variant_path = UPLOAD_DIR / f"{uuid.uuid4().hex}.png"
                    enhanced.save(variant_path)
                    candidates.append((variant_path, enhanced_label))
    except Exception:
        pass

    best_text = ""
    best_label = "original"
    best_info = {"status": "OCR empty", "message": "OCR did not detect readable text."}
    for candidate_path, label in candidates:
        text, info = run_windows_ocr(candidate_path)
        score = len(text.strip())
        if re.search(r"\b[0-9]{4}\s?[0-9]{4}\s?[0-9]{4}\b", text):
            score += 80
        if re.search(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b", text, re.I):
            score += 80
        if re.search(r"\b(?:dob|date of birth|male|female|mobile)\b", text, re.I):
            score += 40
        if re.search(r"\b(?:name|father|income tax|government of india|aadhaar|aadhar|permanent account)\b", text, re.I):
            score += 35
        best_score = len(best_text.strip())
        if re.search(r"\b[0-9]{4}\s?[0-9]{4}\s?[0-9]{4}\b", best_text):
            best_score += 80
        if re.search(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b", best_text, re.I):
            best_score += 80
        if re.search(r"\b(?:dob|date of birth|male|female|mobile)\b", best_text, re.I):
            best_score += 40
        if re.search(r"\b(?:name|father|income tax|government of india|aadhaar|aadhar|permanent account)\b", best_text, re.I):
            best_score += 35
        if score > best_score:
            best_text = text
            best_label = label
            best_info = info
    if best_text.strip():
        return best_text, {
            "status": best_info.get("status", "OCR extracted"),
            "message": f"Windows OCR read the uploaded image using auto-rotation/enhancement ({best_label}).",
            "orientationAttempt": best_label,
            "attempts": len(candidates),
        }
    return "", {
        "status": "OCR empty",
        "message": f"OCR tried {len(candidates)} orientation/enhancement pass(es), but no readable text was detected. Capture the card flatter and closer.",
        "attempts": len(candidates),
    }


def run_windows_ocr(image_path: Path) -> tuple[str, dict]:
    acquired = OCR_SEMAPHORE.acquire(timeout=10)
    if not acquired:
        return "", {"status": "OCR busy", "message": "OCR workers are busy. Please retry or use scan queue."}
    try:
        completed = subprocess.run(
            ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(OCR_SCRIPT), "-ImagePath", str(image_path)],
            capture_output=True,
            text=True,
            timeout=OCR_TIMEOUT_SECONDS,
        )
        text = (completed.stdout or "").strip()
        if completed.returncode != 0:
            return "", {"status": "OCR failed", "message": (completed.stderr or "Windows OCR failed.").strip()[:300]}
        return text, {"status": "OCR extracted", "message": f"Windows OCR read the uploaded image automatically using {OCR_WORKERS} OCR worker slot(s)."}
    except Exception as exc:
        return "", {"status": "OCR failed", "message": str(exc)}
    finally:
        OCR_SEMAPHORE.release()


def ocr_pdf_bytes(raw: bytes) -> tuple[str, dict]:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    pdf_path = UPLOAD_DIR / f"{uuid.uuid4().hex}.pdf"
    pdf_path.write_bytes(raw)
    text_parts = []

    try:
        from pypdf import PdfReader
        reader = PdfReader(str(pdf_path))
        for page in reader.pages[:3]:
            page_text = page.extract_text() or ""
            if page_text.strip():
                text_parts.append(page_text)
        if "\n".join(text_parts).strip():
            return "\n".join(text_parts), {"status": "PDF text extracted", "message": "Text was extracted directly from the PDF."}
    except Exception:
        pass

    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(str(pdf_path))
        for index in range(min(2, len(pdf))):
            page = pdf[index]
            bitmap = page.render(scale=3).to_pil()
            image_path = UPLOAD_DIR / f"{uuid.uuid4().hex}.png"
            bitmap.save(image_path)
            text, _ = run_windows_ocr(image_path)
            if text.strip():
                text_parts.append(text)
        if "\n".join(text_parts).strip():
            return "\n".join(text_parts), {"status": "PDF OCR extracted", "message": "PDF page was rendered and read with Windows OCR."}
    except Exception as exc:
        return "", {"status": "PDF OCR failed", "message": str(exc)}

    return "", {"status": "PDF OCR empty", "message": "PDF was processed, but OCR did not detect readable text. Try a clearer scan."}


def confidence_for(doc_type: str, fields: dict) -> int:
    if doc_type == "Unknown Document":
        return 35
    has_strong_field = any(fields[key] != "Not detected" for key in ("pan", "gstin", "aadhaar"))
    return 96 if has_strong_field else 82


def json_response(handler: SimpleHTTPRequestHandler, payload: dict, status: int = 200) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Key")
    handler.end_headers()
    handler.wfile.write(body)


def begin_request() -> None:
    global ACTIVE_REQUESTS, TOTAL_REQUESTS
    now = time.time()
    with METRICS_LOCK:
        ACTIVE_REQUESTS += 1
        TOTAL_REQUESTS += 1
        REQUEST_TIMESTAMPS.append(now)


def end_request() -> None:
    global ACTIVE_REQUESTS
    with METRICS_LOCK:
        ACTIVE_REQUESTS = max(0, ACTIVE_REQUESTS - 1)


def adaptive_capacity_plan(uploads_per_minute: int) -> dict:
    uploads = max(0, uploads_per_minute)
    needed_workers = max(8, min(512, round(uploads / 3) or OCR_WORKERS))
    if uploads <= OCR_WORKERS * 2:
        status = "Healthy"
        recommendation = "Current OCR worker pool can absorb the expected upload rate."
    elif uploads <= OCR_WORKERS * 4:
        status = "Watch"
        recommendation = "Current pool can handle the rate, but queue monitoring should be enabled."
    else:
        status = "Scale required"
        recommendation = f"Increase OCR workers to about {needed_workers} or add queue-backed worker nodes."
    return {
        "expectedUploadsPerMinute": uploads,
        "currentOcrWorkers": OCR_WORKERS,
        "recommendedOcrWorkers": needed_workers,
        "status": status,
        "recommendation": recommendation,
        "autoscaleRule": "Add OCR workers when queue age exceeds 60 seconds or upload rate exceeds 4 documents/minute per worker.",
    }


def security_profile() -> dict:
    return {
        "mode": "Enterprise-ready demo controls",
        "httpsRequired": True,
        "securityHeaders": [
            "X-Content-Type-Options",
            "X-Frame-Options",
            "Referrer-Policy",
            "Permissions-Policy",
            "Cache-Control for app shell",
        ],
        "cors": "Restricted by COMPLETION_IQ_ALLOWED_ORIGIN" if ALLOWED_ORIGIN != "*" else "Demo mode allows all origins; restrict in production",
        "staffApiKey": "Enabled" if STAFF_API_KEY else "Ready but not enabled for local demo",
        "auditTrail": "Enabled for state, scans, review decisions, workflow actions, and notifications",
        "dataControls": [
            "4 MB upload guard",
            "MIME/type validation before OCR",
            "SQLite persistence for demo",
            "Use PostgreSQL + object storage + KMS encryption in production",
        ],
    }


def capacity_snapshot(uploads_per_minute: int = 0) -> dict:
    now = time.time()
    with METRICS_LOCK:
        while REQUEST_TIMESTAMPS and REQUEST_TIMESTAMPS[0] < now - 60:
            REQUEST_TIMESTAMPS.popleft()
        rpm = len(REQUEST_TIMESTAMPS)
        active = ACTIVE_REQUESTS
        total = TOTAL_REQUESTS
    return {
        "activeRequests": active,
        "requestsLastMinute": rpm,
        "totalRequestsSinceStart": total,
        "serverModel": "Bank-grade threaded API server with bounded multi-AI worker harness",
        "ocrWorkers": OCR_WORKERS,
        "ocrTimeoutSeconds": OCR_TIMEOUT_SECONDS,
        "recommendedUploadMb": 4,
        "maxJsonPayloadMb": round(MAX_JSON_PAYLOAD_BYTES / 1024 / 1024, 1),
        "estimatedCapacity": {
            "textOnlyRequestsPerMinute": "1000-3000 lightweight API requests/minute on local demo hardware",
            "imageOcrRequestsPerMinute": f"about {max(1, OCR_WORKERS * 2)}-{max(2, OCR_WORKERS * 4)}, depending on OCR time and CPU/RAM",
            "netlifyPayloadNote": "Keep files <= 4 MB because base64 JSON expands upload size",
        },
        "bankCapacityProfile": {
            "branchPilot": "32 OCR workers, about 64-128 scanned documents/minute shared across branch users",
            "regionalRollout": "64 OCR workers, about 128-256 scanned documents/minute with a dedicated OCR worker node",
            "enterpriseBank": "Queue-backed OCR worker fleet, 500-2000+ scanned documents/minute by adding worker nodes",
            "recommendedProductionPattern": "API servers stay responsive while OCR/classification/extraction/validation run on separate queue workers",
        },
        "adaptiveScaling": adaptive_capacity_plan(uploads_per_minute),
        "enterpriseSecurity": security_profile(),
        "multiAiHarness": [
            "OCR worker",
            "Document classifier",
            "Field extractor",
            "Validation and mismatch engine",
            "Risk and recommendation engine",
        ],
    }


class CompletionIQHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def handle_one_request(self) -> None:
        begin_request()
        try:
            super().handle_one_request()
        finally:
            end_request()

    def end_headers(self) -> None:
        if self.path.endswith((".html", ".js", ".css", ".webmanifest")) or "mobile.html" in self.path:
            self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        json_response(self, {"ok": True})

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if not length:
            return {}
        if length > MAX_JSON_PAYLOAD_BYTES:
            raise ValueError(f"Payload too large. Maximum supported request size is {MAX_JSON_PAYLOAD_BYTES // (1024 * 1024)} MB.")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def staff_api_allowed(self, path: str) -> bool:
        if not STAFF_API_KEY:
            return True
        public_paths = ("/api/health", "/api/capacity", "/api/customer-upload")
        if path.startswith("/api/customer-links/") or path.startswith("/api/tickets/") or path in public_paths:
            return True
        return self.headers.get("X-API-Key") == STAFF_API_KEY

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path.startswith("/api/") and not self.staff_api_allowed(path):
            json_response(self, {"ok": False, "error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return
        if path == "/api/health":
            json_response(self, {"ok": True, "database": str(DB_PATH), "service": "Completion IQ Backend"})
            return
        if path == "/api/state":
            json_response(self, get_state())
            return
        if path == "/api/analytics":
            json_response(self, analytics_snapshot(get_state()))
            return
        if path == "/api/world-graph":
            json_response(self, {"ok": True, "graph": world_graph_snapshot(get_state())})
            return
        if path == "/api/document-policy":
            query = parse_qs(urlparse(self.path).query)
            product = (query.get("product") or ["Savings Account"])[0]
            segment = (query.get("segment") or [""])[0]
            json_response(self, {"ok": True, "policy": document_policy_payload(product, segment)})
            return
        if path == "/api/capacity":
            query = parse_qs(urlparse(self.path).query)
            uploads_per_minute = int((query.get("uploadsPerMinute") or query.get("uploads") or ["0"])[0] or 0)
            json_response(self, capacity_snapshot(uploads_per_minute))
            return
        if path == "/api/compliance":
            with db() as conn:
                audits = [dict(row) for row in conn.execute("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 100")]
                integrations = [dict(row) for row in conn.execute("SELECT * FROM integration_events ORDER BY created_at DESC LIMIT 100")]
                flags = [dict(row) for row in conn.execute("SELECT * FROM validation_flags ORDER BY created_at DESC LIMIT 100")]
            json_response(self, {"audit": audits, "integrations": integrations, "flags": flags})
            return
        token_match = re.fullmatch(r"/api/customer-links/([^/]+)", path)
        if token_match:
            app_id = app_for_customer_token(token_match.group(1))
            if not app_id:
                json_response(self, {"ok": False, "error": "Invalid or expired upload link"}, HTTPStatus.NOT_FOUND)
                return
            state = get_state()
            app = find_app(state, app_id)
            json_response(self, {"ok": True, "application": {**application_tracking_payload(app, state), "id": app["id"]}})
            return
        ticket_match = re.fullmatch(r"/api/tickets/([^/]+)", path)
        if ticket_match:
            ticket = ticket_match.group(1).upper()
            state = get_state()
            app = next((item for item in state.get("applications", []) if str(item.get("trackingTicket", "")).upper() == ticket), None)
            if not app:
                json_response(self, {"ok": False, "error": "Tracking ticket not found"}, HTTPStatus.NOT_FOUND)
                return
            json_response(self, {"ok": True, "application": application_tracking_payload(app, state)})
            return
        job_match = re.fullmatch(r"/api/scan-jobs/([^/]+)", path)
        if job_match:
            with db() as conn:
                row = conn.execute("SELECT * FROM scan_jobs WHERE id = ?", (job_match.group(1),)).fetchone()
            if not row:
                json_response(self, {"ok": False, "error": "Job not found"}, HTTPStatus.NOT_FOUND)
                return
            payload = dict(row)
            payload["result"] = json.loads(payload["result"]) if payload.get("result") else None
            json_response(self, {"ok": True, "job": payload})
            return
        if path == "/api/audit":
            with db() as conn:
                rows = [dict(row) for row in conn.execute("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 100")]
            json_response(self, {"events": rows})
            return
        return super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            self._do_POST(path)
        except ValueError as error:
            json_response(self, {"ok": False, "error": str(error)}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)

    def _do_POST(self, path: str) -> None:
        if path.startswith("/api/") and not self.staff_api_allowed(path):
            json_response(self, {"ok": False, "error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return
        if path == "/api/state":
            state = self.read_json()
            save_state(state, "Full state saved from frontend")
            json_response(self, {"ok": True, "state": state})
            return
        if path == "/api/reset":
            state = initial_state()
            save_state(state, "Demo data reset")
            json_response(self, {"ok": True, "state": state})
            return
        if path == "/api/role":
            state = get_state()
            payload = self.read_json()
            role = str(payload.get("role", "rm"))
            name = {
                "rm": "Asha Nair",
                "manager": "Prakash Menon",
                "admin": "Admin User",
                "customer": "Customer User",
            }.get(role, "Asha Nair")
            state["user"] = {"role": role, "name": name}
            save_state(state, f"Role switched: {role}")
            json_response(self, {"ok": True, "state": state})
            return
        if path == "/api/applications":
            state = get_state()
            if state.get("user", {}).get("role") == "customer":
                json_response(self, {"ok": False, "error": "Customers cannot create staff applications"}, HTTPStatus.FORBIDDEN)
                return
            app = self.read_json()
            app.setdefault("id", f"APP-{uuid.uuid4().hex[:4].upper()}")
            app.setdefault("customer", "New Applicant")
            app.setdefault("mobile", "")
            app.setdefault("email", "")
            app.setdefault("product", "Savings Account")
            app.setdefault("accountType", product_account_type(app.get("product", "")))
            app.setdefault("customerSegment", "Business" if app.get("product") in ("Business Loan", "Current Account") else "Personal")
            app.setdefault("rm", state.get("user", {}).get("name", "Asha Nair"))
            app.setdefault("manager", "Prakash Menon")
            app.setdefault("branch", "Chennai Central")
            app.setdefault("stage", "Document Collection")
            app.setdefault("value", 0)
            app.setdefault("trackingTicket", make_tracking_ticket(app))
            app.setdefault("submissionStatus", "Draft")
            app.setdefault("crmReference", "")
            app.setdefault("customerTrackingUrl", customer_tracking_url(app))
            app.setdefault("createdAt", TODAY)
            app.setdefault("lastActivityAt", TODAY)
            app.setdefault("customerIntent", "Warm")
            app.setdefault("source", "Mobile entry")
            app.setdefault("documents", [])
            if not app.get("tasks"):
                app["tasks"] = [task("Collect mandatory documents", "Document", app["rm"], TODAY, "Open", "High")]
            app.setdefault("timeline", [f"{TODAY} - Application created through API"])
            app.setdefault("notes", [])
            app.setdefault("identity", {})
            app.setdefault("timeline", []).insert(0, f"{TODAY} - Tracking ticket generated: {app['trackingTicket']}")
            state["applications"].insert(0, app)
            save_state(state, f"Application created: {app['id']}")
            json_response(self, {"ok": True, "application": app, "state": state}, HTTPStatus.CREATED)
            return
        customer_link_match = re.fullmatch(r"/api/applications/([^/]+)/customer-link", path)
        if customer_link_match:
            state = get_state()
            app = find_app(state, customer_link_match.group(1))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_run_staff_workflow(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            link = create_customer_link(app["id"])
            app.setdefault("timeline", []).insert(0, f"{TODAY} - Customer upload link generated")
            create_notification(state, app["id"], "Customer upload link ready", f"Share {link['url']} with {app['customer']}.", "Medium")
            record_integration_event(app["id"], "Customer Portal", "Link Created", link)
            save_state(state, f"Customer link generated: {app['id']}")
            json_response(self, {"ok": True, "link": link, "state": state})
            return
        form_prefill_match = re.fullmatch(r"/api/applications/([^/]+)/form-prefill", path)
        if form_prefill_match:
            state = get_state()
            app = find_app(state, form_prefill_match.group(1))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_run_staff_workflow(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            packet = form_prefill_payload(app)
            app.setdefault("timeline", []).insert(0, f"{TODAY} - Bharat Bank form prefill packet generated")
            create_notification(state, app["id"], "Bharat Bank forms prefill ready", f"{len(packet['forms'])} form template(s) mapped from application data.", "Medium")
            record_integration_event(app["id"], "Bharat Bank Forms", "Prefill Generated", {"forms": packet["forms"], "downloadsUrl": packet["downloadsUrl"]})
            save_state(state, f"Bharat Bank form prefill: {app['id']}")
            json_response(self, {"ok": True, "prefill": packet, "state": state})
            return
        review_match = re.fullmatch(r"/api/review/([^/]+)/(approve|reject)", path)
        if review_match:
            state = get_state()
            review_id, decision = review_match.group(1), review_match.group(2)
            body = self.read_json()
            item = next((row for row in state.get("reviewQueue", []) if row.get("id") == review_id), None)
            if not item:
                json_response(self, {"ok": False, "error": "Review item not found"}, HTTPStatus.NOT_FOUND)
                return
            app = find_app(state, item["appId"])
            if not app or state.get("user", {}).get("role") not in ("manager", "admin"):
                json_response(self, {"ok": False, "error": "Only manager/admin can approve review items"}, HTTPStatus.FORBIDDEN)
                return
            if decision == "approve":
                doc_payload = {"id": new_id(), "name": item["docType"], "status": "Received", "confidence": item["confidence"], "uploadedAt": TODAY, "extracted": item["fields"], "fieldConfidence": item.get("fieldConfidence", {}), "ai": item.get("ai", {}), "quality": item.get("quality", {}), "flags": item.get("flags", []), "filename": item.get("filename", ""), "previewDataUrl": item.get("previewDataUrl", ""), "previewMime": item.get("previewMime", "")}
                existing = next((doc for doc in app.get("documents", []) if doc.get("name") == item["docType"]), None)
                if existing:
                    existing.update(doc_payload)
                else:
                    app.setdefault("documents", []).append(doc_payload)
                update_identity_consistency(app, item["docType"], item.get("fields", {}), item.get("mismatches", []), item.get("ai", {}).get("detectedDocType", item["docType"]))
                status_text = "Approved"
            else:
                status_text = "Rejected"
            state["reviewQueue"] = [row for row in state.get("reviewQueue", []) if row.get("id") != review_id]
            app.setdefault("timeline", []).insert(0, f"{TODAY} - Manager {status_text.lower()} review: {item['docType']} ({body.get('comment', 'No comment')})")
            record_integration_event(app["id"], "Approval Workflow", status_text, {"reviewId": review_id, "comment": body.get("comment", "")})
            create_notification(state, app["id"], f"Document {status_text}", f"{item['docType']} was {status_text.lower()} by manager.", "Medium")
            save_state(state, f"Review {status_text}: {review_id}")
            json_response(self, {"ok": True, "state": state})
            return
        if path == "/api/customer-upload":
            payload = self.read_json()
            app_id = app_for_customer_token(str(payload.get("token", "")))
            if not app_id:
                json_response(self, {"ok": False, "error": "Invalid or expired upload link"}, HTTPStatus.NOT_FOUND)
                return
            payload["appId"] = app_id
            payload["customerUpload"] = True
            result = process_scan_payload(payload, use_cache=True)
            record_integration_event(app_id, "Customer Portal", "Document Uploaded", {"doc": payload.get("expectedDoc", ""), "result": result.get("result")})
            json_response(self, result, int(result.pop("status", 200)))
            return
        reminder_match = re.fullmatch(r"/api/applications/([^/]+)/send-reminder", path)
        if reminder_match:
            state = get_state()
            app = find_app(state, reminder_match.group(1))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_run_staff_workflow(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            follow = follow_up_message(app)
            event = record_integration_event(app["id"], "WhatsApp Business", "Sent", {"to": app.get("mobile"), "message": follow["message"]})
            app.setdefault("timeline", []).insert(0, f"{TODAY} - WhatsApp reminder sent")
            create_notification(state, app["id"], "Reminder sent", follow["message"], "Medium")
            save_state(state, f"Reminder sent: {app['id']}")
            json_response(self, {"ok": True, "event": event, "state": state})
            return
        crm_match = re.fullmatch(r"/api/applications/([^/]+)/crm-sync", path)
        if crm_match:
            state = get_state()
            app = find_app(state, crm_match.group(1))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_run_staff_workflow(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            app["crmReference"] = app.get("crmReference") or make_crm_reference(app)
            event = record_integration_event(app["id"], "CRM Sync", "Synced", {"crmReference": app["crmReference"], "stage": app.get("stage"), "documents": [doc.get("name") for doc in app.get("documents", [])], "risk": backend_risk_score(app)})
            app.setdefault("timeline", []).insert(0, f"{TODAY} - CRM sync completed")
            save_state(state, f"CRM synced: {app['id']}")
            json_response(self, {"ok": True, "event": event, "state": state})
            return
        submit_match = re.fullmatch(r"/api/applications/([^/]+)/submit-to-bank", path)
        if submit_match:
            state = get_state()
            app = find_app(state, submit_match.group(1))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_run_staff_workflow(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            blockers = completion_blockers(state, app)
            verified_identity = [key for key, value in app.get("identity", {}).items() if value.get("status") == "Verified"]
            if blockers:
                create_notification(state, app["id"], "Bank submission blocked", "; ".join(blockers), "High")
                save_state(state, f"Bank submission blocked: {app['id']}")
                json_response(self, {"ok": False, "error": "Application is not ready for bank submission", "blockers": blockers, "state": state}, HTTPStatus.CONFLICT)
                return
            app["trackingTicket"] = app.get("trackingTicket") or make_tracking_ticket(app)
            app["crmReference"] = app.get("crmReference") or make_crm_reference(app)
            app["customerTrackingUrl"] = customer_tracking_url(app)
            app["submissionStatus"] = "Submitted to Bank CRM"
            app["stage"] = "Approval" if app.get("stage") != "Completed" else app["stage"]
            app["lastActivityAt"] = TODAY
            payload = {
                "trackingTicket": app["trackingTicket"],
                "crmReference": app["crmReference"],
                "customerTrackingUrl": app["customerTrackingUrl"],
                "product": app.get("product"),
                "accountType": app.get("accountType"),
                "customerSegment": app.get("customerSegment"),
                "verifiedIdentity": verified_identity,
                "documents": [doc.get("name") for doc in app.get("documents", [])],
                "completionScore": backend_completion_score(app),
            }
            crm_event = record_integration_event(app["id"], "Bank CRM", "Submitted", payload)
            record_integration_event(app["id"], "KYC Provider Adapter", "Evidence Submitted", {"verified": verified_identity})
            app.setdefault("timeline", []).insert(0, f"{TODAY} - Submitted to Bank CRM: {app['crmReference']} | Ticket {app['trackingTicket']}")
            create_notification(state, app["id"], "Submitted to Bank CRM", f"Tracking ticket {app['trackingTicket']} is ready for customer tracking.", "Medium")
            save_state(state, f"Submitted to bank: {app['id']}")
            json_response(self, {"ok": True, "event": crm_event, "tracking": application_tracking_payload(app, state), "state": state})
            return
        complete_match = re.fullmatch(r"/api/applications/([^/]+)/complete", path)
        if complete_match:
            state = get_state()
            app = find_app(state, complete_match.group(1))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_run_staff_workflow(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            blockers = completion_blockers(state, app)
            if blockers:
                create_notification(state, app["id"], "Completion blocked", "; ".join(blockers), "High")
                save_state(state, f"Completion blocked: {app['id']}")
                json_response(self, {"ok": False, "error": "Application is not ready", "blockers": blockers, "state": state}, HTTPStatus.CONFLICT)
                return
            role = state.get("user", {}).get("role", "rm")
            app["stage"] = "Completed" if role in ("manager", "admin") else "Approval"
            app["lastActivityAt"] = TODAY
            app.setdefault("timeline", []).insert(0, f"{TODAY} - Application marked {app['stage']} by {state.get('user', {}).get('name', 'user')}")
            event = record_integration_event(app["id"], "Completion Workflow", app["stage"], {"role": role, "completionScore": backend_completion_score(app)})
            create_notification(state, app["id"], "Application completed" if app["stage"] == "Completed" else "Ready for approval", f"{app['customer']} moved to {app['stage']}.", "Medium")
            save_state(state, f"Completion workflow: {app['id']} {app['stage']}")
            json_response(self, {"ok": True, "event": event, "state": state})
            return
        kyc_match = re.fullmatch(r"/api/applications/([^/]+)/kyc-verify", path)
        if kyc_match:
            state = get_state()
            app = find_app(state, kyc_match.group(1))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_run_staff_workflow(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            verified = {key: value for key, value in app.get("identity", {}).items() if value.get("status") == "Verified"}
            status_text = "Verified" if verified else "Needs Documents"
            event = record_integration_event(app["id"], "KYC Provider Adapter", status_text, {"verified": list(verified.keys())})
            app.setdefault("timeline", []).insert(0, f"{TODAY} - KYC provider adapter: {status_text}")
            save_state(state, f"KYC adapter run: {app['id']}")
            json_response(self, {"ok": True, "event": event, "state": state})
            return
        if path == "/api/scan":
            payload = self.read_json()
            result = process_scan_payload(payload, use_cache=True)
            status = int(result.pop("status", 200))
            json_response(self, result, status)
            return
        if path == "/api/scan-jobs":
            payload = self.read_json()
            job_id = new_id()
            cache_key = document_hash(str(payload.get("appId", "")), str(payload.get("filename", "")), str(payload.get("text", "")), str(payload.get("fileData", "")), str(payload.get("expectedDoc", "")))
            with db() as conn:
                conn.execute(
                    "INSERT INTO scan_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (job_id, payload.get("appId", ""), payload.get("expectedDoc", ""), payload.get("filename", ""), cache_key, "Processing", "", TODAY, TODAY),
                )
                conn.commit()
            result = process_scan_payload(payload, use_cache=True)
            with db() as conn:
                conn.execute(
                    "UPDATE scan_jobs SET status = ?, result = ?, updated_at = ? WHERE id = ?",
                    ("Done" if result.get("ok") else "Failed", json.dumps(result), TODAY, job_id),
                )
                conn.commit()
            json_response(self, {"ok": True, "jobId": job_id, "status": "Done", "result": result, "state": result.get("state")}, HTTPStatus.ACCEPTED)
            return
        json_response(self, {"ok": False, "error": "Endpoint not found"}, HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        self.do_PATCH()

    def do_PATCH(self) -> None:
        path = urlparse(self.path).path
        doc_correction_match = re.fullmatch(r"/api/applications/([^/]+)/documents/([^/]+)/correct", path)
        if doc_correction_match:
            state = get_state()
            app = find_app(state, doc_correction_match.group(1))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_mutate_app(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            doc_key = doc_correction_match.group(2).replace("%20", " ")
            doc = next((item for item in app.get("documents", []) if item.get("id") == doc_key or item.get("name") == doc_key), None)
            if not doc:
                json_response(self, {"ok": False, "error": "Document not found. Approve/re-upload the document before editing fields."}, HTTPStatus.NOT_FOUND)
                return
            payload = self.read_json()
            fields = dict(doc.get("extracted", {}))
            for key, value in (payload.get("fields") or {}).items():
                if key in {"name", "dob", "pan", "aadhaar", "address", "mobile", "gender", "signatureStatus", "gstin"}:
                    fields[key] = str(value).strip() or "Not detected"
            doc["extracted"] = fields
            doc["manualCorrection"] = {
                "correctedAt": TODAY,
                "correctedBy": state.get("user", {}).get("name", "user"),
                "reason": payload.get("reason", "Manual correction after scan review"),
            }
            doc.setdefault("timeline", []).insert(0, f"{TODAY} - Fields manually corrected")
            doc["flags"] = [flag for flag in doc.get("flags", []) if not str(flag.get("type", "")).endswith("_mismatch")]
            if doc.get("name") in ("PAN", "Aadhaar"):
                identity_key = doc.get("name", "").lower()
                app.setdefault("identity", {})[identity_key] = {
                    "status": "Manually corrected",
                    "fields": fields,
                    "fieldConfidence": doc.get("fieldConfidence", {}),
                    "verifiedAt": TODAY,
                    "provider": "Manual staff correction",
                }
            update_address_profile(app, doc.get("name", ""), fields, [])
            recompute_app_identity_consistency(app)
            app["lastActivityAt"] = TODAY
            app.setdefault("timeline", []).insert(0, f"{TODAY} - Manual field correction: {doc.get('name')}")
            create_notification(state, app["id"], "Document fields corrected", f"{doc.get('name')} fields were manually updated and cross-check was recalculated.", "Medium")
            save_state(state, f"Document corrected: {app['id']} {doc.get('name')}")
            json_response(self, {"ok": True, "document": doc, "identityConsistency": app.get("identityConsistency", {}), "state": state})
            return
        review_correction_match = re.fullmatch(r"/api/review/([^/]+)/correct-approve", path)
        if review_correction_match:
            state = get_state()
            review_id = review_correction_match.group(1)
            item = next((row for row in state.get("reviewQueue", []) if row.get("id") == review_id), None)
            if not item:
                json_response(self, {"ok": False, "error": "Review item not found"}, HTTPStatus.NOT_FOUND)
                return
            app = find_app(state, item.get("appId", ""))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_mutate_app(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            payload = self.read_json()
            fields = dict(item.get("fields", {}))
            for key, value in (payload.get("fields") or {}).items():
                if key in {"name", "dob", "pan", "aadhaar", "address", "mobile", "gender", "signatureStatus", "gstin"}:
                    fields[key] = str(value).strip() or "Not detected"
            doc_payload = {
                "id": new_id(),
                "name": item["docType"],
                "status": "Received",
                "confidence": max(80, int(item.get("confidence", 80))),
                "uploadedAt": TODAY,
                "extracted": fields,
                "fieldConfidence": item.get("fieldConfidence", {}),
                "ai": {**item.get("ai", {}), "status": "Manually corrected"},
                "quality": item.get("quality", {}),
                "flags": [],
                "filename": item.get("filename", ""),
                "previewDataUrl": item.get("previewDataUrl", ""),
                "previewMime": item.get("previewMime", ""),
                "manualCorrection": {
                    "correctedAt": TODAY,
                    "correctedBy": state.get("user", {}).get("name", "user"),
                    "reason": payload.get("reason", "Manual correction from review queue"),
                },
            }
            existing = next((doc for doc in app.get("documents", []) if doc.get("name") == item["docType"]), None)
            if existing:
                existing.update(doc_payload)
            else:
                app.setdefault("documents", []).append(doc_payload)
            if item["docType"] in ("PAN", "Aadhaar"):
                app.setdefault("identity", {})[item["docType"].lower()] = {
                    "status": "Manually corrected",
                    "fields": fields,
                    "fieldConfidence": item.get("fieldConfidence", {}),
                    "verifiedAt": TODAY,
                    "provider": "Manual staff correction",
                }
            update_address_profile(app, item["docType"], fields, [])
            recompute_app_identity_consistency(app)
            state["reviewQueue"] = [row for row in state.get("reviewQueue", []) if row.get("id") != review_id]
            app["lastActivityAt"] = TODAY
            app.setdefault("timeline", []).insert(0, f"{TODAY} - Review item corrected and attached: {item['docType']}")
            create_notification(state, app["id"], "Review corrected", f"{item['docType']} was corrected manually and attached.", "Medium")
            save_state(state, f"Review corrected and approved: {review_id}")
            json_response(self, {"ok": True, "document": doc_payload, "identityConsistency": app.get("identityConsistency", {}), "state": state})
            return
        match = re.fullmatch(r"/api/applications/([^/]+)", path)
        if not match:
            json_response(self, {"ok": False, "error": "Endpoint not found"}, HTTPStatus.NOT_FOUND)
            return
        state = get_state()
        app = find_app(state, match.group(1))
        if not app:
            json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
            return
        if not can_mutate_app(state, app):
            json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
            return
        app.update(self.read_json())
        app["accountType"] = product_account_type(app.get("product", ""))
        app["customerSegment"] = app.get("customerSegment") or ("Business" if app.get("product") in ("Business Loan", "Current Account") else "Personal")
        app["trackingTicket"] = app.get("trackingTicket") or make_tracking_ticket(app)
        app["customerTrackingUrl"] = customer_tracking_url(app)
        app["lastActivityAt"] = TODAY
        app.setdefault("timeline", []).insert(0, f"{TODAY} - Application updated through API")
        save_state(state, f"Application updated: {app['id']}")
        json_response(self, {"ok": True, "application": app, "state": state})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        state = get_state()

        app_delete_match = re.fullmatch(r"/api/applications/([^/]+)", path)
        if app_delete_match:
            app_id = app_delete_match.group(1)
            app = find_app(state, app_id)
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_mutate_app(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            state["applications"] = [item for item in state.get("applications", []) if item.get("id") != app_id]
            state["reviewQueue"] = [item for item in state.get("reviewQueue", []) if item.get("appId") != app_id]
            state["notifications"] = [item for item in state.get("notifications", []) if item.get("appId") != app_id]
            with db() as conn:
                conn.execute("DELETE FROM validation_flags WHERE app_id = ?", (app_id,))
                conn.execute("DELETE FROM scan_records WHERE app_id = ?", (app_id,))
                conn.execute("DELETE FROM notifications WHERE app_id = ?", (app_id,))
                conn.execute("DELETE FROM integration_events WHERE app_id = ?", (app_id,))
                conn.execute("DELETE FROM customer_upload_links WHERE app_id = ?", (app_id,))
                conn.execute("DELETE FROM scan_jobs WHERE app_id = ?", (app_id,))
                conn.commit()
            save_state(state, f"Application deleted: {app_id}")
            json_response(self, {"ok": True, "state": state})
            return

        doc_match = re.fullmatch(r"/api/applications/([^/]+)/documents/([^/]+)", path)
        if doc_match:
            app = find_app(state, doc_match.group(1))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_mutate_app(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            doc_key = doc_match.group(2).replace("%20", " ")
            before = len(app.get("documents", []))
            removed_docs = [doc for doc in app.get("documents", []) if doc.get("id") == doc_key or doc.get("name") == doc_key]
            app["documents"] = [doc for doc in app.get("documents", []) if doc.get("id") != doc_key and doc.get("name") != doc_key]
            for removed in removed_docs:
                app.get("identity", {}).pop(str(removed.get("name", "")).lower(), None)
            state["reviewQueue"] = [item for item in state.get("reviewQueue", []) if not (item.get("appId") == app["id"] and item.get("docType") == doc_key)]
            if len(app["documents"]) == before:
                json_response(self, {"ok": False, "error": "Document not found"}, HTTPStatus.NOT_FOUND)
                return
            app["lastActivityAt"] = TODAY
            app.setdefault("timeline", []).insert(0, f"{TODAY} - Document deleted: {doc_key}")
            create_notification(state, app["id"], "Document deleted", f"{doc_key} was removed. Please upload the correct document.", "Medium")
            save_state(state, f"Document deleted: {app['id']} {doc_key}")
            json_response(self, {"ok": True, "state": state})
            return

        identity_match = re.fullmatch(r"/api/applications/([^/]+)/identity/([^/]+)", path)
        if identity_match:
            app = find_app(state, identity_match.group(1))
            if not app:
                json_response(self, {"ok": False, "error": "Application not found"}, HTTPStatus.NOT_FOUND)
                return
            if not can_mutate_app(state, app):
                json_response(self, {"ok": False, "error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
            identity_key = identity_match.group(2).lower()
            app.setdefault("identity", {}).pop(identity_key, None)
            app.setdefault("timeline", []).insert(0, f"{TODAY} - Identity info cleared: {identity_key.upper()}")
            create_notification(state, app["id"], "Identity cleared", f"{identity_key.upper()} info was cleared and needs re-verification.", "Medium")
            save_state(state, f"Identity cleared: {app['id']} {identity_key}")
            json_response(self, {"ok": True, "state": state})
            return

        notification_match = re.fullmatch(r"/api/notifications/([^/]+)", path)
        if notification_match:
            notification_id = notification_match.group(1)
            state["notifications"] = [item for item in state.get("notifications", []) if item.get("id") != notification_id]
            with db() as conn:
                conn.execute("UPDATE notifications SET status = ? WHERE id = ?", ("Dismissed", notification_id))
                conn.commit()
            save_state(state, f"Notification dismissed: {notification_id}")
            json_response(self, {"ok": True, "state": state})
            return

        json_response(self, {"ok": False, "error": "Endpoint not found"}, HTTPStatus.NOT_FOUND)


def main() -> None:
    db()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), CompletionIQHandler)
    print(f"Completion IQ backend running at http://{host}:{port}/")
    print(f"SQLite database: {DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
