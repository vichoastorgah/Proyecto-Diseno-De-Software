# Client (React + Vite)

Single-page app for the Electronic Voting & Mass Survey System. See the root `README.md` for the full architecture and setup.

```bash
npm install
npm install @react-oauth/google   # first time only (Google SSO button)
cp .env.example .env              # set VITE_GOOGLE_CLIENT_ID (and VITE_API_BASE_URL if needed)
npm run dev                       # http://localhost:5173
npm run build                     # production build in dist/
npm run lint
```

Routes: `/login` (Google SSO), `/admin` (protected), `/survey` (dashboard), `/vote?token=...` (one-time voting link).