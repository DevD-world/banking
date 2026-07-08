# Completion IQ - Production Implementation Notes

This prototype is a browser-based MVP. It is fully functional locally using browser storage, but a production banking deployment should replace local storage and simulated AI with secure services.

## Production Architecture

- Frontend: React or Next.js web app for RM, manager, and admin roles.
- Backend: NestJS, FastAPI, or Spring Boot API.
- Database: PostgreSQL for applications, documents, tasks, audit logs, users, and product rules.
- File Storage: Azure Blob Storage, AWS S3, or bank-approved object storage.
- OCR: Azure AI Document Intelligence, AWS Textract, Google Document AI, or an on-prem OCR engine.
- AI Copilot: Azure OpenAI or OpenAI API with retrieval over application, document, task, and audit data.
- Auth: SSO/OIDC, role-based access control, branch-level access policies.
- Integrations: CRM API, WhatsApp Business API, SMS gateway, email service, call-center system.

## Core Data Tables

- users: id, name, email, role, branch, manager_id, status.
- applications: id, customer_id, product, stage, rm_id, branch, value, source, customer_intent, created_at, last_activity_at.
- customers: id, name, mobile, email, kyc identifiers, consent status.
- product_document_rules: product, document_name, weight, mandatory, extraction_fields.
- application_documents: id, application_id, document_name, status, confidence, extracted_json, file_url.
- tasks: id, application_id, title, type, owner_id, due_date, status, priority.
- followups: id, application_id, channel, message, status, sent_at, response_status.
- audit_events: id, application_id, actor_id, event_type, event_text, created_at.
- risk_snapshots: application_id, completion_score, risk_score, reasons, created_at.

## AI/OCR Flow

1. RM uploads document.
2. Backend stores the file in secure object storage.
3. OCR extracts text and structured fields.
4. Document classifier predicts document type.
5. Validation checks product checklist, customer name, PAN, Aadhaar/GST, readability, expiry, duplicates.
6. If confidence is high, document is attached automatically.
7. If confidence is low or mismatch exists, document goes to manual review.
8. Completion score, risk score, task list, and copilot recommendations are recalculated.

## Copilot Guardrails

- The chatbot should only answer from approved application data.
- Every answer should include why it is recommending an action.
- Sensitive customer identifiers should be masked unless the user role permits access.
- The copilot should create drafts and tasks, but sending WhatsApp/SMS/email should require user confirmation.
- All AI-generated actions should be logged in audit_events.

## Scoring Model

Completion score:

- Mandatory document completion.
- Current workflow stage.
- Verification completion.
- Follow-up freshness.
- Manual review clearance.

Risk score:

- Missing mandatory documents.
- Days since last activity.
- Overdue tasks.
- Customer intent.
- Product-specific historical abandonment.
- Branch approval SLA.
- RM workload.

## MVP To Production Roadmap

Phase 1:

- Auth and roles.
- Application CRUD.
- Document checklist and upload.
- Completion and risk scoring.
- RM dashboard.
- Manager dashboard.
- Follow-up tasks.
- Copilot recommendations.

Phase 2:

- CRM integration.
- WhatsApp, SMS, and email sending.
- OCR and document verification.
- Aadhaar/PAN/GST validation integrations.
- Call-center integration.

Phase 3:

- Abandonment prediction.
- Root-cause discovery.
- Branch performance intelligence.
- RM productivity intelligence.
- Product funnel leakage analytics.
- Revenue recovery forecasting.
