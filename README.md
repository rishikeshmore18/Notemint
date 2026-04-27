# Notemint

Monorepo layout:
- `src/` = frontend (Vite + React)
- `backend/` = Node/Express provider proxy API
- `voice-service/` = FastAPI SpeechBrain voice embedding service

## Phase 13 Deployment (Same Repo, Multi-Service)
You can deploy all services from this single repository.

### Railway services
Create two Railway services from this repo:

1. `notemint-backend`
- Root Directory: `/backend`
- Start command: `node src/index.js` (already in `backend/Procfile`)

2. `notemint-voice`
- Root Directory: `/voice-service`
- Deploy with `voice-service/Dockerfile`

### Required environment variables
Set these in each Railway service.

#### Backend service (`/backend`)
- `PORT=3001`
- `FRONTEND_URL=https://YOUR_FRONTEND_DOMAIN`
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`
- `GLADIA_KEY=...`
- `ANTHROPIC_KEY=...`
- `XAI_KEY=...`
- `VOICE_SERVICE_URL=https://YOUR_VOICE_SERVICE_DOMAIN`
- `VOICE_MATCH_THRESHOLD=0.72`
- `VOICE_CONTACT_MATCH_THRESHOLD=0.74` (optional override)

#### Voice service (`/voice-service`)
- `MIN_DURATION_SEC=1.5`
- `SPEECHBRAIN_MODEL_SOURCE=speechbrain/spkrec-ecapa-voxceleb`

### Frontend env vars
Frontend should only use:
- `VITE_SUPABASE_URL=...`
- `VITE_SUPABASE_ANON_KEY=...`
- `VITE_API_URL=https://YOUR_BACKEND_DOMAIN`

No provider keys should be present in frontend env.

## Local development
Terminal 1 (backend):
```bash
cd backend
npm install
npm run dev
```

Terminal 2 (voice service):
```bash
cd voice-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn src.main:app --host 0.0.0.0 --port 8000
```

Terminal 3 (frontend):
```bash
npm install
npm run dev
```

## Quick verification
- Backend health: `GET /health` on backend domain
- Voice health: `GET /health` on voice-service domain
- Frontend uses `VITE_API_URL` and does not expose provider keys
