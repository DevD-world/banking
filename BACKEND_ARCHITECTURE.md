# Completion IQ Backend Architecture

The app now includes a local backend that serves the frontend and persists data in SQLite.

## Run URL

- Full-stack app: `http://127.0.0.1:8000/`
- Health check: `http://127.0.0.1:8000/api/health`

## Backend Capabilities

- SQLite database persistence.
- Seeded demo data for applications, documents, rules, integrations, and users.
- Application create/update APIs.
- Full state sync API used by the frontend.
- Document scan API with document classification and field extraction.
- Manual review queue support.
- Audit event logging.
- Reset endpoint for clean demos.
- Static frontend hosting from the same backend service.

## Current API

- `GET /api/health`
- `GET /api/state`
- `POST /api/state`
- `POST /api/reset`
- `POST /api/applications`
- `PATCH /api/applications/{id}`
- `POST /api/scan`
- `GET /api/audit`

## Production Upgrade Path

Replace the local standard-library server with FastAPI, NestJS, or Spring Boot.

Replace SQLite with PostgreSQL and split the JSON state into relational tables:

- users
- customers
- applications
- product_document_rules
- application_documents
- tasks
- followups
- audit_events
- risk_snapshots

Add production services:

- SSO/OIDC authentication
- role-based access control
- encrypted object storage
- Azure Document Intelligence / AWS Textract / Google Document AI
- OpenAI or Azure OpenAI copilot
- WhatsApp Business API
- SMS/email gateway
- CRM integration
