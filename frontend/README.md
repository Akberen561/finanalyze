# FinAnalyze Frontend

React/Vite frontend for transaction browsing, analytics, uploads, network graph, and project management.

## Stack

- React 19
- Vite
- Tailwind CSS 4
- Recharts

## Run

```powershell
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8003`.

## Build

```powershell
cd frontend
npm run build
```

## Notes

- `VITE_API_BASE_URL` can override the default same-origin API base.
- Word report generation, AI assistant, and risk review actions are disabled in this public build.
- The related sidebar icons remain visible as inactive UI placeholders.
