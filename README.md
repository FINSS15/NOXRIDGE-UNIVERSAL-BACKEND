# NOXRIDGE UNIVERSAL BACKEND

**NOXRIDGE COMMUNITY** — centralized API backend built with Node.js 22+, Express 5, and Backblaze B2 (S3-compatible storage).

## Features

- Health check and system status endpoints
- API key and master key authentication
- OpenAI-compatible AI chat endpoint
- Image, music, general file, RBXM/RBXMX, and RBXL/RBXLX uploads
- Backblaze B2 object storage
- PostgreSQL-backed accounts, trial/permanent plans, and encrypted Open Cloud key vault (requires database configuration)\n- Request rate limits, security headers, validation, and centralized errors

## Requirements

- Node.js 22 or newer
- npm
- Backblaze B2 credentials for upload functionality
- A Google Gemini API key for AI chat functionality (Free Tier; no paid fallback)

## Local setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Set the required credentials and provider settings in `.env`.
4. Start the API with `npm start`.
5. Run syntax checks with `npm run check`.

## Main endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/` | API information |
| GET | `/health` | Health check |
| GET | `/system/status` | Runtime and configuration status |
| GET | `/auth/verify` | Verify API key |
| GET | `/auth/verify/master` | Verify master key |
| POST | `/ai/chat` | AI chat |
| POST | `/upload` | Upload an object to Backblaze B2 |

See [docs/API.md](docs/API.md) for request formats and details.\n\n## Account system setup\n\nTo enable account endpoints, provision a persistent PostgreSQL database and set `DATABASE_URL` on Render. Also set `KEY_ENCRYPTION_SECRET` to a unique random value (at least 32 characters) and optionally set `TRIAL_DURATION_HOURS` (default 24). The account schema is created automatically on first account request. Without `DATABASE_URL`, existing backend functions continue to run and account endpoints return HTTP 503.

## Important Roblox file limitation

RBXM/RBXMX and RBXL/RBXLX uploads are currently signature-checked and stored as files. This backend does **not** yet deserialize Roblox files or rebuild their object hierarchy, properties, or script source.

## Deployment

Configure the environment variables in your hosting provider (for example Render), then use:

- Build command: `npm install`
- Start command: `npm start`

Never commit real API keys, master keys, or Backblaze credentials.
