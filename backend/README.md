# Backend (Mock Repair Loop APIs)

This backend provides the API endpoints expected by the repair loop adapters:

- `POST /api/repair-agent/propose`
- `POST /api/sandbox/apply-patch`
- `POST /api/tests/run`
- `POST /api/assertion-checker/strengthen`
- `POST /api/orchestrator/intake-assertion-report`
- `POST /api/orchestrator/run-repair-loop`
- `GET /api/health`

## LLM for Case 2 (new test code generation)

`/api/orchestrator/run-repair-loop` now calls Gemini to synthesize candidate test code.
Set one of the following before running backend:

- `GEMINI_API_KEY` (recommended)
- `VITE_GEMINI_API_KEY` (fallback)

Optional:

- `GEMINI_MODEL` (default: `gemini-2.5-flash`)
- `GEMINI_BASE_URL` (default: `https://generativelanguage.googleapis.com/v1beta`)

## Run

```bash
cd backend
npm install
npm run dev
```

From the project root you can run both apps:

```bash
npm install
npm --prefix backend install
npm run dev:all
```

This server is currently a mock implementation for end-to-end integration testing.
