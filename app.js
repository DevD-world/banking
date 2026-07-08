const STORAGE_KEY = "completion-iq-v2-state";
const API_BASE = window.COMPLETION_IQ_API_BASE || "";
let backendOnline = false;
let remoteSaveTimer = null;
let deferredInstallPrompt = null;

const stageOrder = ["Lead Captured", "Document Collection", "Verification", "Approval", "Disbursement", "Completed"];
const integrationDefaults = [
  { id: "crm", name: "CRM Sync", status: "Planned", detail: "Push stage, owner, document, and task updates to CRM." },
  { id: "whatsapp", name: "WhatsApp Business", status: "Ready for API", detail: "Send approved follow-up templates and capture delivery status." },
  { id: "ocr", name: "OCR / Document AI", status: "Ready for API", detail: "Classify documents, extract fields, and flag mismatches." },
  { id: "kyc", name: "Aadhaar/PAN Verification", status: "Planned", detail: "Validate extracted identity fields against approved providers." },
  { id: "email", name: "Email Gateway", status: "Ready for API", detail: "Send pending document reminders and status updates." },
  { id: "calls", name: "Call Recording", status: "Planned", detail: "Link call outcomes to application timeline and RM productivity." }
];

const defaultRules = {
  "Savings Account": [
    { name: "Aadhaar", weight: 20, fields: ["aadhaar"], mandatory: true },
    { name: "PAN", weight: 20, fields: ["pan"], mandatory: true },
    { name: "Photo", weight: 10, fields: [], mandatory: true },
    { name: "Signature", weight: 10, fields: [], mandatory: true }
  ],
  "Business Loan": [
    { name: "GST Certificate", weight: 18, fields: ["gstin"], mandatory: true },
    { name: "ITR", weight: 14, fields: ["pan"], mandatory: true },
    { name: "Bank Statements", weight: 16, fields: [], mandatory: true },
    { name: "Business Registration", weight: 14, fields: [], mandatory: true },
    { name: "PAN", weight: 12, fields: ["pan"], mandatory: true },
    { name: "Aadhaar", weight: 8, fields: ["aadhaar"], mandatory: true }
  ],
  "Current Account": [
    { name: "GST Certificate", weight: 18, fields: ["gstin"], mandatory: true },
    { name: "Business Registration", weight: 16, fields: [], mandatory: true },
    { name: "PAN", weight: 14, fields: ["pan"], mandatory: true },
    { name: "Aadhaar", weight: 10, fields: ["aadhaar"], mandatory: true },
    { name: "Address Proof", weight: 12, fields: [], mandatory: true }
  ],
  "Home Loan": [
    { name: "PAN", weight: 12, fields: ["pan"], mandatory: true },
    { name: "Aadhaar", weight: 10, fields: ["aadhaar"], mandatory: true },
    { name: "Salary Slips", weight: 14, fields: [], mandatory: true },
    { name: "Bank Statements", weight: 14, fields: [], mandatory: true },
    { name: "Property Documents", weight: 18, fields: [], mandatory: true },
    { name: "ITR", weight: 10, fields: ["pan"], mandatory: false }
  ]
};

const demoApplications = [
  {
    id: "APP-1048",
    customer: "Ramesh Textiles",
    mobile: "+91 98765 41048",
    email: "owner@rameshtextiles.in",
    product: "Business Loan",
    rm: "Asha Nair",
    manager: "Prakash Menon",
    branch: "Chennai Central",
    stage: "Document Collection",
    value: 1800000,
    createdAt: "2026-05-27",
    lastActivityAt: "2026-06-01",
    customerIntent: "Warm",
    source: "Branch walk-in",
    documents: receivedDocs(["PAN", "Aadhaar", "Bank Statements", "Business Registration"]),
    tasks: [
      task("Collect GST Certificate", "Document", "Asha Nair", "2026-06-05", "Open", "High"),
      task("Collect latest ITR", "Document", "Asha Nair", "2026-06-06", "Open", "Medium")
    ],
    timeline: ["Application started", "PAN and Aadhaar collected", "Bank statements uploaded"],
    notes: ["Customer wants working capital for seasonal order."]
  },
  {
    id: "APP-1053",
    customer: "Kavya Srinivasan",
    mobile: "+91 90031 11053",
    email: "kavya@example.com",
    product: "Savings Account",
    rm: "Vikram Shah",
    manager: "Prakash Menon",
    branch: "Coimbatore Main",
    stage: "Verification",
    value: 120000,
    createdAt: "2026-06-01",
    lastActivityAt: "2026-06-04",
    customerIntent: "Hot",
    source: "Campaign",
    documents: receivedDocs(["Aadhaar", "PAN", "Photo"]),
    tasks: [task("Collect wet signature", "Document", "Vikram Shah", "2026-06-05", "Open", "Medium")],
    timeline: ["Application started", "Photo captured", "KYC verification pending"],
    notes: ["Customer prefers WhatsApp follow-up."]
  },
  {
    id: "APP-1061",
    customer: "GreenMart Foods",
    mobile: "+91 98402 21061",
    email: "finance@greenmartfoods.in",
    product: "Current Account",
    rm: "Asha Nair",
    manager: "Prakash Menon",
    branch: "Chennai Central",
    stage: "Document Collection",
    value: 650000,
    createdAt: "2026-05-24",
    lastActivityAt: "2026-05-29",
    customerIntent: "Warm",
    source: "RM referral",
    documents: receivedDocs(["PAN", "Aadhaar", "GST Certificate"]),
    tasks: [
      task("Collect Address Proof", "Document", "Asha Nair", "2026-06-04", "Open", "High"),
      task("Call customer for registration copy", "Call", "Asha Nair", "2026-06-05", "Open", "High")
    ],
    timeline: ["Application started", "GST certificate collected", "Customer did not respond to address proof request"],
    notes: ["Owner travels frequently. Call before 11 AM."]
  },
  {
    id: "APP-1077",
    customer: "Naveen Kumar",
    mobile: "+91 94444 51077",
    email: "naveen.kumar@example.com",
    product: "Home Loan",
    rm: "Meera Iyer",
    manager: "Lakshmi Rao",
    branch: "Madurai North",
    stage: "Approval",
    value: 4500000,
    createdAt: "2026-05-20",
    lastActivityAt: "2026-06-02",
    customerIntent: "Hot",
    source: "Digital lead",
    documents: receivedDocs(["PAN", "Aadhaar", "Salary Slips", "Bank Statements", "ITR"]),
    tasks: [task("Collect Property Documents", "Document", "Meera Iyer", "2026-06-05", "Open", "High")],
    timeline: ["Application started", "Income documents verified", "Property papers awaited"],
    notes: ["Customer has finalized property; approval is time sensitive."]
  },
  {
    id: "APP-1082",
    customer: "Sri Balaji Traders",
    mobile: "+91 98840 71082",
    email: "accounts@sribalajitraders.in",
    product: "Business Loan",
    rm: "Vikram Shah",
    manager: "Lakshmi Rao",
    branch: "Salem West",
    stage: "Verification",
    value: 2200000,
    createdAt: "2026-05-31",
    lastActivityAt: "2026-06-04",
    customerIntent: "Hot",
    source: "Existing customer",
    documents: receivedDocs(["GST Certificate", "ITR", "Bank Statements", "Business Registration", "PAN", "Aadhaar"]),
    tasks: [task("Complete verification checklist", "Verification", "Vikram Shah", "2026-06-06", "Open", "Medium")],
    timeline: ["Application started", "All documents collected", "Verification assigned"],
    notes: ["Existing CASA customer. Eligible for cross-sell."]
  }
];

let state = loadState();
let selectedApplicationId = state.applications[0]?.id;
let activeFilter = "all";

const views = {
  command: "Application Command Center",
  rm: "Relationship Manager Copilot",
  followups: "Follow-Up Center",
  scanner: "AI Document Scanner",
  manager: "Manager Control Tower",
  analytics: "Revenue Leakage Analytics",
  admin: "Rules Admin",
  integrations: "Integrations"
};

function task(title, type, owner, dueDate, status, priority) {
  return { id: crypto.randomUUID(), title, type, owner, dueDate, status, priority };
}

function receivedDocs(names) {
  return names.map((name) => ({
    id: crypto.randomUUID(),
    name,
    status: "Received",
    confidence: 94,
    uploadedAt: "2026-06-04",
    extracted: {}
  }));
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const parsed = JSON.parse(saved);
    return {
      rules: parsed.rules || structuredClone(defaultRules),
      applications: (parsed.applications || []).map(normalizeApplication),
      reviewQueue: parsed.reviewQueue || [],
      integrations: parsed.integrations || structuredClone(integrationDefaults),
      user: parsed.user || { role: "rm", name: "Asha Nair" }
    };
  }
  return {
    rules: structuredClone(defaultRules),
    applications: structuredClone(demoApplications).map(normalizeApplication),
    reviewQueue: [],
    integrations: structuredClone(integrationDefaults),
    user: { role: "rm", name: "Asha Nair" }
  };
}

function normalizeApplication(app) {
  return {
    mobile: "+91 90000 00000",
    email: "customer@example.com",
    manager: "Prakash Menon",
    createdAt: "2026-06-01",
    lastActivityAt: "2026-06-01",
    customerIntent: "Warm",
    source: "Branch",
    documents: [],
    tasks: [],
    timeline: [],
    notes: [],
    ...app,
    documents: (app.documents || []).map((doc) => typeof doc === "string" ? {
      id: crypto.randomUUID(),
      name: doc,
      status: "Received",
      confidence: 90,
      uploadedAt: "2026-06-04",
      extracted: {}
    } : { id: crypto.randomUUID(), confidence: 90, extracted: {}, ...doc }),
    tasks: (app.tasks || []).map((item) => ({ id: crypto.randomUUID(), status: "Open", priority: "Medium", ...item })),
    timeline: app.timeline || app.history || [],
    notes: app.notes || []
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!backendOnline) return;
  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(() => {
    fetch(`${API_BASE}/api/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    }).catch(() => {
      backendOnline = false;
      renderBackendStatus();
    });
  }, 180);
}

async function hydrateFromBackend() {
  try {
    const response = await fetch(`${API_BASE}/api/state`, { cache: "no-store" });
    if (!response.ok) throw new Error("Backend unavailable");
    const backendState = await response.json();
    state = {
      rules: backendState.rules || structuredClone(defaultRules),
      applications: (backendState.applications || []).map(normalizeApplication),
      reviewQueue: backendState.reviewQueue || [],
      integrations: backendState.integrations || structuredClone(integrationDefaults),
      user: backendState.user || { role: "rm", name: "Asha Nair" }
    };
    selectedApplicationId = state.applications[0]?.id;
    backendOnline = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    renderAll();
  } catch {
    backendOnline = false;
  }
  renderBackendStatus();
}

function renderBackendStatus() {
  const existing = document.getElementById("backendStatus");
  const text = backendOnline ? "Backend: SQLite API connected" : "Backend: browser fallback";
  const className = backendOnline ? "pill complete" : "pill medium";
  if (existing) {
    existing.textContent = text;
    existing.className = className;
    return;
  }
  const topActions = document.querySelector(".top-actions");
  if (!topActions) return;
  const badge = document.createElement("span");
  badge.id = "backendStatus";
  badge.className = className;
  badge.textContent = text;
  topActions.prepend(badge);
}

function registerMobileAppShell() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    renderInstallHint();
  });
  renderInstallHint();
}

function renderInstallHint() {
  if (document.getElementById("mobileInstallHint")) return;
  const hint = document.createElement("div");
  hint.id = "mobileInstallHint";
  hint.className = "mobile-install-hint";
  hint.innerHTML = `
    <span>Mobile app ready</span>
    <button id="installAppBtn" class="mini-btn" type="button">Install</button>
  `;
  document.body.appendChild(hint);
  document.getElementById("installAppBtn").addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
    } else {
      alert("Use your browser menu and choose Add to Home screen or Install app.");
    }
  });
}

function today() {
  return "2026-06-05";
}

function daysSince(dateValue) {
  const start = new Date(`${dateValue}T00:00:00`);
  const end = new Date(`${today()}T00:00:00`);
  return Math.max(0, Math.round((end - start) / 86400000));
}

function formatMoney(value) {
  if (value >= 10000000) return `Rs. ${(value / 10000000).toFixed(1)}Cr`;
  if (value >= 100000) return `Rs. ${(value / 100000).toFixed(1)}L`;
  return `Rs. ${Number(value || 0).toLocaleString("en-IN")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function requiredDocs(app) {
  return state.rules[app.product] || [];
}

function receivedDocNames(app) {
  return app.documents.filter((doc) => doc.status === "Received").map((doc) => doc.name);
}

function missingDocs(app) {
  const received = receivedDocNames(app);
  return requiredDocs(app).filter((doc) => doc.mandatory && !received.includes(doc.name));
}

function completionScore(app) {
  const docs = requiredDocs(app);
  const received = receivedDocNames(app);
  const totalDocWeight = docs.reduce((sum, doc) => sum + doc.weight, 0) || 1;
  const docScore = docs.filter((doc) => received.includes(doc.name)).reduce((sum, doc) => sum + doc.weight, 0) / totalDocWeight * 55;
  const stageScore = {
    "Lead Captured": 6,
    "Document Collection": 14,
    Verification: 26,
    Approval: 36,
    Disbursement: 42,
    Completed: 45
  }[app.stage] || 10;
  const followUpScore = Math.max(0, 12 - daysSince(app.lastActivityAt) * 2);
  return Math.min(100, Math.round(docScore + stageScore + followUpScore));
}

function riskScore(app) {
  const missingPenalty = missingDocs(app).reduce((sum, doc) => sum + Math.max(8, doc.weight), 0);
  const stalePenalty = daysSince(app.lastActivityAt) * 9;
  const overduePenalty = app.tasks.filter((item) => item.status === "Open" && item.dueDate < today()).length * 12;
  const intentRelief = app.customerIntent === "Hot" ? -8 : app.customerIntent === "Cold" ? 10 : 0;
  const stagePenalty = app.stage === "Document Collection" ? 8 : app.stage === "Approval" ? 4 : 0;
  return Math.max(0, Math.min(100, Math.round(missingPenalty + stalePenalty + overduePenalty + intentRelief + stagePenalty)));
}

function riskBand(score) {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function riskReason(app) {
  const missing = missingDocs(app).map((doc) => doc.name);
  const staleDays = daysSince(app.lastActivityAt);
  const overdue = app.tasks.filter((item) => item.status === "Open" && item.dueDate < today()).length;
  const reasons = [];
  if (missing.length) reasons.push(`${missing.join(", ")} missing`);
  if (staleDays >= 3) reasons.push(`no activity for ${staleDays} days`);
  if (overdue) reasons.push(`${overdue} overdue task${overdue > 1 ? "s" : ""}`);
  return reasons.join("; ") || "application is progressing normally";
}

function recommendation(app) {
  const missing = missingDocs(app);
  if (missing.length) return `Collect ${missing[0].name} and send customer follow-up.`;
  const overdue = app.tasks.find((item) => item.status === "Open" && item.dueDate < today());
  if (overdue) return `Close overdue task: ${overdue.title}.`;
  if (app.stage !== "Completed" && completionScore(app) >= 85) return "Advance the application to the next stage.";
  return "Keep the next customer touchpoint fresh and monitor SLA.";
}

function findApp(id = selectedApplicationId) {
  return state.applications.find((app) => app.id === id) || state.applications[0];
}

function pushTimeline(app, entry) {
  app.timeline.unshift(`${today()} - ${entry}`);
  app.lastActivityAt = today();
  saveState();
}

function createFollowUp(app, channel = "Call") {
  const missing = missingDocs(app);
  const title = missing.length ? `${channel}: request ${missing[0].name}` : `${channel}: share application status`;
  app.tasks.unshift(task(title, channel, app.rm, today(), "Open", missing.length ? "High" : "Medium"));
  pushTimeline(app, `${channel} follow-up task created`);
}

function draftFollowUp(app, channel = "WhatsApp") {
  const missing = missingDocs(app);
  if (missing.length) {
    return `${channel}: Dear ${app.customer}, your ${app.product} application is pending ${missing[0].name}. Please share it today so we can continue processing.`;
  }
  return `${channel}: Dear ${app.customer}, your ${app.product} application is currently at ${app.stage}. We will update you shortly on the next step.`;
}

function advanceStage(app) {
  const index = stageOrder.indexOf(app.stage);
  if (index >= 0 && index < stageOrder.length - 1) {
    app.stage = stageOrder[index + 1];
    pushTimeline(app, `Stage advanced to ${app.stage}`);
  }
}

function addDocument(app, docName, extracted = {}, confidence = 92) {
  const existing = app.documents.find((doc) => doc.name === docName);
  if (existing) {
    existing.status = "Received";
    existing.extracted = { ...existing.extracted, ...extracted };
    existing.confidence = confidence;
    existing.uploadedAt = today();
  } else {
    app.documents.push({ id: crypto.randomUUID(), name: docName, status: "Received", confidence, uploadedAt: today(), extracted });
  }
  app.tasks.forEach((item) => {
    if (item.status === "Open" && item.title.toLowerCase().includes(docName.toLowerCase())) item.status = "Done";
  });
  pushTimeline(app, `${docName} received and linked to application`);
}

function renderMetrics() {
  const apps = state.applications;
  const active = apps.filter((app) => app.stage !== "Completed").length;
  const highRisk = apps.filter((app) => riskScore(app) >= 70).length;
  const avgCompletion = Math.round(apps.reduce((sum, app) => sum + completionScore(app), 0) / Math.max(1, apps.length));
  const revenueAtRisk = apps.filter((app) => riskScore(app) >= 60).reduce((sum, app) => sum + app.value, 0);
  document.getElementById("sidebarRevenue").textContent = formatMoney(revenueAtRisk);

  const metrics = [
    ["Active Applications", active, "Open applications being monitored"],
    ["Avg Completion", `${avgCompletion}%`, "Weighted readiness score"],
    ["High Risk", highRisk, "Need intervention today"],
    ["Revenue at Risk", formatMoney(revenueAtRisk), "Likely leakage exposure"]
  ];

  document.getElementById("metricsGrid").innerHTML = metrics.map(([label, value, helper]) => `
    <article class="metric">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${helper}</small>
    </article>
  `).join("");
}

function renderApplicationList() {
  const query = document.getElementById("applicationSearch").value.toLowerCase();
  const list = [...state.applications]
    .filter((app) => {
      const text = `${app.customer} ${app.product} ${app.rm} ${app.branch} ${app.stage}`.toLowerCase();
      const filterMatch = activeFilter === "all" || (activeFilter === "high" && riskScore(app) >= 70) || (activeFilter === "missing" && missingDocs(app).length) || app.stage === activeFilter;
      return text.includes(query) && filterMatch;
    })
    .sort((a, b) => riskScore(b) - riskScore(a));

  document.getElementById("applicationList").innerHTML = `
    <div class="filter-row">
      ${["all", "high", "missing", "Document Collection", "Verification", "Approval"].map((filter) => `
        <button class="chip ${activeFilter === filter ? "active" : ""}" data-filter="${filter}">${filter === "all" ? "All" : filter}</button>
      `).join("")}
    </div>
    ${list.map((app) => {
      const completion = completionScore(app);
      const risk = riskScore(app);
      const band = riskBand(risk);
      return `
        <button class="app-card ${app.id === selectedApplicationId ? "active" : ""}" data-app-id="${app.id}">
          <div class="app-title">
            <div>
              <strong>${escapeHtml(app.customer)}</strong>
              <div class="meta-row">${app.id} - ${app.product} - ${app.stage}</div>
            </div>
            <span class="pill ${band}">${risk}% RISK</span>
          </div>
          <div class="progress"><span style="width:${completion}%"></span></div>
          <div class="meta-row">
            <span>${completion}% complete</span>
            <span>${missingDocs(app).length} missing</span>
            <span>${app.rm}</span>
          </div>
        </button>
      `;
    }).join("") || `<div class="empty-state">No matching applications.</div>`}
  `;

  document.querySelectorAll(".chip[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      renderApplicationList();
    });
  });
  document.querySelectorAll(".app-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedApplicationId = card.dataset.appId;
      renderAll();
    });
  });
}

function renderApplicationDetail() {
  const app = findApp();
  const completion = completionScore(app);
  const risk = riskScore(app);
  const missing = missingDocs(app);
  document.getElementById("applicationDetail").innerHTML = `
    <div class="panel-head">
      <div>
        <h2>${escapeHtml(app.customer)}</h2>
        <p>${app.id} - ${app.product} - ${app.branch}</p>
      </div>
      <span class="pill ${riskBand(risk)}">${risk}% RISK</span>
    </div>

    <div class="detail-grid">
      <div class="detail-item"><span>Assigned RM</span><strong>${app.rm}</strong></div>
      <div class="detail-item"><span>Manager</span><strong>${app.manager}</strong></div>
      <div class="detail-item"><span>Stage</span><strong>${app.stage}</strong></div>
      <div class="detail-item"><span>Completion</span><strong>${completion}%</strong></div>
      <div class="detail-item"><span>Value</span><strong>${formatMoney(app.value)}</strong></div>
      <div class="detail-item"><span>Last Activity</span><strong>${daysSince(app.lastActivityAt)} days ago</strong></div>
    </div>

    <div class="action-row">
      <button class="primary-btn" data-action="advance">Advance Stage</button>
      <button class="ghost-btn" data-action="call">Create Call Task</button>
      <button class="ghost-btn" data-action="whatsapp">Create WhatsApp Task</button>
      <button class="ghost-btn" data-action="export-one">Export JSON</button>
    </div>

    <div class="recommendation">
      <strong>Copilot next action</strong>
      <p>${recommendation(app)}</p>
      <small>Reason: ${riskReason(app)}</small>
    </div>

    <h3>Customer Profile</h3>
    <div class="detail-grid">
      <div class="detail-item"><span>Mobile</span><strong>${app.mobile}</strong></div>
      <div class="detail-item"><span>Email</span><strong>${app.email}</strong></div>
      <div class="detail-item"><span>Intent</span><strong>${app.customerIntent}</strong></div>
      <div class="detail-item"><span>Source</span><strong>${app.source}</strong></div>
      <div class="detail-item"><span>PAN Verification</span><strong>${app.identity?.pan?.status || "Pending"}</strong></div>
      <div class="detail-item"><span>Aadhaar Verification</span><strong>${app.identity?.aadhaar?.status || "Pending"}</strong></div>
    </div>

    <h3>Document Checklist</h3>
    <div class="doc-list">
      ${requiredDocs(app).map((doc) => {
        const received = app.documents.find((item) => item.name === doc.name && item.status === "Received");
        return `
          <div class="doc-row">
            <div>
              <strong>${doc.name}</strong>
              <small>${doc.mandatory ? "Mandatory" : "Optional"} - ${doc.weight} weight${received ? ` - ${received.confidence}% confidence` : ""}</small>
            </div>
            <div class="row-actions">
              <span class="pill ${received ? "complete" : "missing"}">${received ? "Received" : "Missing"}</span>
              <button class="mini-btn" data-upload-doc="${doc.name}">Upload & Scan</button>
              ${received ? "" : `<button class="mini-btn" data-doc="${doc.name}">Mark Received</button>`}
            </div>
          </div>
        `;
      }).join("")}
    </div>

    <h3>Open Tasks</h3>
    <div class="compact-list">
      ${app.tasks.map((item) => `
        <div class="compact-row task-row">
          <div>
            <strong>${item.title}</strong>
            <p>${item.type} - ${item.owner} - due ${item.dueDate} - ${item.priority}</p>
          </div>
          <button class="mini-btn" data-task="${item.id}">${item.status === "Done" ? "Reopen" : "Done"}</button>
        </div>
      `).join("") || `<div class="compact-row">No tasks yet.</div>`}
    </div>

    <h3>Add Note</h3>
    <form id="noteForm" class="inline-form">
      <input name="note" placeholder="Add customer conversation or internal note" required />
      <button class="primary-btn" type="submit">Add</button>
    </form>

    <h3>Notes</h3>
    <div class="compact-list">${app.notes.map((note) => `<div class="compact-row">${escapeHtml(note)}</div>`).join("") || `<div class="compact-row">No notes.</div>`}</div>

    <h3>Audit Timeline</h3>
    <div class="compact-list">${app.timeline.map((item) => `<div class="compact-row">${escapeHtml(item)}</div>`).join("")}</div>
  `;

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.action === "advance") advanceStage(app);
      if (button.dataset.action === "call") createFollowUp(app, "Call");
      if (button.dataset.action === "whatsapp") createFollowUp(app, "WhatsApp");
      if (button.dataset.action === "export-one") downloadJson(`${app.id}.json`, app);
      renderAll();
    });
  });
  document.querySelectorAll("[data-doc]").forEach((button) => {
    button.addEventListener("click", () => {
      addDocument(app, button.dataset.doc, {}, 88);
      renderAll();
    });
  });
  document.querySelectorAll("[data-upload-doc]").forEach((button) => {
    button.addEventListener("click", () => openApplicantUpload(app.id, button.dataset.uploadDoc));
  });
  document.querySelectorAll("[data-task]").forEach((button) => {
    button.addEventListener("click", () => {
      const taskItem = app.tasks.find((item) => item.id === button.dataset.task);
      taskItem.status = taskItem.status === "Done" ? "Open" : "Done";
      pushTimeline(app, `Task ${taskItem.status.toLowerCase()}: ${taskItem.title}`);
      renderAll();
    });
  });
  document.getElementById("noteForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const note = new FormData(event.target).get("note");
    app.notes.unshift(`${today()} - ${note}`);
    pushTimeline(app, "Note added");
    renderAll();
  });
}

function renderTasks() {
  const openTasks = state.applications.flatMap((app) => app.tasks.map((item) => ({ ...item, app })))
    .filter((item) => item.status === "Open")
    .sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));
  document.getElementById("taskList").innerHTML = openTasks.map((item) => `
    <article class="task-card">
      <div class="app-title">
        <strong>${item.title}</strong>
        <span class="pill ${item.priority === "High" ? "high" : "medium"}">${item.priority}</span>
      </div>
      <div class="meta-row">
        <span>${item.app.customer}</span>
        <span>${item.app.product}</span>
        <span>Due ${item.dueDate}</span>
      </div>
      <p>${draftFollowUp(item.app, item.type === "Call" ? "Call" : "WhatsApp")}</p>
      <button class="mini-btn" data-task-done="${item.app.id}:${item.id}">Mark Done</button>
    </article>
  `).join("") || `<div class="empty-state">No open tasks. Nice and clean.</div>`;

  document.querySelectorAll("[data-task-done]").forEach((button) => {
    button.addEventListener("click", () => {
      const [appId, taskId] = button.dataset.taskDone.split(":");
      const app = findApp(appId);
      const item = app.tasks.find((taskItem) => taskItem.id === taskId);
      item.status = "Done";
      pushTimeline(app, `Task completed: ${item.title}`);
      renderAll();
    });
  });
}

function allOpenTasks() {
  return state.applications.flatMap((app) => app.tasks.map((item) => ({ ...item, app })))
    .filter((item) => item.status === "Open")
    .sort((a, b) => {
      if (a.dueDate !== b.dueDate) return a.dueDate > b.dueDate ? 1 : -1;
      return riskScore(b.app) - riskScore(a.app);
    });
}

function renderFollowups() {
  const filter = document.getElementById("followupChannelFilter")?.value || "all";
  const queue = allOpenTasks().filter((item) => filter === "all" || item.type === filter);
  const composer = document.getElementById("composerApplication");
  if (composer) {
    const current = composer.value;
    composer.innerHTML = state.applications.map((app) => `<option value="${app.id}">${app.customer} - ${app.product}</option>`).join("");
    if (current) composer.value = current;
  }

  document.getElementById("followupQueue").innerHTML = queue.map((item) => `
    <article class="task-card">
      <div class="app-title">
        <strong>${item.title}</strong>
        <span class="pill ${item.priority === "High" ? "high" : "medium"}">${item.priority}</span>
      </div>
      <div class="meta-row">
        <span>${item.type}</span>
        <span>${item.app.customer}</span>
        <span>${item.app.mobile}</span>
        <span>Due ${item.dueDate}</span>
        <span>${riskScore(item.app)} risk</span>
      </div>
      <p>${draftFollowUp(item.app, item.type === "Document" ? "WhatsApp" : item.type)}</p>
      <div class="action-row">
        <button class="mini-btn" data-followup-done="${item.app.id}:${item.id}">Mark Done</button>
        <button class="mini-btn" data-followup-compose="${item.app.id}:${item.type}">Compose</button>
      </div>
    </article>
  `).join("") || `<div class="empty-state">No follow-ups for this filter.</div>`;

  document.querySelectorAll("[data-followup-done]").forEach((button) => {
    button.addEventListener("click", () => {
      const [appId, taskId] = button.dataset.followupDone.split(":");
      const app = findApp(appId);
      const item = app.tasks.find((taskItem) => taskItem.id === taskId);
      item.status = "Done";
      pushTimeline(app, `Follow-up completed: ${item.title}`);
      renderAll();
    });
  });

  document.querySelectorAll("[data-followup-compose]").forEach((button) => {
    button.addEventListener("click", () => {
      const [appId, channel] = button.dataset.followupCompose.split(":");
      document.getElementById("composerApplication").value = appId;
      document.getElementById("composerChannel").value = ["Call", "SMS", "Email", "WhatsApp"].includes(channel) ? channel : "WhatsApp";
      composeFollowUp();
    });
  });
}

function composeFollowUp() {
  const app = findApp(document.getElementById("composerApplication").value);
  const channel = document.getElementById("composerChannel").value;
  const output = document.getElementById("composerOutput");
  const message = draftFollowUp(app, channel);
  output.classList.remove("empty-state");
  output.innerHTML = `
    <div class="recommendation">
      <strong>${channel} follow-up for ${app.customer}</strong>
      <p>${escapeHtml(message)}</p>
    </div>
    <div class="detail-grid">
      <div class="detail-item"><span>Mobile</span><strong>${app.mobile}</strong></div>
      <div class="detail-item"><span>Email</span><strong>${app.email}</strong></div>
      <div class="detail-item"><span>Missing Docs</span><strong>${missingDocs(app).map((doc) => doc.name).join(", ") || "None"}</strong></div>
      <div class="detail-item"><span>Risk</span><strong>${riskScore(app)}%</strong></div>
    </div>
    <div class="action-row">
      <button class="mini-btn" id="logFollowupBtn">Log Follow-Up</button>
      <button class="mini-btn" id="createChannelTaskBtn">Create ${channel} Task</button>
    </div>
  `;
  document.getElementById("logFollowupBtn").addEventListener("click", () => {
    pushTimeline(app, `${channel} follow-up logged: ${message}`);
    renderAll();
  });
  document.getElementById("createChannelTaskBtn").addEventListener("click", () => {
    createFollowUp(app, channel);
    renderAll();
  });
}

function addMessage(role, text) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = text;
  document.getElementById("chatLog").appendChild(node);
  node.scrollIntoView({ block: "end" });
}

function renderChatInitial() {
  const chatLog = document.getElementById("chatLog");
  if (!chatLog.children.length) {
    addMessage("assistant", "Ask me about high-risk applications, missing documents, RM workload, revenue leakage, or next actions.");
  }
}

function answerQuestion(question) {
  const q = question.toLowerCase();
  const highRisk = state.applications.filter((app) => riskScore(app) >= 70).sort((a, b) => riskScore(b) - riskScore(a));
  if (q.includes("call") || q.includes("today") || q.includes("follow")) {
    return highRisk.length ? `Prioritize ${highRisk.map((app) => app.customer).join(", ")}. ${highRisk[0].customer} is highest risk because ${riskReason(highRisk[0])}.` : "No high-risk calls are urgent today. Work the oldest open verification tasks first.";
  }
  if (q.includes("missing") || q.includes("document")) {
    return state.applications.map((app) => `${app.customer}: ${missingDocs(app).map((doc) => doc.name).join(", ") || "complete"}`).join(" | ");
  }
  if (q.includes("revenue") || q.includes("leak")) {
    const value = highRisk.reduce((sum, app) => sum + app.value, 0);
    return `${formatMoney(value)} is exposed in high-risk applications. Top causes: document collection delay, stale follow-ups, and approval SLA slippage.`;
  }
  if (q.includes("rm") || q.includes("workload")) {
    return Object.entries(workloadBy("rm")).map(([name, apps]) => `${name}: ${apps.length} apps, ${apps.filter((app) => riskScore(app) >= 70).length} high-risk`).join(" | ");
  }
  if (q.includes("why") || q.includes("risk") || q.includes("stuck")) {
    return highRisk.map((app) => `${app.customer}: ${riskReason(app)}`).join(" | ") || "No application is currently high risk.";
  }
  return "Recommended operating rhythm: collect missing mandatory documents, close overdue tasks, advance applications above 85% completion, and review branch bottlenecks daily.";
}

function renderScannerApplications() {
  const select = document.getElementById("scannerApplication");
  const current = select.value;
  select.innerHTML = state.applications.map((app) => `<option value="${app.id}">${app.customer} - ${app.product}</option>`).join("");
  if (current) select.value = current;
}

function detectDocumentType(source) {
  const text = source.toLowerCase();
  const detectors = [
    ["GST Certificate", ["gst", "gstin"]],
    ["PAN", ["pan", "permanent account"]],
    ["Aadhaar", ["aadhaar", "uidai", "aadhar"]],
    ["Bank Statements", ["bank statement", "account statement", "statement"]],
    ["ITR", ["itr", "income tax return"]],
    ["Business Registration", ["registration", "udyam", "certificate of incorporation"]],
    ["Photo", ["photo", "passport photo"]],
    ["Signature", ["signature"]],
    ["Address Proof", ["address proof", "electricity bill", "utility bill"]],
    ["Salary Slips", ["salary slip", "pay slip", "payslip"]],
    ["Property Documents", ["property", "sale deed", "title deed"]]
  ];
  const match = detectors.find(([, keys]) => keys.some((key) => text.includes(key)));
  return match ? match[0] : "Unknown Document";
}

function extractFields(source) {
  const name = source.match(/(?:name|customer|applicant)\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60}?)(?=\s+(?:dob|date of birth|pan|aadhaar|gstin)\b|$)/i);
  const dob = source.match(/(?:dob|date of birth)\s*[:\-]?\s*([0-9]{2}[/-][0-9]{2}[/-][0-9]{4})/i);
  return {
    pan: source.match(/[A-Z]{5}[0-9]{4}[A-Z]/i)?.[0]?.toUpperCase() || "Not detected",
    gstin: source.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]/i)?.[0]?.toUpperCase() || "Not detected",
    aadhaar: source.match(/\b[0-9]{4}\s?[0-9]{4}\s?[0-9]{4}\b/)?.[0] || "Not detected",
    name: name?.[1]?.trim() || "Not detected",
    dob: dob?.[1] || "Not detected"
  };
}

function verifyIdentity(docType, fields) {
  if (docType === "PAN" && fields.pan !== "Not detected") {
    return { provider: "KYC MCP adapter", status: "Verified", verifiedFields: fields.name !== "Not detected" ? ["pan", "name"] : ["pan"], message: "PAN format verified. Ready for live MCP verification." };
  }
  if (docType === "Aadhaar" && fields.aadhaar !== "Not detected") {
    return { provider: "KYC MCP adapter", status: "Verified", verifiedFields: fields.name !== "Not detected" ? ["aadhaar", "name", "dob"] : ["aadhaar"], message: "Aadhaar format verified. Ready for live MCP verification." };
  }
  return { provider: "KYC MCP adapter", status: "Not applicable", verifiedFields: [], message: "No PAN/Aadhaar identifier found." };
}

function applyIdentityToApp(app, docType, fields, identity) {
  if (identity?.status !== "Verified") return;
  if (fields.name && fields.name !== "Not detected") app.customer = fields.name;
  app.identity = {
    ...(app.identity || {}),
    [docType.toLowerCase()]: {
      status: identity.status,
      fields,
      provider: identity.provider,
      verifiedAt: today()
    }
  };
}

function confidenceFor(docType, fields) {
  if (docType === "Unknown Document") return 35;
  const hasStrongField = fields.pan !== "Not detected" || fields.gstin !== "Not detected" || fields.aadhaar !== "Not detected";
  return hasStrongField ? 96 : 82;
}

function updateUploadPreview() {
  const file = document.getElementById("documentFile").files[0];
  const label = document.getElementById("selectedFileName");
  if (!label) return;
  label.textContent = file ? `Selected: ${file.name}` : "No file selected";
  autoReadFileInto(file, document.getElementById("documentText"), label);
}

function renderScanResult(app, docType, fields, confidence, result, reviewQueue = state.reviewQueue, identity = verifyIdentity(docType, fields)) {
  const attached = result === "attached";
  const resultBox = document.getElementById("scanResult");
  resultBox.classList.remove("empty-state");
  resultBox.innerHTML = `
    <div class="recommendation">
      <strong>${docType}</strong>
      <p>${attached ? "Document matched the checklist and was attached automatically." : "Document has been routed to manual review."}</p>
    </div>
    <div class="detail-grid">
      <div class="detail-item"><span>Application</span><strong>${app.customer}</strong></div>
      <div class="detail-item"><span>Status</span><strong>${attached ? "Attached" : "Manual review"}</strong></div>
      <div class="detail-item"><span>Confidence</span><strong>${confidence}%</strong></div>
      <div class="detail-item"><span>PAN</span><strong>${fields.pan}</strong></div>
      <div class="detail-item"><span>GSTIN</span><strong>${fields.gstin}</strong></div>
      <div class="detail-item"><span>Aadhaar</span><strong>${fields.aadhaar}</strong></div>
      <div class="detail-item"><span>Name</span><strong>${fields.name || "Not detected"}</strong></div>
      <div class="detail-item"><span>Identity</span><strong>${identity.status}</strong></div>
      <div class="detail-item"><span>New Completion</span><strong>${completionScore(app)}%</strong></div>
      <div class="detail-item"><span>Backend</span><strong>${backendOnline ? "SQLite API" : "Browser fallback"}</strong></div>
    </div>
    <h3>Manual Review Queue</h3>
    <div class="compact-list">${reviewQueue.slice(0, 5).map((item) => `
      <div class="compact-row task-row">
        <div><strong>${item.docType}</strong><p>${item.customer} - ${item.reason} - ${item.confidence}%</p></div>
        <button class="mini-btn" data-review="${item.id}">Approve</button>
      </div>
    `).join("") || `<div class="compact-row">No review items.</div>`}</div>
  `;
  bindReviewButtons();
}

function openApplicantUpload(appId, expectedDoc) {
  const app = findApp(appId);
  document.getElementById("uploadAppId").value = appId;
  document.getElementById("uploadExpectedDoc").value = expectedDoc;
  document.getElementById("applicantUploadContext").textContent = `${app.customer} - expected document: ${expectedDoc}`;
  document.getElementById("applicantDocumentText").value = "";
  document.getElementById("applicantDocumentFile").value = "";
  document.getElementById("applicantSelectedFileName").textContent = "No file selected";
  document.getElementById("applicantUploadResult").className = "scan-result empty-state";
  document.getElementById("applicantUploadResult").textContent = "No upload scanned yet.";
  document.getElementById("applicantUploadModal").classList.add("open");
  document.getElementById("applicantUploadModal").setAttribute("aria-hidden", "false");
}

function closeApplicantUpload() {
  document.getElementById("applicantUploadModal").classList.remove("open");
  document.getElementById("applicantUploadModal").setAttribute("aria-hidden", "true");
}

function updateApplicantUploadPreview() {
  const file = document.getElementById("applicantDocumentFile").files[0];
  document.getElementById("applicantSelectedFileName").textContent = file ? `Selected: ${file.name}` : "No file selected";
  autoReadFileInto(file, document.getElementById("applicantDocumentText"), document.getElementById("applicantSelectedFileName"));
}

function canReadAsText(file) {
  if (!file) return false;
  const name = file.name.toLowerCase();
  return file.type.startsWith("text/") || [".txt", ".csv", ".json"].some((ext) => name.endsWith(ext));
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function autoReadFileInto(file, textarea, label) {
  if (!file || !textarea) return "";
  if (!canReadAsText(file)) {
    if (label) label.textContent = `Selected: ${file.name} - OCR adapter will process this file type`;
    return "";
  }
  try {
    const text = await readFileAsText(file);
    textarea.value = text;
    if (label) label.textContent = `Selected: ${file.name} - text read automatically`;
    return text;
  } catch {
    if (label) label.textContent = `Selected: ${file.name} - could not auto-read text`;
    return "";
  }
}

function renderApplicantUploadResult(app, docType, fields, confidence, result, identity, ocr) {
  const attached = result === "attached";
  const box = document.getElementById("applicantUploadResult");
  box.classList.remove("empty-state");
  box.innerHTML = `
    <div class="recommendation">
      <strong>${docType} ${attached ? "attached" : "sent to review"}</strong>
      <p>${ocr?.message || identity?.message || "Document scanned and processed."}</p>
    </div>
    <div class="detail-grid">
      <div class="detail-item"><span>Applicant</span><strong>${escapeHtml(app.customer)}</strong></div>
      <div class="detail-item"><span>Identity Status</span><strong>${identity?.status || "Not applicable"}</strong></div>
      <div class="detail-item"><span>OCR Status</span><strong>${ocr?.status || "Processed"}</strong></div>
      <div class="detail-item"><span>Name</span><strong>${fields.name || "Not detected"}</strong></div>
      <div class="detail-item"><span>DOB</span><strong>${fields.dob || "Not detected"}</strong></div>
      <div class="detail-item"><span>PAN</span><strong>${fields.pan}</strong></div>
      <div class="detail-item"><span>Aadhaar</span><strong>${fields.aadhaar}</strong></div>
      <div class="detail-item"><span>Confidence</span><strong>${confidence}%</strong></div>
      <div class="detail-item"><span>Completion</span><strong>${completionScore(app)}%</strong></div>
    </div>
  `;
}

async function scanApplicantUpload(event) {
  event.preventDefault();
  const appId = document.getElementById("uploadAppId").value;
  const expectedDoc = document.getElementById("uploadExpectedDoc").value;
  const file = document.getElementById("applicantDocumentFile").files[0];
  const textarea = document.getElementById("applicantDocumentText");
  let text = textarea.value;
  if (file && !text.trim()) {
    text = await autoReadFileInto(file, textarea, document.getElementById("applicantSelectedFileName"));
  }
  const fileData = file && !text.trim() ? await readFileAsDataUrl(file) : "";
  const source = `${file?.name || expectedDoc} ${text}`;
  const box = document.getElementById("applicantUploadResult");

  if (!source.trim()) {
    box.classList.remove("empty-state");
    box.innerHTML = `<div class="recommendation"><strong>No document selected</strong><p>Please select a file or paste visible document text.</p></div>`;
    return;
  }

  box.classList.remove("empty-state");
  box.innerHTML = `<div class="recommendation"><strong>Scanning ${expectedDoc}...</strong><p>Extracting fields, verifying identity, and attaching to applicant.</p></div>`;

  if (backendOnline) {
    try {
      const response = await fetch(`${API_BASE}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, expectedDoc, filename: file?.name || expectedDoc, text, fileData })
      });
      if (!response.ok) throw new Error("Applicant scan failed");
      const payload = await response.json();
      state = {
        rules: payload.state.rules || structuredClone(defaultRules),
        applications: (payload.state.applications || []).map(normalizeApplication),
        reviewQueue: payload.state.reviewQueue || [],
        integrations: payload.state.integrations || structuredClone(integrationDefaults),
        user: payload.state.user || { role: "rm", name: "Asha Nair" }
      };
      selectedApplicationId = appId;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderAll();
      renderApplicantUploadResult(findApp(appId), payload.docType, payload.fields, payload.confidence, payload.result, payload.identity, payload.ocr);
      return;
    } catch {
      backendOnline = false;
      renderBackendStatus();
    }
  }

  const app = findApp(appId);
  let docType = detectDocumentType(source);
  if (["PAN", "Aadhaar"].includes(expectedDoc) && docType === "Unknown Document") docType = expectedDoc;
  const fields = extractFields(source);
  const confidence = confidenceFor(docType, fields);
  const identity = verifyIdentity(docType, fields);
  const needed = requiredDocs(app).some((doc) => doc.name === docType);
  if (needed && confidence >= 75) {
    addDocument(app, docType, fields, confidence);
    applyIdentityToApp(app, docType, fields, identity);
    renderApplicantUploadResult(app, docType, fields, confidence, "attached", identity);
  } else {
    state.reviewQueue.unshift({ id: crypto.randomUUID(), appId, customer: app.customer, docType, confidence, fields, reason: needed ? "Low confidence" : "Document not required for selected product", createdAt: today() });
    pushTimeline(app, `${docType} sent to manual review`);
    renderApplicantUploadResult(app, docType, fields, confidence, "review", identity);
  }
  saveState();
  renderAll();
}

async function scanDocument() {
  const app = findApp(document.getElementById("scannerApplication").value);
  const file = document.getElementById("documentFile").files[0];
  const textArea = document.getElementById("documentText");
  let typedText = textArea.value;
  if (file && !typedText.trim()) {
    typedText = await autoReadFileInto(file, textArea, document.getElementById("selectedFileName"));
  }
  const fileData = file && !typedText.trim() ? await readFileAsDataUrl(file) : "";
  const source = `${file?.name || ""} ${typedText}`;
  const resultBox = document.getElementById("scanResult");

  if (!source.trim()) {
    resultBox.classList.remove("empty-state");
    resultBox.innerHTML = `
      <div class="recommendation">
        <strong>No document selected</strong>
        <p>Please choose a file or paste visible document text before scanning.</p>
      </div>
    `;
    return;
  }

  resultBox.classList.remove("empty-state");
  resultBox.innerHTML = `<div class="recommendation"><strong>Scanning document...</strong><p>Classifying document and validating against ${app.customer}'s checklist.</p></div>`;

  if (backendOnline) {
    try {
      const response = await fetch(`${API_BASE}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app.id, filename: file?.name || "", text: typedText, fileData })
      });
      if (!response.ok) throw new Error("Scan API failed");
      const payload = await response.json();
      state = {
        rules: payload.state.rules || structuredClone(defaultRules),
        applications: (payload.state.applications || []).map(normalizeApplication),
        reviewQueue: payload.state.reviewQueue || [],
        integrations: payload.state.integrations || structuredClone(integrationDefaults),
        user: payload.state.user || { role: "rm", name: "Asha Nair" }
      };
      selectedApplicationId = app.id;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderAll();
      renderScanResult(findApp(app.id), payload.docType, payload.fields, payload.confidence, payload.result, state.reviewQueue, payload.identity);
      return;
    } catch {
      backendOnline = false;
      renderBackendStatus();
    }
  }

  const docType = detectDocumentType(source);
  const fields = extractFields(source);
  const confidence = confidenceFor(docType, fields);
  const needed = requiredDocs(app).some((doc) => doc.name === docType);
  const canAttach = needed && confidence >= 75;

  if (canAttach) {
    addDocument(app, docType, fields, confidence);
    applyIdentityToApp(app, docType, fields, verifyIdentity(docType, fields));
  } else {
    state.reviewQueue.unshift({
      id: crypto.randomUUID(),
      appId: app.id,
      customer: app.customer,
      docType,
      confidence,
      fields,
      reason: needed ? "Low confidence" : "Document not required for selected product",
      createdAt: today()
    });
    pushTimeline(app, `${docType} sent to manual review`);
  }
  saveState();
  selectedApplicationId = app.id;
  renderAll();
  renderScanResult(app, docType, fields, confidence, canAttach ? "attached" : "review", state.reviewQueue, verifyIdentity(docType, fields));
}

function bindReviewButtons() {
  document.querySelectorAll("[data-review]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.reviewQueue.find((review) => review.id === button.dataset.review);
      if (!item) return;
      const app = findApp(item.appId);
      addDocument(app, item.docType, item.fields, item.confidence);
      state.reviewQueue = state.reviewQueue.filter((review) => review.id !== item.id);
      saveState();
      renderAll();
    });
  });
}

function workloadBy(key) {
  return state.applications.reduce((acc, app) => {
    acc[app[key]] = acc[app[key]] || [];
    acc[app[key]].push(app);
    return acc;
  }, {});
}

function renderManager() {
  document.getElementById("riskList").innerHTML = [...state.applications]
    .sort((a, b) => riskScore(b) - riskScore(a))
    .slice(0, 6)
    .map((app) => `<div class="compact-row"><strong>${app.customer}</strong><p>${riskScore(app)} risk - ${riskReason(app)}</p></div>`)
    .join("");

  document.getElementById("workloadList").innerHTML = Object.entries(workloadBy("rm"))
    .map(([rm, apps]) => {
      const risky = apps.filter((app) => riskScore(app) >= 70).length;
      return `<div class="compact-row"><strong>${rm}</strong><p>${apps.length} active apps - ${risky} high-risk - ${formatMoney(apps.reduce((sum, app) => sum + app.value, 0))}</p></div>`;
    })
    .join("");

  const causes = rootCauses();
  document.getElementById("bottleneckList").innerHTML = causes
    .map(([cause, count]) => `<div class="compact-row"><strong>${cause}</strong><p>${count} impacted application${count > 1 ? "s" : ""}</p></div>`)
    .join("");
}

function rootCauses() {
  const causes = {};
  state.applications.forEach((app) => {
    missingDocs(app).forEach((doc) => {
      const label = `${doc.name} collection delay`;
      causes[label] = (causes[label] || 0) + 1;
    });
    if (daysSince(app.lastActivityAt) >= 3) causes["RM follow-up delay"] = (causes["RM follow-up delay"] || 0) + 1;
    if (app.stage === "Approval") causes["Approval turnaround"] = (causes["Approval turnaround"] || 0) + 1;
  });
  return Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 6);
}

function renderAnalytics() {
  const highRisk = state.applications.filter((app) => riskScore(app) >= 70);
  const totalLost = highRisk.reduce((sum, app) => sum + app.value, 0);
  const causes = rootCauses();
  const topCause = causes[0]?.[0] || "No major leakage cause";
  const cards = [
    ["Revenue at risk", formatMoney(totalLost), "Estimated open value exposed in high-risk applications."],
    ["Top root cause", topCause, "Most repeated cause across stalled applications."],
    ["Completion lift target", "+12%", "Expected lift if document and follow-up SLAs are enforced."],
    ["High-risk count", highRisk.length, "Applications requiring manager intervention."],
    ["Review queue", state.reviewQueue.length, "Documents waiting for manual validation."],
    ["Best action", "Clear docs", "Mandatory document gaps are the fastest recovery lever."]
  ];
  document.getElementById("analyticsGrid").innerHTML = cards.map(([title, value, text]) => `
    <article class="analytics-card">
      <strong>${value}</strong>
      <h3>${title}</h3>
      <p>${text}</p>
    </article>
  `).join("");
}

function renderRules() {
  document.getElementById("rulesTable").innerHTML = `
    <div class="recommendation">
      <strong>What the points mean</strong>
      <p>The number beside each document is its completion-score weight. Higher points mean that document has more impact on the application completion percentage and risk priority.</p>
    </div>
    ${Object.entries(state.rules).map(([product, docs]) => `
      <div class="rule-row">
        <strong>${product}</strong>
        <div class="rule-docs">${docs.map((doc) => `<span class="pill info">${doc.name} - ${doc.weight} pts</span>`).join("")}</div>
      </div>
    `).join("")}
    <form id="ruleForm" class="inline-form">
      <select name="product">${Object.keys(state.rules).map((product) => `<option>${product}</option>`).join("")}</select>
      <input name="doc" placeholder="New required document" required />
      <input name="weight" type="number" min="1" max="30" value="10" required />
      <button class="primary-btn" type="submit">Add Rule</button>
    </form>
    <div class="action-row">
      <button id="exportAllBtn" class="ghost-btn">Export All Data</button>
    </div>
  `;
  document.getElementById("ruleForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    state.rules[data.product].push({ name: data.doc, weight: Number(data.weight), fields: [], mandatory: true });
    saveState();
    renderAll();
  });
  document.getElementById("exportAllBtn").addEventListener("click", () => downloadJson("completion-iq-data.json", state));
}

function renderIntegrations() {
  const statusClass = (status) => status === "Connected" ? "complete" : status === "Ready for API" ? "medium" : "info";
  document.getElementById("integrationList").innerHTML = state.integrations.map((item) => `
    <div class="compact-row task-row">
      <div>
        <strong>${item.name}</strong>
        <p>${item.detail}</p>
      </div>
      <div class="row-actions">
        <span class="pill ${statusClass(item.status)}">${item.status}</span>
        <button class="mini-btn" data-integration="${item.id}">${item.status === "Connected" ? "Disable" : "Connect"}</button>
      </div>
    </div>
  `).join("");

  document.querySelectorAll("[data-integration]").forEach((button) => {
    button.addEventListener("click", () => {
      const integration = state.integrations.find((item) => item.id === button.dataset.integration);
      integration.status = integration.status === "Connected" ? "Planned" : "Connected";
      saveState();
      renderIntegrations();
      renderAnalytics();
    });
  });

  const blueprint = [
    ["Frontend", "Role-aware React/Next.js app for RM, manager, and operations teams."],
    ["Backend APIs", "Applications, documents, rules, tasks, audit timeline, scoring, and analytics services."],
    ["Database", "PostgreSQL tables for customers, applications, documents, tasks, events, and model outputs."],
    ["AI Layer", "LLM copilot with tool access to application data, OCR output, and workflow actions."],
    ["Document Processing", "OCR provider, file storage, extraction validation, and manual review queue."],
    ["Security", "RBAC, audit logs, encryption at rest, signed URLs, and PII access controls."]
  ];
  document.getElementById("blueprintList").innerHTML = blueprint.map(([title, body]) => `
    <div class="compact-row">
      <strong>${title}</strong>
      <p>${body}</p>
    </div>
  `).join("");
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function renderAll() {
  renderMetrics();
  renderApplicationList();
  renderApplicationDetail();
  renderTasks();
  renderFollowups();
  renderScannerApplications();
  renderManager();
  renderAnalytics();
  renderRules();
  renderIntegrations();
  renderChatInitial();
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
    button.classList.add("active");
    document.getElementById(`view-${button.dataset.view}`).classList.add("active");
    document.getElementById("pageTitle").textContent = views[button.dataset.view];
  });
});

document.getElementById("applicationSearch").addEventListener("input", renderApplicationList);

document.getElementById("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("chatInput");
  const question = input.value.trim();
  if (!question) return;
  addMessage("user", question);
  input.value = "";
  setTimeout(() => addMessage("assistant", answerQuestion(question)), 220);
});

document.getElementById("scanBtn").addEventListener("click", scanDocument);
document.getElementById("documentFile").addEventListener("change", updateUploadPreview);
document.getElementById("applicantDocumentFile").addEventListener("change", updateApplicantUploadPreview);
document.getElementById("applicantUploadForm").addEventListener("submit", scanApplicantUpload);
document.getElementById("closeApplicantUploadBtn").addEventListener("click", closeApplicantUpload);
document.getElementById("followupChannelFilter").addEventListener("change", renderFollowups);
document.getElementById("composeBtn").addEventListener("click", composeFollowUp);

document.getElementById("newApplicationBtn").addEventListener("click", () => {
  document.getElementById("applicationModal").classList.add("open");
  document.getElementById("applicationModal").setAttribute("aria-hidden", "false");
});

document.getElementById("closeModalBtn").addEventListener("click", () => {
  document.getElementById("applicationModal").classList.remove("open");
  document.getElementById("applicationModal").setAttribute("aria-hidden", "true");
});

document.getElementById("applicationForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  const app = normalizeApplication({
    id: `APP-${Math.floor(1100 + Math.random() * 8000)}`,
    customer: data.customer,
    mobile: data.mobile,
    email: data.email,
    product: data.product,
    rm: data.rm,
    manager: data.manager,
    branch: data.branch,
    stage: data.stage,
    value: Number(data.value),
    createdAt: today(),
    lastActivityAt: today(),
    customerIntent: data.customerIntent,
    source: data.source,
    documents: [],
    tasks: [task("Collect mandatory documents", "Document", data.rm, today(), "Open", "High")],
    timeline: [`${today()} - Application created`],
    notes: []
  });
  state.applications.unshift(app);
  selectedApplicationId = app.id;
  saveState();
  event.target.reset();
  document.getElementById("applicationModal").classList.remove("open");
  renderAll();
});

document.getElementById("resetDemoBtn").addEventListener("click", () => {
  state = {
    rules: structuredClone(defaultRules),
    applications: structuredClone(demoApplications).map(normalizeApplication),
    reviewQueue: [],
    integrations: structuredClone(integrationDefaults),
    user: { role: "rm", name: "Asha Nair" }
  };
  selectedApplicationId = state.applications[0].id;
  saveState();
  renderAll();
});

document.getElementById("roleSelect").addEventListener("change", (event) => {
  state.user.role = event.target.value;
  saveState();
  const targetView = event.target.value === "manager" ? "manager" : event.target.value === "admin" ? "admin" : "rm";
  document.querySelector(`[data-view="${targetView}"]`).click();
});

renderAll();
hydrateFromBackend();
registerMobileAppShell();
