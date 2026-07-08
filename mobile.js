const API_BASE = window.COMPLETION_IQ_API_BASE || "";
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const stageOrder = ["Lead Captured", "Document Collection", "Verification", "Approval", "Disbursement", "Completed"];

let state = { rules: {}, applications: [], reviewQueue: [], integrations: [], user: { role: "rm", name: "Asha Nair" } };
let selectedApplicationId = null;
const OFFLINE_QUEUE_KEY = "completionIqOfflineScans";

function today() {
  return "2026-06-05";
}

function daysSince(dateValue) {
  const start = new Date(`${dateValue}T00:00:00`);
  const end = new Date(`${today()}T00:00:00`);
  return Math.max(0, Math.round((end - start) / 86400000));
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

function getOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function setOfflineQueue(queue) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

function queueOfflineScan(payload) {
  const queue = getOfflineQueue();
  queue.push({ id: crypto.randomUUID(), createdAt: today(), payload });
  setOfflineQueue(queue);
  return queue.length;
}

function requiredDocs(app) {
  return state.rules[app.product] || [];
}

function productAccountType(product) {
  return ["Business Loan", "Home Loan"].includes(product) ? "Loan" : "Account Opening";
}

function productSegment(product) {
  return ["Business Loan", "Current Account"].includes(product) ? "Business" : "Personal";
}

function renderRequiredDocsPreview(product) {
  const node = document.getElementById("newRequiredDocs");
  if (!node) return;
  const docs = state.rules?.[product] || [];
  node.innerHTML = `
    <strong>Required Documents</strong>
    <span>${docs.filter((doc) => doc.mandatory).map((doc) => `${doc.name}${doc.fields?.length ? ` (${doc.fields.join(", ")})` : ""}`).join(" | ") || "Rules will load after sync."}</span>
  `;
}

function receivedDocNames(app) {
  return (app.documents || []).filter((doc) => doc.status === "Received").map((doc) => doc.name);
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
  const overduePenalty = (app.tasks || []).filter((item) => item.status === "Open" && item.dueDate < today()).length * 12;
  const intentRelief = app.customerIntent === "Hot" ? -8 : app.customerIntent === "Cold" ? 10 : 0;
  const stagePenalty = app.stage === "Document Collection" ? 8 : app.stage === "Approval" ? 4 : 0;
  return Math.max(0, Math.min(100, Math.round(missingPenalty + stalePenalty + overduePenalty + intentRelief + stagePenalty)));
}

function riskBand(score) {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "info";
}

function riskReason(app) {
  const missing = missingDocs(app).map((doc) => doc.name);
  const staleDays = daysSince(app.lastActivityAt);
  const reasons = [];
  if (missing.length) reasons.push(`${missing.join(", ")} missing`);
  if (staleDays >= 3) reasons.push(`no activity for ${staleDays} days`);
  return reasons.join("; ") || "progressing normally";
}

function money(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value || 0));
}

function latestDocumentIntel(app) {
  const docs = [...(app.documents || [])].reverse();
  return docs.find((doc) => doc.ai || doc.quality) || null;
}

function documentPreview(doc) {
  if (!doc) return "";
  return doc.previewDataUrl || doc.fileData || doc.dataUrl || "";
}

function documentCanView(doc) {
  return Boolean(documentPreview(doc));
}

function viewDocument(appId, docKey) {
  const app = findApp(appId);
  const doc = (app?.documents || []).find((item) => (item.id || item.name) === docKey || item.name === docKey);
  const src = documentPreview(doc);
  if (!doc) {
    alert("Document record was not found.");
    return;
  }
  const modal = document.createElement("div");
  modal.className = "doc-preview-modal";
  const isPdf = src.startsWith("data:application/pdf");
  const title = `${doc.name}${doc.filename ? ` - ${doc.filename}` : ""}`;
  modal.innerHTML = `
    <div class="doc-preview-panel">
      <div class="doc-preview-header">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(doc.quality?.status || "Original uploaded scan")} ${doc.confidence ? `- ${doc.confidence}% confidence` : ""}</span>
        </div>
        <button class="mini-btn" data-close-preview type="button">Close</button>
      </div>
      ${isPdf
        ? `<iframe class="doc-preview-frame" src="${src}" title="${escapeHtml(doc.name)} preview"></iframe>`
        : `<img class="doc-preview-image" src="${src}" alt="${escapeHtml(doc.name)} preview">`}
      <div class="quick-actions">
        <a class="mini-link" href="${src}" target="_blank" rel="noopener">Open Full Screen</a>
        <button class="mini-btn" data-close-preview type="button">Done</button>
      </div>
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest("[data-close-preview]")) {
      modal.remove();
    }
  });
  document.body.appendChild(modal);
}

function revenueLeakageRows() {
  return [...new Set(state.applications.map((app) => app.product))].sort().map((product) => {
    const apps = state.applications.filter((app) => app.product === product);
    const risky = apps.filter((app) => riskScore(app) >= 60);
    const drivers = {};
    apps.forEach((app) => missingDocs(app).forEach((doc) => {
      drivers[doc.name] = (drivers[doc.name] || 0) + 1;
    }));
    return {
      product,
      applications: apps.length,
      atRisk: risky.length,
      valueAtRisk: risky.reduce((sum, app) => sum + Number(app.value || 0), 0),
      driver: Object.keys(drivers).sort((a, b) => drivers[b] - drivers[a])[0] || "None"
    };
  });
}

function rmProductivityRows() {
  return [...new Set(state.applications.map((app) => app.rm))].sort().map((rm) => {
    const apps = state.applications.filter((app) => app.rm === rm);
    const openTasks = apps.reduce((sum, app) => sum + (app.tasks || []).filter((task) => task.status === "Open").length, 0);
    const avgCompletion = Math.round(apps.reduce((sum, app) => sum + completionScore(app), 0) / Math.max(1, apps.length));
    return { rm, applications: apps.length, openTasks, avgCompletion, highRisk: apps.filter((app) => riskScore(app) >= 60).length };
  });
}

function branchHeatmapRows() {
  return [...new Set(state.applications.map((app) => app.branch))].sort().map((branch) => {
    const apps = state.applications.filter((app) => app.branch === branch);
    const drivers = {};
    apps.forEach((app) => missingDocs(app).forEach((doc) => {
      drivers[doc.name] = (drivers[doc.name] || 0) + 1;
    }));
    return {
      branch,
      applications: apps.length,
      atRisk: apps.filter((app) => riskScore(app) >= 60).length,
      idleAvg: Math.round(apps.reduce((sum, app) => sum + daysSince(app.lastActivityAt), 0) / Math.max(1, apps.length)),
      bottleneck: Object.keys(drivers).sort((a, b) => drivers[b] - drivers[a])[0] || "None"
    };
  });
}

function slaRows() {
  return state.applications.map((app) => ({
    app,
    age: daysSince(app.createdAt),
    idle: daysSince(app.lastActivityAt),
    status: daysSince(app.lastActivityAt) >= 3 || daysSince(app.createdAt) >= 10 ? "Breached" : "On track"
  })).sort((a, b) => b.idle - a.idle);
}

function rootCauseRows() {
  const counts = {};
  state.applications.forEach((app) => {
    const missing = missingDocs(app);
    const reason = missing.length ? `${missing[0].name} delay` : daysSince(app.lastActivityAt) >= 3 ? "RM follow-up delay" : "Approval/document review delay";
    counts[reason] = (counts[reason] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count, share: Math.round(count / Math.max(1, state.applications.length) * 100) }));
}

function extractFields(source) {
  const name = source.match(/(?:name|customer|applicant)\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60}?)(?=\s+(?:dob|date of birth|pan|aadhaar|gstin)\b|$)/i);
  const dob = source.match(/(?:dob|date of birth)\s*[:\-]?\s*([0-9]{2}[/-][0-9]{2}[/-][0-9]{4})/i);
  const mobile = source.match(/(?:mobile|mobile no|phone)\s*(?:no\.?|number)?\s*[:\-]?\s*(?:\+91\s*)?([6-9][0-9]{9})/i) || source.match(/\b(?:\+91\s*)?([6-9][0-9]{9})\b/);
  const gender = /\bfemale\b/i.test(source) ? "Female" : /\bmale\b/i.test(source) ? "Male" : "Not detected";
  return {
    name: name?.[1]?.trim() || "Not detected",
    dob: dob?.[1] || "Not detected",
    mobile: mobile?.[1] || "Not detected",
    gender,
    pan: source.match(/[A-Z]{5}[0-9]{4}[A-Z]/i)?.[0]?.toUpperCase() || "Not detected",
    aadhaar: source.match(/\b[0-9]{4}\s?[0-9]{4}\s?[0-9]{4}\b/)?.[0] || "Not detected",
    gstin: source.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]/i)?.[0]?.toUpperCase() || "Not detected"
  };
}

function renderDetectedFields(message = "") {
  const text = document.getElementById("mobileDocText").value;
  const fields = extractFields(text);
  document.getElementById("mobileDetectedFields").innerHTML = `
    <strong>${message || "Detected fields"}</strong>
    <div class="detail-grid">
      <div class="detail-item"><span>Name</span><strong>${fields.name}</strong></div>
      <div class="detail-item"><span>DOB</span><strong>${fields.dob}</strong></div>
      <div class="detail-item"><span>Mobile</span><strong>${fields.mobile}</strong></div>
      <div class="detail-item"><span>Gender</span><strong>${fields.gender}</strong></div>
      <div class="detail-item"><span>PAN</span><strong>${fields.pan}</strong></div>
      <div class="detail-item"><span>Aadhaar</span><strong>${fields.aadhaar}</strong></div>
      <div class="detail-item"><span>GSTIN</span><strong>${fields.gstin}</strong></div>
    </div>
  `;
}

function findApp(id = selectedApplicationId) {
  return state.applications.find((app) => app.id === id) || state.applications[0];
}

async function loadState() {
  const badge = document.getElementById("syncBadge");
  badge.textContent = "Syncing";
  try {
    const response = await fetch(`${API_BASE}/api/state`, { cache: "no-store" });
    if (!response.ok) throw new Error("Backend unavailable");
    state = await response.json();
    selectedApplicationId = selectedApplicationId || state.applications[0]?.id;
    badge.textContent = "Synced";
    renderAll();
  } catch {
    badge.textContent = "Offline";
  }
}

async function saveState() {
  await fetch(`${API_BASE}/api/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state)
  });
  document.getElementById("syncBadge").textContent = "Synced";
}

async function deleteFromApi(path) {
  const response = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
  const payload = await response.json();
  if (!payload.ok) {
    alert(payload.error || "Action failed");
    return false;
  }
  state = payload.state;
  renderAll();
  return true;
}

async function deleteDocument(appId, docKey) {
  await deleteFromApi(`/api/applications/${encodeURIComponent(appId)}/documents/${encodeURIComponent(docKey)}`);
}

async function deleteApplication(appId) {
  const app = findApp(appId);
  if (!app) return;
  if (!confirm(`Delete application for ${app.customer}? This cannot be undone.`)) return;
  const ok = await deleteFromApi(`/api/applications/${encodeURIComponent(appId)}`);
  if (ok) {
    selectedApplicationId = state.applications[0]?.id || null;
    showScreen("home");
  }
}

function openEditApplicant(appId) {
  const app = findApp(appId);
  if (!app) return;
  selectedApplicationId = app.id;
  const form = document.getElementById("mobileEditForm");
  form.elements.id.value = app.id;
  form.elements.customer.value = app.customer || "";
  form.elements.mobile.value = app.mobile || "";
  form.elements.email.value = app.email || "";
  form.elements.product.value = app.product || "Savings Account";
  form.elements.customerSegment.value = app.customerSegment || productSegment(app.product);
  form.elements.accountType.value = app.accountType || productAccountType(app.product);
  form.elements.stage.value = app.stage || "Document Collection";
  form.elements.rm.value = app.rm || "";
  form.elements.manager.value = app.manager || "";
  form.elements.branch.value = app.branch || "";
  form.elements.value.value = app.value || 0;
  form.elements.customerIntent.value = app.customerIntent || "Warm";
  showScreen("edit");
}

async function updateApplicationFromForm(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());
  const app = findApp(data.id);
  if (!app) return;
  const submitButton = event.submitter || form.querySelector("button[type='submit']");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Saving...";
  }
  const updated = {
    ...app,
    customer: data.customer.trim(),
    mobile: data.mobile.trim(),
    email: data.email.trim(),
    product: data.product,
    customerSegment: data.customerSegment,
    accountType: data.accountType,
    stage: data.stage,
    rm: data.rm.trim(),
    manager: data.manager.trim(),
    branch: data.branch.trim(),
    value: Number(data.value || 0),
    customerIntent: data.customerIntent,
    lastActivityAt: today(),
    timeline: [`${today()} - Applicant details edited from mobile app`, ...(app.timeline || [])],
  };
  try {
    const response = await fetch(`${API_BASE}/api/applications/${encodeURIComponent(app.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated)
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Applicant could not be updated");
    state = payload.state;
    selectedApplicationId = app.id;
    document.getElementById("syncBadge").textContent = "Synced";
    renderAll();
    showScreen("detail");
  } catch (error) {
    document.getElementById("syncBadge").textContent = "Needs review";
    alert(error.message || "Applicant could not be updated. Please check backend connection.");
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Save Changes";
    }
  }
}

async function clearIdentity(appId, key) {
  await deleteFromApi(`/api/applications/${encodeURIComponent(appId)}/identity/${encodeURIComponent(key)}`);
}

async function dismissNotification(notificationId) {
  await deleteFromApi(`/api/notifications/${encodeURIComponent(notificationId)}`);
}

async function postAction(path, body = {}) {
  document.getElementById("syncBadge").textContent = "Working";
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!payload.ok) {
    document.getElementById("syncBadge").textContent = "Needs review";
    alert(payload.error || "Action failed");
    return payload;
  }
  if (payload.state) state = payload.state;
  document.getElementById("syncBadge").textContent = "Synced";
  renderAll();
  return payload;
}

function showWorkflowResult(title, message, extra = "") {
  const node = document.querySelector("#screen-detail.active #workflowResult")
    || document.querySelector("#screen-insights.active #insightsActionResult")
    || document.querySelector("#screen-scan.active #mobileScanResult")
    || document.getElementById("workflowResult")
    || document.getElementById("insightsActionResult")
    || document.getElementById("mobileScanResult");
  if (!node) return;
  node.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(message)}</span>
    ${extra}
  `;
}

function scanAlertIssues(payload) {
  const issues = [];
  if (payload.identityConsistency?.status === "Blocked") {
    issues.push(payload.identityConsistency.mismatches?.[0]?.message || "Identity cross-check is blocked.");
  }
  (payload.mismatches || []).forEach((item) => issues.push(item.message));
  (payload.duplicates || []).forEach((item) => issues.push(item.message));
  (payload.flags || []).filter((flag) => flag.severity === "High").forEach((flag) => issues.push(flag.message));
  if (payload.ai?.detectedDocType && payload.docType && payload.ai.detectedDocType !== "Unknown Document" && payload.ai.detectedDocType !== payload.docType) {
    issues.push(`Wrong document type: expected ${payload.docType}, scan looks like ${payload.ai.detectedDocType}.`);
  }
  if (payload.fields?.signatureStatus === "Missing") {
    issues.push("Signature is missing or unreadable.");
  }
  return [...new Set(issues.filter(Boolean))];
}

function showScanAlert(payload) {
  const issues = scanAlertIssues(payload);
  if (!issues.length) return;
  const modal = document.createElement("div");
  modal.className = "doc-preview-modal";
  modal.innerHTML = `
    <div class="doc-preview-panel scan-alert-panel">
      <div class="doc-preview-header">
        <div>
          <strong>Document Alert</strong>
          <span>${escapeHtml(payload.docType || "Uploaded document")} needs manual review before submission.</span>
        </div>
        <button class="mini-btn" data-close-preview type="button">Close</button>
      </div>
      <div class="mobile-result compact-result">
        ${issues.map((issue) => `<span>${escapeHtml(issue)}</span>`).join("")}
      </div>
      <div class="quick-actions">
        <button class="mini-btn" data-jump-correction type="button">Edit Extracted Fields</button>
        <button class="mini-btn danger-btn" data-close-preview type="button">Close</button>
      </div>
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest("[data-close-preview]")) modal.remove();
    if (event.target.closest("[data-jump-correction]")) {
      modal.remove();
      document.querySelector("[data-correction-form]")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
  document.body.appendChild(modal);
}

function renderCorrectionForm(payload) {
  if (!payload.reviewId && !payload.documentKey) return "";
  const fields = payload.fields || {};
  const targetType = payload.reviewId ? "review" : "document";
  const targetId = payload.reviewId || payload.documentKey;
  return `
    <div class="manual-correction" data-correction-form data-correction-target="${escapeHtml(targetType)}" data-correction-id="${escapeHtml(targetId)}" data-correction-app="${escapeHtml(payload.appId || "")}" data-correction-doc="${escapeHtml(payload.docType || "")}">
      <strong>Manual Correction</strong>
      <span>Edit OCR fields if the scan was blurry/dusty or a value was read incorrectly. This recalculates cross-checks.</span>
      <div class="correction-grid">
        ${["name", "dob", "pan", "aadhaar", "address", "mobile", "gender", "signatureStatus"].map((key) => `
          <label>
            <span>${key}</span>
            <input name="${key}" value="${escapeHtml(fields[key] || "")}" placeholder="Not detected">
          </label>
        `).join("")}
      </div>
      <button class="mini-btn" data-submit-correction type="button">Save Correction</button>
    </div>
  `;
}

async function sendReminder(appId) {
  const payload = await postAction(`/api/applications/${encodeURIComponent(appId)}/send-reminder`);
  if (payload.ok) {
    showWorkflowResult("WhatsApp reminder sent", payload.event?.payload?.message || "Reminder event was recorded.");
  }
}

async function syncCrm(appId) {
  const payload = await postAction(`/api/applications/${encodeURIComponent(appId)}/crm-sync`);
  if (payload.ok) {
    showWorkflowResult("CRM synced", `Stage, risk, and ${payload.event?.payload?.documents?.length || 0} document(s) were pushed to the CRM adapter.`);
  }
}

async function runKyc(appId) {
  const payload = await postAction(`/api/applications/${encodeURIComponent(appId)}/kyc-verify`);
  if (payload.ok) {
    showWorkflowResult("KYC adapter completed", `Status: ${payload.event?.status || "Completed"}. Verified: ${(payload.event?.payload?.verified || []).join(", ") || "None yet"}.`);
  }
}

async function generateCustomerLink(appId) {
  const payload = await postAction(`/api/applications/${encodeURIComponent(appId)}/customer-link`);
  if (payload.link?.url) {
    const fullUrl = `${location.origin}${payload.link.url}`;
    showWorkflowResult("Missing-document upload link", fullUrl, `<a class="mini-link" href="${fullUrl}" target="_blank" rel="noopener">Open upload portal</a>`);
  }
}

async function generateFormPrefill(appId) {
  const payload = await postAction(`/api/applications/${encodeURIComponent(appId)}/form-prefill`, {});
  if (payload.ok && payload.prefill) {
    const blob = new Blob([JSON.stringify(payload.prefill, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const forms = payload.prefill.forms.join(", ");
    showWorkflowResult(
      "Bharat Bank form prefill ready",
      `Mapped application data into: ${forms}`,
      `<a class="mini-link" href="${payload.prefill.downloadsUrl}" target="_blank" rel="noopener">Open official forms</a><a class="mini-link" href="${url}" download="${appId}-bharat-bank-prefill.json">Download prefill packet</a>`
    );
  }
}

async function reviewDecision(reviewId, decision) {
  const payload = await postAction(`/api/review/${encodeURIComponent(reviewId)}/${decision}`, { comment: `${decision} from mobile control tower` });
  if (payload.ok) {
    const label = decision === "approve" ? "approved" : "rejected";
    showWorkflowResult(`Review ${label}`, `The document review item was ${label} and the queue was updated.`);
  }
}

async function switchRole(role) {
  const payload = await postAction("/api/role", { role });
  if (payload.ok) {
    showWorkflowResult("Role switched", `Current role: ${payload.state.user.role} (${payload.state.user.name}).`);
  }
}

async function resetDemoData() {
  const payload = await postAction("/api/reset", {});
  if (payload.ok) {
    selectedApplicationId = payload.state.applications[0]?.id;
    showScreen("home");
  }
}

async function completeApplication(appId) {
  const payload = await postAction(`/api/applications/${encodeURIComponent(appId)}/complete`, {});
  if (payload.ok) {
    showWorkflowResult("Completion workflow", `Application moved to ${findApp(appId)?.stage || "next stage"}.`);
  } else if (payload.blockers?.length) {
    showWorkflowResult("Completion blocked", payload.blockers.join("; "));
  }
}

async function submitToBank(appId) {
  const payload = await postAction(`/api/applications/${encodeURIComponent(appId)}/submit-to-bank`, {});
  if (payload.ok) {
    const trackingUrl = `${location.origin}${payload.tracking?.ticket ? `/customer.html?ticket=${encodeURIComponent(payload.tracking.ticket)}` : ""}`;
    showWorkflowResult(
      "Submitted to Bank CRM",
      `Internal handoff complete. CRM ${payload.tracking?.crmReference || "created"} | Customer tracking ticket ${payload.tracking?.ticket || "generated"}`,
      trackingUrl ? `<a class="mini-link" href="${trackingUrl}" target="_blank" rel="noopener">View tracking status</a>` : ""
    );
  } else if (payload.blockers?.length) {
    showWorkflowResult("Submission blocked", payload.blockers.join("; "));
  }
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("active"));
  document.querySelectorAll(".bottom-nav button").forEach((button) => button.classList.remove("active"));
  document.getElementById(`screen-${name}`).classList.add("active");
  document.querySelector(`[data-screen="${name}"]`)?.classList.add("active");
  document.getElementById("mobileTitle").textContent = {
    home: {
      rm: "RM Workspace",
      manager: "Manager Tower",
      admin: "Admin & Policy",
      customer: "Customer Tracking",
    }[state.user?.role || "rm"],
    detail: "Applicant",
    new: "New Applicant",
    tasks: "Today's Work",
    scan: "Quick Scan",
    insights: "Control Tower",
    copilot: "RM Copilot",
    pitch: "Pitch Mode"
  }[name];
  if (name === "pitch") renderPitchMode();
}

function makeId() {
  return `APP-${Math.floor(1000 + Math.random() * 9000)}`;
}

function makeTask(title, type, owner, priority = "High") {
  return {
    id: crypto.randomUUID(),
    title,
    type,
    owner,
    dueDate: today(),
    status: "Open",
    priority
  };
}

function renderMetrics() {
  const role = state.user?.role || "rm";
  const visibleApps = role === "rm" ? state.applications.filter((app) => app.rm === state.user?.name) : state.applications;
  const active = visibleApps.filter((app) => app.stage !== "Completed").length;
  const high = visibleApps.filter((app) => riskScore(app) >= 70).length;
  const avg = Math.round(visibleApps.reduce((sum, app) => sum + completionScore(app), 0) / Math.max(1, visibleApps.length));
  const labels = {
    rm: [["My Active", active], ["My High Risk", high], ["Avg Done", `${avg}%`]],
    manager: [["Branch Active", active], ["High Risk", high], ["Review Queue", (state.reviewQueue || []).length]],
    admin: [["Products", Object.keys(state.rules || {}).length], ["Rules", Object.values(state.rules || {}).flat().length], ["Audit Items", (state.notifications || []).length]],
    customer: [["Applications", visibleApps.length], ["In Progress", active], ["Avg Done", `${avg}%`]],
  }[role] || [["Active", active], ["High Risk", high], ["Avg Done", `${avg}%`]];
  document.getElementById("mobileMetrics").innerHTML = labels.map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function renderRoleHomePanel() {
  const role = state.user?.role || "rm";
  const node = document.getElementById("roleHomePanel");
  if (!node) return;
  const highRisk = [...state.applications].sort((a, b) => riskScore(b) - riskScore(a));
  const missing = state.applications.flatMap((app) => missingDocs(app).map((doc) => ({ app, doc })));
  const graphSummary = {
    nodes: state.applications.length + Object.values(state.rules || {}).flat().length,
    dynamics: missing.length,
    actions: missing.length + state.applications.filter((app) => completionScore(app) >= 85 && !missingDocs(app).length).length,
  };
  const panels = {
    rm: `
      <section class="detail-block compact">
        <h2>RM Operating Queue</h2>
        <p>Focus on document gaps and applications ready for bank submission.</p>
        <div class="quick-actions">
          <button class="mini-btn" data-screen-shortcut="scan">Scan Documents</button>
          <button class="mini-btn" data-screen-shortcut="tasks">Today's Work</button>
        </div>
      </section>`,
    manager: `
      <section class="detail-block compact">
        <h2>Manager Control Tower</h2>
        <p>Branch bottlenecks, overloaded RMs, and review queue items.</p>
        <button class="primary-btn" data-screen-shortcut="insights" type="button">Open Control Tower</button>
      </section>`,
    admin: `
      <section class="detail-block compact">
        <h2>World Graph & Policy</h2>
        <p>Company memory plus operating physics for agent planning.</p>
        <div class="detail-grid">
          <div class="detail-item"><span>Graph Nodes</span><strong>${graphSummary.nodes}</strong></div>
          <div class="detail-item"><span>Dynamics</span><strong>${graphSummary.dynamics}</strong></div>
          <div class="detail-item"><span>Next Actions</span><strong>${graphSummary.actions}</strong></div>
          <div class="detail-item"><span>RBI Adapter</span><strong>Ready</strong></div>
        </div>
        <div class="quick-actions">
          <button class="mini-btn" data-screen-shortcut="insights">Open Graph</button>
          <a class="mini-link" href="https://www.rbi.org.in/commonman/english/scripts/notification.aspx?id=2607" target="_blank" rel="noopener">RBI Link</a>
        </div>
      </section>`,
    customer: `
      <section class="detail-block compact">
        <h2>Customer Tracking View</h2>
        <p>Customer mode is read-only. It shows status, pending documents, and tracking links without exposing staff workflow controls.</p>
      </section>`,
  };
  node.innerHTML = panels[role] || panels.rm;
  node.querySelectorAll("[data-open-app]").forEach((button) => button.addEventListener("click", () => {
    selectedApplicationId = button.dataset.openApp;
    renderDetail();
    showScreen("detail");
  }));
  node.querySelectorAll("[data-screen-shortcut]").forEach((button) => button.addEventListener("click", () => showScreen(button.dataset.screenShortcut)));
}

function renderNotifications() {
  const items = (state.notifications || []).slice(0, 1);
  const offlineCount = getOfflineQueue().length;
  const role = state.user?.role || "rm";
  const node = document.getElementById("mobileNotifications");
  if (!node) return;
  if (role === "customer") {
    node.innerHTML = "";
    return;
  }
  node.innerHTML = items.length || offlineCount ? `
    <section class="detail-block compact">
      <h2>Notifications</h2>
      ${offlineCount ? `
        <div class="doc-row">
          <div>
            <strong>Offline queue</strong>
            <div class="meta">${offlineCount} scan${offlineCount === 1 ? "" : "s"} waiting to sync</div>
          </div>
          <button class="mini-btn" data-screen-shortcut="scan">Sync</button>
        </div>
      ` : ""}
      ${items.map((item) => `
        <div class="doc-row">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <div class="meta">${escapeHtml(item.message)}</div>
          </div>
          <button class="mini-btn" data-dismiss-notification="${item.id}">Dismiss</button>
        </div>
      `).join("")}
    </section>
  ` : "";
  document.querySelectorAll("[data-dismiss-notification]").forEach((button) => {
    button.addEventListener("click", () => dismissNotification(button.dataset.dismissNotification));
  });
  document.querySelectorAll("[data-screen-shortcut]").forEach((button) => {
    button.addEventListener("click", () => showScreen(button.dataset.screenShortcut));
  });
}

function renderApplicationList() {
  const query = document.getElementById("mobileSearch").value.toLowerCase();
  const role = state.user?.role || "rm";
  let apps = [...state.applications]
    .filter((app) => role !== "rm" || app.rm === state.user?.name)
    .filter((app) => `${app.customer} ${app.product} ${app.rm} ${app.branch}`.toLowerCase().includes(query))
    .sort((a, b) => riskScore(b) - riskScore(a));

  document.getElementById("newApplicantBtn").style.display = role === "customer" ? "none" : "";
  document.getElementById("mobileSearch").closest(".search-box").style.display = ["customer", "admin"].includes(role) ? "none" : "";
  if (role === "admin") {
    document.getElementById("mobileApplicationList").innerHTML = `
      <section class="detail-block compact">
        <h2>Admin Workspace</h2>
        <p>Use Insights for world graph, RBI/Bharat Bank policy, rule builder, audit, and compliance controls.</p>
        <button class="primary-btn" data-screen-shortcut="insights" type="button">Open Admin Control Center</button>
      </section>
    `;
    document.querySelectorAll("[data-screen-shortcut]").forEach((button) => button.addEventListener("click", () => showScreen(button.dataset.screenShortcut)));
    return;
  }
  if (role === "manager") {
    apps = apps.filter((app) => riskScore(app) >= 40 || missingDocs(app).length).slice(0, 6);
  }
  if (role === "customer") {
    apps = state.applications.slice(0, 4);
  }
  const heading = {
    rm: "My Priority Applications",
    manager: "Applications Needing Manager Attention",
    customer: "My Tracking Tickets",
  }[role] || "Applications";
  document.getElementById("mobileApplicationList").innerHTML = `
    <section class="detail-block compact">
      <h2>${heading}</h2>
      <div class="mobile-list">
        ${apps.map((app) => {
    const completion = completionScore(app);
    const risk = riskScore(app);
    return `
      <div class="mobile-card">
        <div class="card-title">
          <div>
            <strong>${escapeHtml(app.customer)}</strong>
            <div class="meta">${app.product} • ${app.stage}</div>
          </div>
          <span class="pill ${riskBand(risk)}">${risk}%</span>
        </div>
        <div class="progress"><span style="width:${completion}%"></span></div>
        <div class="meta">
          <span>${completion}% complete</span>
          <span>${missingDocs(app).length} missing</span>
          <span>${app.rm}</span>
        </div>
        <div class="card-actions">
          <button class="mini-btn" data-open-app="${app.id}" type="button">Open</button>
          ${role === "customer" ? `<a class="mini-link" href="./customer.html?ticket=${encodeURIComponent(app.trackingTicket || "")}" target="_blank" rel="noopener">Track</a>` : `
            <button class="mini-btn" data-edit-app="${app.id}" type="button">Edit</button>
            <button class="mini-btn danger-btn" data-delete-app="${app.id}" type="button">Delete</button>
          `}
        </div>
      </div>
    `;
  }).join("") || `<div class="meta">Nothing urgent for this role.</div>`}
      </div>
    </section>
  `;

  document.querySelectorAll("[data-open-app]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedApplicationId = button.dataset.openApp;
      renderDetail();
      showScreen("detail");
    });
  });
  document.querySelectorAll("[data-edit-app]").forEach((button) => {
    button.addEventListener("click", () => openEditApplicant(button.dataset.editApp));
  });
  document.querySelectorAll("[data-delete-app]").forEach((button) => {
    button.addEventListener("click", () => deleteApplication(button.dataset.deleteApp));
  });
}

function renderDetail() {
  const app = findApp();
  if (!app) return;
  const role = state.user?.role || "rm";
  const canManage = role !== "customer";
  const intel = latestDocumentIntel(app);
  const missing = missingDocs(app);
  const isReadyForBank = missing.length === 0 && (app.submissionStatus || "Draft") !== "Submitted to Bank CRM";
  const isSubmitted = (app.submissionStatus || "") === "Submitted to Bank CRM";
  const workflowActions = missing.length ? `
        <button class="mini-btn" data-action-reminder="${app.id}">Send Message</button>
        <button class="mini-btn" data-action-link="${app.id}">Create Upload Link</button>
        <button class="mini-btn" data-action-kyc="${app.id}">Run KYC Check</button>
      ` : isReadyForBank ? `
        <button class="mini-btn" data-action-kyc="${app.id}">Run Final KYC</button>
        <button class="mini-btn" data-action-submit-bank="${app.id}">Submit to Bank CRM</button>
      ` : `
        <button class="mini-btn" data-action-crm="${app.id}">Sync CRM Status</button>
        <button class="mini-btn" data-action-complete="${app.id}">${isSubmitted ? "Mark Completed" : "Complete Flow"}</button>
      `;
  const receivedControls = (app.documents || []).map((doc) => `
    <div class="doc-row">
      <div>
        <strong>${escapeHtml(doc.name)}</strong>
        <div class="meta">${doc.filename ? `${escapeHtml(doc.filename)} • ` : ""}${doc.quality ? `${doc.quality.status} ${doc.quality.score}%` : "Received"} ${doc.flags?.length ? `• ${doc.flags.length} validation flag${doc.flags.length === 1 ? "" : "s"}` : ""}</div>
      </div>
      ${canManage ? `<div class="row-actions">
        <button class="mini-btn" data-view-doc="${doc.id || doc.name}" ${documentCanView(doc) ? "" : "disabled"} title="${documentCanView(doc) ? "View original uploaded scan" : "Original scan was not stored earlier. Rescan to view photo."}">View Scan</button>
        <button class="mini-btn danger-btn" data-delete-doc="${doc.id || doc.name}">Delete</button>
      </div>` : `<span class="pill good">Received</span>`}
    </div>
    ${doc.flags?.length ? `<div class="mobile-result">${doc.flags.map((flag) => `<span><strong>${flag.severity}:</strong> ${escapeHtml(flag.message)}</span>`).join("")}</div>` : ""}
  `).join("");
  document.getElementById("mobileApplicationDetail").innerHTML = `
    <section class="detail-block">
      <div class="card-title">
        <div>
          <h2>${escapeHtml(app.customer)}</h2>
          <p>${app.id} • ${app.product}</p>
        </div>
        <span class="pill ${riskBand(riskScore(app))}">${riskScore(app)} risk</span>
      </div>
      ${canManage ? `<div class="card-actions">
        <button class="mini-btn" data-edit-app="${app.id}" type="button">Edit Applicant</button>
        <button class="mini-btn danger-btn" data-delete-app="${app.id}" type="button">Delete Applicant</button>
      </div>` : ""}
      <div class="detail-grid">
        <div class="detail-item"><span>Completion</span><strong>${completionScore(app)}%</strong></div>
        <div class="detail-item"><span>Stage</span><strong>${app.stage}</strong></div>
        <div class="detail-item"><span>Ticket</span><strong>${app.trackingTicket || "Generating"}</strong></div>
        <div class="detail-item"><span>CRM Ref</span><strong>${app.crmReference || "Not submitted"}</strong></div>
        <div class="detail-item"><span>Submission</span><strong>${app.submissionStatus || "Draft"}</strong></div>
        <div class="detail-item"><span>Type</span><strong>${app.accountType || productAccountType(app.product)}</strong></div>
        <div class="detail-item"><span>PAN</span><strong>${app.identity?.pan?.status || "Pending"}</strong></div>
        <div class="detail-item"><span>Aadhaar</span><strong>${app.identity?.aadhaar?.status || "Pending"}</strong></div>
        <div class="detail-item"><span>Address</span><strong>${app.addressProfile?.sourceDoc || "Pending"}</strong></div>
        <div class="detail-item"><span>Mobile</span><strong>${app.mobile}</strong></div>
        <div class="detail-item"><span>Reason</span><strong>${riskReason(app)}</strong></div>
      </div>
    </section>
    ${canManage ? `<section class="detail-block">
      <h2>Workflow Actions</h2>
      <div class="quick-actions">
        ${workflowActions}
      </div>
      <div id="workflowResult" class="mobile-result">${missing.length ? `Pending ${missing.map((doc) => doc.name).join(", ")}. Send a message or create a customer upload link.` : isReadyForBank ? "All mandatory documents are received. Submit to Bank CRM when ready." : "Application is already submitted. Keep CRM status synced or mark completed after bank approval."}</div>
    </section>` : ""}
    <section class="detail-block">
      <h2>Customer Tracking</h2>
      <div class="doc-row">
        <div>
          <strong>${app.trackingTicket || "Ticket pending"}</strong>
          <div class="meta">${app.submissionStatus || "Draft"} • ${app.crmReference || "CRM not submitted yet"}</div>
        </div>
        <a class="mini-link" href="./customer.html?ticket=${encodeURIComponent(app.trackingTicket || "")}" target="_blank" rel="noopener">Track</a>
      </div>
    </section>
    ${canManage ? `<section class="detail-block">
      <h2>Bharat Bank Forms</h2>
      <p>Open the official downloads page, then generate a prefill packet from verified applicant data to reduce manual form entry.</p>
      <div class="quick-actions">
        <a class="mini-link" href="https://www.bharatbank.bank.in/downloads.html" target="_blank" rel="noopener">Open official forms</a>
        <button class="mini-btn" data-action-prefill-forms="${app.id}">Generate Prefill</button>
      </div>
    </section>` : ""}
    <section class="detail-block">
      <h2>AI Intelligence</h2>
      ${intel ? `
        <div class="detail-grid">
          <div class="detail-item"><span>Format</span><strong>${escapeHtml(intel.ai?.layout || intel.name)}</strong></div>
          <div class="detail-item"><span>AI Confidence</span><strong>${intel.ai?.confidence || intel.confidence}%</strong></div>
          <div class="detail-item"><span>Quality</span><strong>${intel.quality?.status || "Good"} ${intel.quality?.score ? `${intel.quality.score}%` : ""}</strong></div>
          <div class="detail-item"><span>Missing Fields</span><strong>${intel.ai?.missingFields?.join(", ") || "None"}</strong></div>
        </div>
      ` : `<div class="meta">No scanned intelligence yet.</div>`}
    </section>
    <section class="detail-block">
      <h2>Verified Info</h2>
      <div class="doc-row">
        <div>
          <strong>PAN</strong>
          <div class="meta">${app.identity?.pan?.fields?.pan || "Pending"} ${app.identity?.pan?.fields?.name ? `• ${escapeHtml(app.identity.pan.fields.name)}` : ""}</div>
        </div>
        ${app.identity?.pan && canManage ? `<button class="mini-btn" data-clear-identity="pan">Clear</button>` : `<span class="pill ${app.identity?.pan ? "good" : "medium"}">${app.identity?.pan ? "Verified" : "Pending"}</span>`}
      </div>
      <div class="doc-row">
        <div>
          <strong>Aadhaar</strong>
          <div class="meta">${app.identity?.aadhaar?.fields?.aadhaar || "Pending"} ${app.identity?.aadhaar?.fields?.name ? `• ${escapeHtml(app.identity.aadhaar.fields.name)}` : ""}</div>
        </div>
        ${app.identity?.aadhaar && canManage ? `<button class="mini-btn" data-clear-identity="aadhaar">Clear</button>` : `<span class="pill ${app.identity?.aadhaar ? "good" : "medium"}">${app.identity?.aadhaar ? "Verified" : "Pending"}</span>`}
      </div>
    </section>
    <section class="detail-block">
      <h2>Identity Cross-Check</h2>
      <div class="doc-row">
        <div>
          <strong>${app.identityConsistency?.status || "Clear"}</strong>
          <div class="meta">${app.identityConsistency?.lastCheckedAt ? `Last checked ${app.identityConsistency.lastCheckedAt}` : "Documents will be cross-checked as they are uploaded."}</div>
        </div>
        <span class="pill ${(app.identityConsistency?.status || "Clear") === "Blocked" ? "high" : (app.identityConsistency?.status || "Clear") === "Review" ? "medium" : "good"}">${app.identityConsistency?.mismatches?.length || 0} issue${(app.identityConsistency?.mismatches?.length || 0) === 1 ? "" : "s"}</span>
      </div>
      ${(app.identityConsistency?.mismatches || []).slice(0, 4).map((item) => `
        <div class="mobile-result compact-result">
          <strong>${escapeHtml(item.field || "identity")} mismatch</strong>
          <span>${escapeHtml(item.message)}</span>
        </div>
      `).join("") || `<div class="meta">Name, DOB, PAN, Aadhaar, address, and signature evidence are consistent so far.</div>`}
    </section>
    <section class="detail-block">
      <h2>Address Intelligence</h2>
      <div class="doc-row">
        <div>
          <strong>Reference Address</strong>
          <div class="meta">${app.addressProfile?.address ? escapeHtml(app.addressProfile.address) : "Upload Aadhaar or Address Proof to set the reference address."}</div>
        </div>
        <span class="pill ${app.addressProfile?.address ? "low" : "medium"}">${app.addressProfile?.sourceDoc || "Pending"}</span>
      </div>
    </section>
    <section class="detail-block">
      <h2>Received Documents & Corrections</h2>
      ${receivedControls || `<div class="meta">No received documents yet.</div>`}
    </section>
    <section class="detail-block">
      <h2>Documents</h2>
      ${requiredDocs(app).map((doc) => {
        const received = receivedDocNames(app).includes(doc.name);
        const receivedDoc = (app.documents || []).find((item) => item.name === doc.name && item.status === "Received");
        return `
          <div class="doc-row">
            <div>
              <strong>${doc.name}</strong>
              <div class="meta">${received ? "Received" : "Missing"} • ${doc.weight} pts</div>
            </div>
            ${canManage ? `<div class="row-actions">
              ${received ? `<button class="mini-btn" data-view-doc="${receivedDoc?.id || receivedDoc?.name || doc.name}" ${documentCanView(receivedDoc) ? "" : "disabled"} title="${documentCanView(receivedDoc) ? "View original uploaded scan" : "Original scan was not stored earlier. Rescan to view photo."}">View Scan</button>` : ""}
              <button class="mini-btn" data-scan-doc="${doc.name}">${received ? "Rescan" : "Upload"}</button>
            </div>` : `<span class="pill ${received ? "good" : "medium"}">${received ? "Done" : "Pending"}</span>`}
          </div>
        `;
      }).join("")}
    </section>
    <section class="detail-block">
      <h2>Timeline</h2>
      ${(app.timeline || []).slice(0, 5).map((item) => `<div class="meta">${escapeHtml(item)}</div>`).join("")}
    </section>
  `;

  document.querySelectorAll("[data-scan-doc]").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("mobileScanApp").value = app.id;
      populateExpectedDocs();
      document.getElementById("mobileExpectedDoc").value = button.dataset.scanDoc;
      showScreen("scan");
    });
  });
  document.querySelectorAll("[data-delete-doc]").forEach((button) => {
    button.addEventListener("click", () => deleteDocument(app.id, button.dataset.deleteDoc));
  });
  document.querySelectorAll("[data-view-doc]").forEach((button) => {
    button.addEventListener("click", () => viewDocument(app.id, button.dataset.viewDoc));
  });
  document.querySelectorAll("[data-clear-identity]").forEach((button) => {
    button.addEventListener("click", () => clearIdentity(app.id, button.dataset.clearIdentity));
  });
  document.querySelectorAll("[data-delete-app]").forEach((button) => {
    button.addEventListener("click", () => deleteApplication(button.dataset.deleteApp));
  });
  document.querySelectorAll("[data-edit-app]").forEach((button) => {
    button.addEventListener("click", () => openEditApplicant(button.dataset.editApp));
  });
  document.querySelectorAll("[data-action-reminder]").forEach((button) => button.addEventListener("click", () => sendReminder(button.dataset.actionReminder)));
  document.querySelectorAll("[data-action-crm]").forEach((button) => button.addEventListener("click", () => syncCrm(button.dataset.actionCrm)));
  document.querySelectorAll("[data-action-kyc]").forEach((button) => button.addEventListener("click", () => runKyc(button.dataset.actionKyc)));
  document.querySelectorAll("[data-action-link]").forEach((button) => button.addEventListener("click", () => generateCustomerLink(button.dataset.actionLink)));
  document.querySelectorAll("[data-action-complete]").forEach((button) => button.addEventListener("click", () => completeApplication(button.dataset.actionComplete)));
  document.querySelectorAll("[data-action-submit-bank]").forEach((button) => button.addEventListener("click", () => submitToBank(button.dataset.actionSubmitBank)));
  document.querySelectorAll("[data-action-prefill-forms]").forEach((button) => button.addEventListener("click", () => generateFormPrefill(button.dataset.actionPrefillForms)));
}

function renderTasks() {
  const tasks = state.applications.flatMap((app) => (app.tasks || []).map((task) => ({ ...task, app })))
    .filter((task) => task.status === "Open")
    .sort((a, b) => a.dueDate > b.dueDate ? 1 : -1);
  document.getElementById("mobileTaskList").innerHTML = tasks.map((task) => `
    <div class="mobile-card">
      <div class="card-title">
        <strong>${escapeHtml(task.title)}</strong>
        <span class="pill ${task.priority === "High" ? "high" : "medium"}">${task.priority}</span>
      </div>
      <div class="meta">${task.app.customer} • ${task.type} • Due ${task.dueDate}</div>
      <button class="mini-btn" data-done-task="${task.app.id}:${task.id}">Mark Done</button>
    </div>
  `).join("") || `<div class="mobile-result">No open tasks.</div>`;

  document.querySelectorAll("[data-done-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      const [appId, taskId] = button.dataset.doneTask.split(":");
      const app = findApp(appId);
      const task = app.tasks.find((item) => item.id === taskId);
      task.status = "Done";
      app.lastActivityAt = today();
      app.timeline.unshift(`${today()} - Mobile task completed: ${task.title}`);
      await saveState();
      renderAll();
    });
  });
}

function renderInsights() {
  const risky = state.applications.filter((app) => riskScore(app) >= 60);
  const revenueAtRisk = risky.reduce((sum, app) => sum + Number(app.value || 0), 0);
  const escalations = state.applications.reduce((sum, app) => sum + (app.tasks || []).filter((task) => task.type === "Escalation" && task.status === "Open").length, 0);
  const reviewItems = state.reviewQueue || [];
  const productRows = revenueLeakageRows();
  const rmRows = rmProductivityRows();
  const branchRows = branchHeatmapRows();
  const sla = slaRows();
  const causes = rootCauseRows();
  const productOptions = Object.keys(state.rules).sort();
  const selectedProduct = document.getElementById("ruleProductSelect")?.value || productOptions[0] || "Business Loan";
  const rules = state.rules[selectedProduct] || [];
  const graphDynamics = state.applications.flatMap((app) => missingDocs(app).map((doc) => ({
    app,
    doc,
    effect: `${doc.name} missing increases delay and drop-off risk for ${app.product}.`,
    action: `Request ${doc.name}`,
  }))).slice(0, 6);

  document.getElementById("mobileInsights").innerHTML = `
    <section class="detail-block">
      <h2>Action Result</h2>
      <div id="insightsActionResult" class="mobile-result">Approve, reject, or run workflow actions to see results here.</div>
    </section>
    <section class="detail-block compact">
      <h2>Graph World Model</h2>
      <p>Nodes are customers, applications, products, RMs, and documents. Edges model requirements, ownership, causes, and action effects.</p>
      <div class="detail-grid">
        <div class="detail-item"><span>Entity Nodes</span><strong>${state.applications.length + productOptions.length + Object.values(state.rules).flat().length}</strong></div>
        <div class="detail-item"><span>Risk Dynamics</span><strong>${graphDynamics.length}</strong></div>
        <div class="detail-item"><span>Simulation</span><strong>Action-conditioned</strong></div>
        <div class="detail-item"><span>Agent Safety</span><strong>Policy-bound</strong></div>
      </div>
      ${graphDynamics.map((row) => `
        <div class="doc-row">
          <div>
            <strong>${escapeHtml(row.app.customer)} -> ${escapeHtml(row.doc.name)}</strong>
            <div class="meta">${escapeHtml(row.effect)}</div>
          </div>
          <span class="pill medium">${escapeHtml(row.action)}</span>
        </div>
      `).join("") || `<div class="meta">No missing-document dynamics right now.</div>`}
    </section>
    <section class="detail-block compact">
      <h2>RBI & Bharat Bank Policy Links</h2>
      <p>Production should replace these adapter links with bank-approved APIs. Demo rules currently drive required documents.</p>
      <div class="doc-row">
        <div><strong>Bharat Bank Product Policy</strong><div class="meta">${escapeHtml(selectedProduct)} requires ${rules.filter((rule) => rule.mandatory).map((rule) => rule.name).join(", ")}</div></div>
        <a class="mini-link" href="https://www.bharatbank.bank.in/downloads.html" target="_blank" rel="noopener">Bank Forms</a>
      </div>
      <div class="doc-row">
        <div><strong>RBI KYC Regulation Adapter</strong><div class="meta">CDD/KYC rules are adapter-ready for production policy ingestion.</div></div>
        <a class="mini-link" href="https://www.rbi.org.in/commonman/english/scripts/notification.aspx?id=2607" target="_blank" rel="noopener">RBI</a>
      </div>
    </section>
    <section class="detail-block">
      <h2>Revenue Leakage</h2>
      <div class="detail-grid">
        <div class="detail-item"><span>Pipeline at Risk</span><strong>${money(revenueAtRisk)}</strong></div>
        <div class="detail-item"><span>At-Risk Apps</span><strong>${risky.length}</strong></div>
        <div class="detail-item"><span>Escalations</span><strong>${escalations}</strong></div>
        <div class="detail-item"><span>Review Queue</span><strong>${reviewItems.length}</strong></div>
      </div>
    </section>
    <section class="detail-block compact">
      <h2>Product Drivers</h2>
      ${productRows.map((row) => `
        <div class="doc-row">
          <div>
            <strong>${escapeHtml(row.product)}</strong>
            <div class="meta">${row.atRisk}/${row.applications} at risk • Driver: ${escapeHtml(row.driver)}</div>
          </div>
          <span class="pill ${row.atRisk ? "high" : "good"}">${money(row.valueAtRisk)}</span>
        </div>
      `).join("")}
    </section>
    <section class="detail-block compact">
      <h2>RM Productivity</h2>
      ${rmRows.map((row) => `
        <div class="doc-row">
          <div>
            <strong>${escapeHtml(row.rm)}</strong>
            <div class="meta">${row.applications} apps • ${row.openTasks} open tasks • ${row.highRisk} high risk</div>
          </div>
          <span class="pill ${row.avgCompletion >= 70 ? "good" : "medium"}">${row.avgCompletion}%</span>
        </div>
      `).join("")}
    </section>
    <section class="detail-block compact">
      <h2>Duplicate / Review Queue</h2>
      ${reviewItems.slice(0, 5).map((item) => `
        <div class="mobile-card">
          <strong>${escapeHtml(item.customer)} • ${escapeHtml(item.docType)}</strong>
          <div class="meta">${escapeHtml(item.reason)} • ${item.confidence}% confidence</div>
          <div class="quick-actions">
            <button class="mini-btn" data-review-approve="${item.id}">Approve</button>
            <button class="mini-btn danger-btn" data-review-reject="${item.id}">Reject</button>
          </div>
        </div>
      `).join("") || `<div class="meta">No documents waiting for review.</div>`}
    </section>
    <section class="detail-block compact">
      <h2>Branch Heatmap</h2>
      ${branchRows.map((row) => `
        <div class="doc-row">
          <div>
            <strong>${escapeHtml(row.branch)}</strong>
            <div class="meta">${row.applications} apps • ${row.idleAvg} avg idle days • Bottleneck: ${escapeHtml(row.bottleneck)}</div>
          </div>
          <span class="pill ${row.atRisk ? "high" : "good"}">${row.atRisk}</span>
        </div>
      `).join("")}
    </section>
    <section class="detail-block compact">
      <h2>SLA Tracker</h2>
      ${sla.slice(0, 5).map((row) => `
        <div class="doc-row">
          <div>
            <strong>${escapeHtml(row.app.customer)}</strong>
            <div class="meta">${row.app.stage} • ${row.age} age days • ${row.idle} idle days</div>
          </div>
          <span class="pill ${row.status === "Breached" ? "high" : "good"}">${row.status}</span>
        </div>
      `).join("")}
    </section>
    <section class="detail-block compact">
      <h2>Root Cause Intelligence</h2>
      ${causes.map((row) => `
        <div class="doc-row">
          <div>
            <strong>${escapeHtml(row.reason)}</strong>
            <div class="meta">${row.count} applications • ${row.share}% share</div>
          </div>
          <span class="pill medium">${row.share}%</span>
        </div>
      `).join("")}
    </section>
    <section class="detail-block compact">
      <h2>Customer Risk Profile</h2>
      ${[...state.applications].sort((a, b) => riskScore(b) - riskScore(a)).slice(0, 5).map((app) => `
        <div class="doc-row">
          <div>
            <strong>${escapeHtml(app.customer)}</strong>
            <div class="meta">${riskReason(app)} • completion likelihood ${Math.max(5, 100 - riskScore(app))}%</div>
          </div>
          <span class="pill ${riskBand(riskScore(app))}">${riskScore(app)}</span>
        </div>
      `).join("")}
    </section>
    <section class="detail-block compact">
      <h2>Audit & Compliance</h2>
      <div class="detail-grid">
        <div class="detail-item"><span>Notifications</span><strong>${(state.notifications || []).length}</strong></div>
        <div class="detail-item"><span>Open Reviews</span><strong>${reviewItems.length}</strong></div>
        <div class="detail-item"><span>Open Tasks</span><strong>${state.applications.reduce((sum, app) => sum + (app.tasks || []).filter((task) => task.status === "Open").length, 0)}</strong></div>
        <div class="detail-item"><span>Compliance</span><strong>Tracked</strong></div>
      </div>
    </section>
    <section class="detail-block compact">
      <h2>Admin Rule Builder</h2>
      <label class="field">
        Product
        <select id="ruleProductSelect">
          ${productOptions.map((product) => `<option ${product === selectedProduct ? "selected" : ""}>${escapeHtml(product)}</option>`).join("")}
        </select>
      </label>
      ${rules.map((rule) => `
        <div class="doc-row">
          <div>
            <strong>${escapeHtml(rule.name)}</strong>
            <div class="meta">${rule.weight} pts • ${rule.mandatory ? "Mandatory" : "Optional"}</div>
          </div>
          <button class="mini-btn" data-remove-rule="${escapeHtml(rule.name)}">Remove</button>
        </div>
      `).join("")}
      <div class="rule-row">
        <label class="field">Document<input id="newRuleName" placeholder="GST Certificate" /></label>
        <label class="field">Weight<input id="newRuleWeight" type="number" value="10" /></label>
        <button id="addRuleBtn" class="mini-btn" type="button">Add</button>
      </div>
    </section>
  `;

  document.getElementById("ruleProductSelect")?.addEventListener("change", renderInsights);
  document.getElementById("addRuleBtn")?.addEventListener("click", async () => {
    const product = document.getElementById("ruleProductSelect").value;
    const name = document.getElementById("newRuleName").value.trim();
    const weight = Number(document.getElementById("newRuleWeight").value || 10);
    if (!name) return;
    state.rules[product] = state.rules[product] || [];
    if (!state.rules[product].some((rule) => rule.name.toLowerCase() === name.toLowerCase())) {
      state.rules[product].push({ name, weight, fields: [], mandatory: true });
      await saveState();
      renderAll();
      showScreen("insights");
    }
  });
  document.querySelectorAll("[data-remove-rule]").forEach((button) => {
    button.addEventListener("click", async () => {
      const product = document.getElementById("ruleProductSelect").value;
      state.rules[product] = (state.rules[product] || []).filter((rule) => rule.name !== button.dataset.removeRule);
      await saveState();
      renderAll();
      showScreen("insights");
    });
  });
  document.querySelectorAll("[data-review-approve]").forEach((button) => {
    button.addEventListener("click", () => reviewDecision(button.dataset.reviewApprove, "approve"));
  });
  document.querySelectorAll("[data-review-reject]").forEach((button) => {
    button.addEventListener("click", () => reviewDecision(button.dataset.reviewReject, "reject"));
  });
}

function renderPitchMode() {
  const bestApp = [...state.applications].sort((a, b) => riskScore(b) - riskScore(a))[0];
  const rows = rootCauseRows();
  const leakage = revenueLeakageRows().reduce((sum, row) => sum + row.valueAtRisk, 0);
  document.getElementById("pitchModeContent").innerHTML = `
    <section class="detail-block">
      <h2>1. Application Command Center</h2>
      <div class="detail-grid">
        <div class="detail-item"><span>Applicant</span><strong>${escapeHtml(bestApp?.customer || "No applicant")}</strong></div>
        <div class="detail-item"><span>Risk</span><strong>${bestApp ? riskScore(bestApp) : 0}%</strong></div>
        <div class="detail-item"><span>Completion</span><strong>${bestApp ? completionScore(bestApp) : 0}%</strong></div>
        <div class="detail-item"><span>Missing</span><strong>${bestApp ? missingDocs(bestApp).length : 0}</strong></div>
      </div>
    </section>
    <section class="detail-block">
      <h2>2. AI Scan + Validation</h2>
      <p>OCR, document format intelligence, field extraction, quality score, signature/name validation, duplicate checks, and notifications.</p>
      <button class="primary-btn" data-screen-shortcut="scan">Open Scan Demo</button>
    </section>
    <section class="detail-block">
      <h2>3. Workflow Actions</h2>
      <p>RM can send WhatsApp reminders, sync CRM, run KYC, create customer upload links, and move complete applications to approval.</p>
      <button class="primary-btn" data-open-app="${bestApp?.id || ""}">Open Applicant Demo</button>
    </section>
    <section class="detail-block">
      <h2>4. Revenue Leakage</h2>
      <div class="detail-grid">
        <div class="detail-item"><span>Pipeline At Risk</span><strong>${money(leakage)}</strong></div>
        <div class="detail-item"><span>Top Root Cause</span><strong>${escapeHtml(rows[0]?.reason || "None")}</strong></div>
      </div>
    </section>
    <section class="detail-block">
      <h2>5. Control Tower</h2>
      <p>Manager sees branch heatmap, SLA tracker, RM productivity, approval queue, and compliance trail.</p>
      <button class="primary-btn" data-screen-shortcut="insights">Open Control Tower</button>
    </section>
  `;
  document.querySelectorAll("[data-screen-shortcut]").forEach((button) => button.addEventListener("click", () => showScreen(button.dataset.screenShortcut)));
  document.querySelectorAll("[data-open-app]").forEach((button) => button.addEventListener("click", () => {
    selectedApplicationId = button.dataset.openApp;
    renderDetail();
    showScreen("detail");
  }));
}

function populateScanApps() {
  const select = document.getElementById("mobileScanApp");
  const current = select.value;
  select.innerHTML = state.applications.map((app) => `<option value="${app.id}">${app.customer} - ${app.product}</option>`).join("");
  if (selectedApplicationId && [...select.options].some((option) => option.value === selectedApplicationId)) {
    select.value = selectedApplicationId;
  } else if (current) {
    select.value = current;
  }
  populateExpectedDocs();
}

function populateExpectedDocs() {
  const app = findApp(document.getElementById("mobileScanApp").value);
  const select = document.getElementById("mobileExpectedDoc");
  const current = select.value;
  select.innerHTML = requiredDocs(app).map((doc) => `<option>${doc.name}</option>`).join("");
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderScanPayload(payload, app) {
  return `
    <strong>${payload.docType} ${payload.result === "attached" ? "attached" : "sent to review"}${payload.cached ? " • cached" : ""}</strong>
    <span>${payload.ai?.message || payload.ocr?.message || payload.identity?.message || "Document processed."}</span>
    ${payload.identity?.verificationUrl ? `<a class="mini-link" href="${payload.identity.verificationUrl}" target="_blank" rel="noopener">Open official verification site</a>` : ""}
    <div class="detail-grid">
      <div class="detail-item"><span>AI Middleware</span><strong>${payload.ai?.status || "Processed"}</strong></div>
      <div class="detail-item"><span>Format</span><strong>${payload.ai?.layout || payload.docType}</strong></div>
      <div class="detail-item"><span>Preprocess</span><strong>${payload.preprocess?.status || "Ready"}</strong></div>
      <div class="detail-item"><span>Orientation</span><strong>${payload.preprocess?.imageProfile?.orientation || "Text input"}</strong></div>
      <div class="detail-item"><span>Scaling</span><strong>${payload.preprocess?.imageProfile?.scaling || "Not required"}</strong></div>
      <div class="detail-item"><span>Quality</span><strong>${payload.quality?.status || "Good"} ${payload.quality?.score ? `${payload.quality.score}%` : ""}</strong></div>
      <div class="detail-item"><span>Name</span><strong>${payload.fields.name || "Not detected"} ${payload.fieldConfidence?.name ? `(${payload.fieldConfidence.name}%)` : ""}</strong></div>
      <div class="detail-item"><span>DOB</span><strong>${payload.fields.dob || "Not detected"} ${payload.fieldConfidence?.dob ? `(${payload.fieldConfidence.dob}%)` : ""}</strong></div>
      <div class="detail-item"><span>Mobile</span><strong>${payload.fields.mobile || "Not detected"} ${payload.fieldConfidence?.mobile ? `(${payload.fieldConfidence.mobile}%)` : ""}</strong></div>
      <div class="detail-item"><span>Gender</span><strong>${payload.fields.gender || "Not detected"} ${payload.fieldConfidence?.gender ? `(${payload.fieldConfidence.gender}%)` : ""}</strong></div>
      <div class="detail-item"><span>Signature</span><strong>${payload.fields.signatureStatus || "Not applicable"}</strong></div>
      <div class="detail-item"><span>PAN</span><strong>${payload.fields.pan} ${payload.fieldConfidence?.pan ? `(${payload.fieldConfidence.pan}%)` : ""}</strong></div>
      <div class="detail-item"><span>Aadhaar</span><strong>${payload.fields.aadhaar} ${payload.fieldConfidence?.aadhaar ? `(${payload.fieldConfidence.aadhaar}%)` : ""}</strong></div>
      <div class="detail-item"><span>Address</span><strong>${payload.fields.address || "Not detected"} ${payload.fieldConfidence?.address ? `(${payload.fieldConfidence.address}%)` : ""}</strong></div>
      <div class="detail-item"><span>Completion</span><strong>${completionScore(app)}%</strong></div>
    </div>
    ${payload.preprocess?.steps?.length ? `<strong>Image Processing</strong><span>${payload.preprocess.steps.join(", ")}</span>` : ""}
    ${payload.ai?.missingFields?.length ? `<span>Missing fields: ${payload.ai.missingFields.join(", ")}</span>` : ""}
    ${payload.crossVerification ? `<strong>Cross Verification: ${payload.crossVerification.overall}</strong><span>${escapeHtml(payload.crossVerification.summary)}</span>` : ""}
    ${payload.identityConsistency?.status === "Blocked" ? `<strong>Identity Cross-Check Blocked</strong><span>${escapeHtml(payload.identityConsistency.mismatches?.[0]?.message || "Document identity evidence does not match.")}</span>` : ""}
    ${payload.crossVerification?.checks?.some((item) => item.name === "Address") ? `<strong>Address Comparison</strong><span>${escapeHtml(payload.crossVerification.checks.find((item) => item.name === "Address")?.detail || "Address checked across documents.")}</span>` : ""}
    ${payload.crossVerification?.checks?.length ? `<span>${payload.crossVerification.checks.map((item) => `${item.name}: ${item.status}`).join(" | ")}</span>` : ""}
    ${payload.flags?.length ? `<strong>Validation Flags</strong><span>${payload.flags.map((flag) => `${flag.severity}: ${flag.message}`).join(" ")}</span>` : ""}
    ${payload.mismatches?.length ? `<strong>Mismatch Alert</strong><span>${payload.mismatches.map((item) => item.message).join(" ")}</span>` : ""}
    ${payload.duplicates?.length ? `<strong>Duplicate Alert</strong><span>${payload.duplicates.map((item) => item.message).join(" ")}</span>` : ""}
    ${payload.followUp?.message ? `<strong>Smart Follow-up</strong><span>${escapeHtml(payload.followUp.message)}</span>` : ""}
    ${payload.actions?.length ? `<strong>Auto Actions</strong><span>${payload.actions.join(", ")}</span>` : ""}
    ${renderCorrectionForm(payload)}
  `;
}

async function submitManualCorrection(form) {
  const fields = {};
  form.querySelectorAll("input[name]").forEach((input) => {
    fields[input.name] = input.value.trim() || "Not detected";
  });
  const target = form.dataset.correctionTarget;
  const targetId = form.dataset.correctionId;
  const appId = form.dataset.correctionApp || document.getElementById("mobileScanApp").value;
  const path = target === "review"
    ? `/api/review/${encodeURIComponent(targetId)}/correct-approve`
    : `/api/applications/${encodeURIComponent(appId)}/documents/${encodeURIComponent(targetId)}/correct`;
  const payload = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields, reason: "Manual correction after scan mismatch" })
  }).then((response) => response.json());
  if (!payload.ok) {
    alert(payload.error || "Correction failed");
    return;
  }
  state = payload.state;
  selectedApplicationId = appId;
  renderAll();
  document.getElementById("mobileScanResult").innerHTML = `
    <strong>Correction saved</strong>
    <span>${escapeHtml(form.dataset.correctionDoc || "Document")} fields were updated and identity cross-check was recalculated.</span>
    <span>Status: ${escapeHtml(payload.identityConsistency?.status || "Clear")}</span>
  `;
  if (payload.identityConsistency?.status === "Blocked") {
    showScanAlert({ docType: form.dataset.correctionDoc, identityConsistency: payload.identityConsistency });
  }
}

async function scanMobileDocument() {
  const appId = document.getElementById("mobileScanApp").value;
  const expectedDoc = document.getElementById("mobileExpectedDoc").value;
  const files = [...document.getElementById("mobileFile").files];
  const file = files[0];
  const textArea = document.getElementById("mobileDocText");
  const result = document.getElementById("mobileScanResult");
  if (!files.length && !textArea.value.trim()) {
    result.innerHTML = `<strong>No document selected</strong><span>Use camera/file or paste visible text.</span>`;
    return;
  }
  const inputs = files.length ? files : [null];
  const tooLarge = files.find((item) => item.size > MAX_UPLOAD_BYTES);
  if (tooLarge) {
    result.innerHTML = `<strong>File too large</strong><span>${escapeHtml(tooLarge.name)} is ${(tooLarge.size / 1024 / 1024).toFixed(1)} MB. Maximum supported upload is 4 MB per document.</span>`;
    return;
  }
  result.innerHTML = `<strong>Scanning ${inputs.length} item${inputs.length === 1 ? "" : "s"}...</strong><span>Queueing OCR and extracting fields.</span>`;
  const rendered = [];
  const alertPayloads = [];
  for (const currentFile of inputs) {
    const needsBackendOcr = currentFile && !canReadAsText(currentFile);
    let text = currentFile ? "" : textArea.value;
    if (currentFile && !needsBackendOcr) {
      text = await readFileAsText(currentFile);
    }
    const fileData = needsBackendOcr ? await readFileAsDataUrl(currentFile) : "";
    const body = { appId, expectedDoc, filename: currentFile?.name || expectedDoc, text, fileData };
    try {
      const endpoint = fileData ? "/api/scan-jobs" : "/api/scan";
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      const scanPayload = payload.result || payload;
      if (!scanPayload.ok) throw new Error(scanPayload.error || "Scan failed");
      state = scanPayload.state;
      selectedApplicationId = appId;
      const app = findApp(appId);
      rendered.push(renderScanPayload(scanPayload, app));
      if (scanAlertIssues(scanPayload).length) alertPayloads.push(scanPayload);
    } catch (error) {
      const queueLength = queueOfflineScan(body);
      rendered.push(`<strong>Saved offline</strong><span>${escapeHtml(currentFile?.name || expectedDoc)} will sync later. Pending: ${queueLength}</span>`);
    }
  }
  renderAll();
  result.innerHTML = rendered.join(`<hr />`);
  result.querySelectorAll("[data-submit-correction]").forEach((button) => {
    button.addEventListener("click", () => submitManualCorrection(button.closest("[data-correction-form]")));
  });
  alertPayloads.forEach(showScanAlert);
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

async function autoReadMobileFile(file) {
  const label = document.getElementById("mobileFileName");
  if (!file) return "";
  if (!canReadAsText(file)) {
    label.textContent = `Selected: ${file.name} - image OCR will run on scan`;
    document.getElementById("mobileDetectedFields").innerHTML = `
      <strong>Ready for OCR</strong>
      <span>${file.name} will be sent to the backend Windows OCR engine when you tap Scan, Verify and Attach.</span>
    `;
    document.getElementById("mobileScanResult").innerHTML = `
      <strong>Image OCR ready</strong>
      <span>Tap Scan, Verify and Attach to read this image and auto-fill fields.</span>
    `;
    return "";
  }
  try {
    const text = await readFileAsText(file);
    label.textContent = `Selected: ${file.name} - text read automatically`;
    document.getElementById("mobileDocText").value = text;
    renderDetectedFields("Text read automatically");
    return text;
  } catch {
    label.textContent = `Selected: ${file.name} - could not auto-read text`;
    return "";
  }
}

async function syncOfflineQueue() {
  const queue = getOfflineQueue();
  const result = document.getElementById("mobileScanResult");
  if (!queue.length) {
    result.innerHTML = `<strong>No offline scans</strong><span>Everything is already synced.</span>`;
    return;
  }
  const remaining = [];
  const rendered = [];
  for (const item of queue) {
    try {
      const response = await fetch(`${API_BASE}/api/scan-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.payload)
      });
      const payload = await response.json();
      const scanPayload = payload.result || payload;
      if (!scanPayload.ok) throw new Error(scanPayload.error || "Sync failed");
      state = scanPayload.state;
      selectedApplicationId = item.payload.appId;
      rendered.push(renderScanPayload(scanPayload, findApp(item.payload.appId)));
    } catch {
      remaining.push(item);
    }
  }
  setOfflineQueue(remaining);
  renderAll();
  result.innerHTML = rendered.length
    ? rendered.join(`<hr />`) + (remaining.length ? `<span>${remaining.length} scan(s) still offline.</span>` : "")
    : `<strong>Still offline</strong><span>${remaining.length} scan(s) could not sync yet.</span>`;
}

function addMessage(role, text) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = text;
  document.getElementById("mobileChatLog").appendChild(node);
  node.scrollIntoView({ block: "end" });
}

function answerQuestion(question) {
  const q = question.toLowerCase();
  const highRisk = state.applications.filter((app) => riskScore(app) >= 70).sort((a, b) => riskScore(b) - riskScore(a));
  const app = highRisk[0] || findApp();
  if (q.includes("draft") || q.includes("whatsapp") || q.includes("sms")) {
    const missing = missingDocs(app).map((doc) => doc.name);
    return missing.length
      ? `Draft: Dear ${app.customer}, your ${app.product} application is pending ${missing.join(", ")}. Please share it so we can complete your application.`
      : `Draft: Dear ${app.customer}, your ${app.product} documents are complete. We are moving your application to the next stage.`;
  }
  if (q.includes("create") && q.includes("follow")) {
    const missing = missingDocs(app).map((doc) => doc.name);
    app.tasks = app.tasks || [];
    app.tasks.unshift(makeTask(`Follow up for ${missing[0] || "next stage"}`, "Follow-up", app.rm, "High"));
    app.timeline.unshift(`${today()} - Copilot created follow-up task`);
    saveState().then(renderAll);
    return `Created follow-up task for ${app.customer}.`;
  }
  if (q.includes("escalate")) {
    app.tasks = app.tasks || [];
    app.tasks.unshift(makeTask("Manager escalation from copilot", "Escalation", app.manager || app.rm, "High"));
    app.timeline.unshift(`${today()} - Copilot escalated application`);
    saveState().then(renderAll);
    return `Escalated ${app.customer} to ${app.manager || app.rm}.`;
  }
  if (q.includes("call") || q.includes("today") || q.includes("follow")) {
    return highRisk.length ? `Call ${highRisk.map((app) => app.customer).join(", ")} first. ${highRisk[0].customer}: ${riskReason(highRisk[0])}.` : "No high-risk calls are urgent. Work oldest open tasks first.";
  }
  if (q.includes("missing") || q.includes("document")) {
    return state.applications.map((app) => `${app.customer}: ${missingDocs(app).map((doc) => doc.name).join(", ") || "complete"}`).join(" | ");
  }
  if (q.includes("risk")) {
    return highRisk.map((app) => `${app.customer}: ${riskReason(app)}`).join(" | ") || "No high-risk applications right now.";
  }
  return "Focus on missing mandatory documents, stale follow-ups, and applications above 85% that can move to next stage.";
}

function renderAll() {
  const roleSelect = document.getElementById("roleSelect");
  if (roleSelect) roleSelect.value = state.user?.role || "rm";
  if (document.getElementById("screen-home")?.classList.contains("active")) {
    document.getElementById("mobileTitle").textContent = {
      rm: "RM Workspace",
      manager: "Manager Tower",
      admin: "Admin & Policy",
      customer: "Customer Tracking",
    }[state.user?.role || "rm"];
  }
  renderMetrics();
  renderRoleHomePanel();
  renderNotifications();
  renderApplicationList();
  renderDetail();
  renderTasks();
  renderInsights();
  renderRequiredDocsPreview(document.querySelector("#mobileApplicantForm select[name='product']")?.value || "Savings Account");
  if (document.getElementById("screen-pitch")?.classList.contains("active")) renderPitchMode();
  populateScanApps();
}

document.querySelectorAll(".bottom-nav button").forEach((button) => {
  button.addEventListener("click", () => showScreen(button.dataset.screen));
});

document.querySelectorAll("[data-back-home]").forEach((button) => {
  button.addEventListener("click", () => showScreen("home"));
});

document.getElementById("newApplicantBtn").addEventListener("click", () => showScreen("new"));
document.getElementById("pitchModeBtn").addEventListener("click", () => showScreen("pitch"));
document.getElementById("resetDemoBtn").addEventListener("click", resetDemoData);
document.getElementById("roleSelect").addEventListener("change", (event) => switchRole(event.target.value));

document.getElementById("mobileApplicantForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  const submitButton = event.submitter || event.target.querySelector("button[type='submit']");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Creating...";
  }
  const app = {
    id: makeId(),
    customer: data.customer,
    mobile: data.mobile,
    email: data.email,
    product: data.product,
    accountType: data.accountType || productAccountType(data.product),
    customerSegment: data.customerSegment || productSegment(data.product),
    rm: data.rm,
    manager: "Prakash Menon",
    branch: data.branch,
    stage: "Document Collection",
    value: Number(data.value),
    createdAt: today(),
    lastActivityAt: today(),
    customerIntent: data.customerIntent,
    source: "Mobile entry",
    documents: [],
    tasks: [makeTask("Collect mandatory documents", "Document", data.rm, "High")],
    timeline: [`${today()} - Applicant created from mobile app`],
    notes: [],
    identity: {}
  };
  try {
    const response = await fetch(`${API_BASE}/api/applications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(app)
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Application could not be created");
    state = payload.state;
    selectedApplicationId = payload.application.id;
    document.getElementById("syncBadge").textContent = "Synced";
    event.target.reset();
    renderAll();
    showScreen("detail");
  } catch (error) {
    document.getElementById("syncBadge").textContent = "Needs review";
    alert(error.message || "Application could not be created. Please check backend connection.");
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Create Applicant";
    }
  }
});

document.getElementById("mobileEditForm").addEventListener("submit", updateApplicationFromForm);
document.getElementById("editDeleteBtn").addEventListener("click", () => {
  const appId = document.getElementById("mobileEditForm").elements.id.value;
  deleteApplication(appId);
});

document.querySelector("#mobileApplicantForm select[name='product']").addEventListener("change", (event) => {
  const form = document.getElementById("mobileApplicantForm");
  form.elements.accountType.value = productAccountType(event.target.value);
  form.elements.customerSegment.value = productSegment(event.target.value);
  renderRequiredDocsPreview(event.target.value);
});

document.querySelector("#mobileEditForm select[name='product']").addEventListener("change", (event) => {
  const form = document.getElementById("mobileEditForm");
  form.elements.accountType.value = productAccountType(event.target.value);
  form.elements.customerSegment.value = productSegment(event.target.value);
});

document.getElementById("mobileSearch").addEventListener("input", renderApplicationList);
document.getElementById("mobileScanApp").addEventListener("change", populateExpectedDocs);
document.getElementById("mobileDocText").addEventListener("input", () => renderDetectedFields());
document.getElementById("samplePanBtn").addEventListener("click", () => {
  document.getElementById("mobileExpectedDoc").value = "PAN";
  document.getElementById("mobileDocText").value = "PAN ABCDE1234F Name Ramesh Textiles DOB 01/01/1980";
  renderDetectedFields("Sample PAN detected");
});
document.getElementById("sampleAadhaarBtn").addEventListener("click", () => {
  document.getElementById("mobileExpectedDoc").value = "Aadhaar";
  document.getElementById("mobileDocText").value = "Aadhaar 1234 5678 9012 Name Ramesh Textiles DOB 01/01/1980";
  renderDetectedFields("Sample Aadhaar detected");
});
document.getElementById("mobileFile").addEventListener("change", () => {
  const files = [...document.getElementById("mobileFile").files];
  const file = files[0];
  document.getElementById("mobileFileName").textContent = files.length ? `Selected: ${files.length} file${files.length === 1 ? "" : "s"}` : "No file selected";
  document.getElementById("mobileScanResult").innerHTML = files.length ? `<strong>File selected</strong><span>${files.map((item) => item.name).join(", ")}</span>` : "No scan yet.";
  if (file && files.length === 1) {
    autoReadMobileFile(file).then((text) => {
      if (text) {
        document.getElementById("mobileDocText").value = text;
        renderDetectedFields("Text read automatically");
      }
    });
  }
});
document.getElementById("mobileScanBtn").addEventListener("click", scanMobileDocument);
document.getElementById("syncOfflineBtn").addEventListener("click", syncOfflineQueue);

document.getElementById("mobileChatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("mobileChatInput");
  const question = input.value.trim();
  if (!question) return;
  addMessage("user", question);
  input.value = "";
  setTimeout(() => addMessage("assistant", answerQuestion(question)), 180);
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}

addMessage("assistant", "Ask me who to call, what is missing, or which applicants are at risk.");
renderDetectedFields();
loadState();
