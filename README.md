# FinAnalyze

Monorepo for the FinAnalyze backend and frontend.

## Structure

- `backend/` - FastAPI backend for auth, projects, ingestion, transactions, analytics, network data, and admin.
- `frontend/` - React/Vite frontend for uploads, transaction browsing, analytics, network graph, and project management.

## Disabled Features

The public version keeps the visual navigation icons for these areas, but the functions are disabled:

- Word report generation
- AI assistant / NL2SQL chat
- Risk search and fraud warning review

## Local Run

Backend:

```powershell
cd backend
.\venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8003 --reload
```

Frontend:

```powershell
cd frontend
npm install
npm run dev
```

The frontend proxies `/api` requests to `http://127.0.0.1:8003`.
