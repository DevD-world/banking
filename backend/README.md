# Completion IQ Backend

Dependency-free local backend for the Application Completion Intelligence Platform.

## Run

```powershell
python backend/server.py
```

Then open:

```text
http://127.0.0.1:8000/
```

## What It Provides

- SQLite persistence at `backend/completion_iq.sqlite3`
- Static frontend serving
- CORS-enabled JSON API
- Seeded demo data
- Application state persistence
- Application create/update API
- Document scan/classification API
- Review queue support
- Audit event table
- Reset endpoint

## Useful Endpoints

- `GET /api/health`
- `GET /api/state`
- `POST /api/state`
- `POST /api/reset`
- `POST /api/applications`
- `PATCH /api/applications/{id}`
- `POST /api/scan`
- `GET /api/audit`

This backend is intentionally dependency-free for easy demos. For production, move to FastAPI/NestJS/Spring Boot with PostgreSQL, object storage, SSO, and real OCR/AI integrations.
