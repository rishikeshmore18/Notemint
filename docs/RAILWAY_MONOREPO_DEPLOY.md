# Railway Monorepo Deploy (Notemint)

This repository deploys as three pieces:
- Frontend (your existing frontend hosting flow)
- `notemint-backend` service from `/backend`
- `notemint-voice` service from `/voice-service`

## 1. Deploy voice service first
In Railway:
1. New Project -> Deploy from GitHub repo.
2. Select this repo.
3. Service settings -> Root Directory = `voice-service`.
4. Ensure Dockerfile is detected (`voice-service/Dockerfile`).
5. Add variables:
   - `MIN_DURATION_SEC=1.5`
   - `SPEECHBRAIN_MODEL_SOURCE=speechbrain/spkrec-ecapa-voxceleb`
6. Generate domain.
7. Confirm health: `GET https://<voice-domain>/health` returns `{"status":"ok"}`.

## 2. Deploy backend service
In Railway:
1. Add new service from same GitHub repo.
2. Root Directory = `backend`.
3. Add variables:
   - `PORT=3001`
   - `FRONTEND_URL=https://<your-frontend-domain>`
   - `SUPABASE_URL=...`
   - `SUPABASE_SERVICE_ROLE_KEY=...`
   - `GLADIA_KEY=...`
   - `ANTHROPIC_KEY=...`
   - `XAI_KEY=...`
   - `VOICE_SERVICE_URL=https://<voice-domain>`
   - `VOICE_MATCH_THRESHOLD=0.72`
   - `VOICE_CONTACT_MATCH_THRESHOLD=0.74` (optional tuning)
4. Generate domain.
5. Confirm health: `GET https://<backend-domain>/health` returns `{"status":"ok"}`.

## 3. Frontend configuration
Set only these frontend env vars:
- `VITE_SUPABASE_URL=...`
- `VITE_SUPABASE_ANON_KEY=...`
- `VITE_API_URL=https://<backend-domain>`

Do not set provider keys in frontend.

## 4. Post-deploy checks
1. Sign in works.
2. Record meeting works.
3. Summary still streams.
4. Self voice enrollment/status works.
5. Speaker review:
   - auto-detects `You` when confident
   - remembers named contacts over time
   - auto-matches known contacts when confident
