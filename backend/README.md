# FinAnalyze Backend

FastAPI backend for transaction ingestion, analytics, projects, authentication, and admin tools.

## Requirements

- Python 3.13+
- PostgreSQL
- Configured local `.env`

## Run

```powershell
cd backend
.\venv\Scripts\Activate.ps1
python -m uvicorn app.main:app --host 127.0.0.1 --port 8003 --reload
```

Health check:

```powershell
Invoke-WebRequest http://127.0.0.1:8003/health
```

Useful URLs:

- `http://127.0.0.1:8003/docs`
- `http://127.0.0.1:8003/admin`

## Notes

- AI assistant / NL2SQL chat is not registered in this public build.
- Risk warning generation returns an empty result.
- Word report generation is disabled on the frontend.
