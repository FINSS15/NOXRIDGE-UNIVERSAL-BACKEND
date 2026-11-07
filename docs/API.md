NOXRIDGE UNIVERSAL BACKEND API

Organization: NOXRIDGE COMMUNITY
Version: 1.0.0
Runtime: Node.js 22+
Framework: Express 5
Storage: Backblaze B2 (S3 Compatible)

---

1. Overview

NOXRIDGE UNIVERSAL BACKEND is a centralized API service for NOXRIDGE COMMUNITY.

The backend provides:

- API Key authentication
- Master Key authentication
- AI Chat API
- Image upload API
- Music upload API
- General file upload API
- Roblox RBXM and RBXL file upload
- Backblaze B2 storage integration
- System status monitoring
- Health check endpoint

2. Base URL

After deployment, use your Render service URL:

"https://YOUR-SERVICE.onrender.com"

Replace the example URL with your actual deployment URL.

3. Authentication

API Key

Protected endpoints require this header:

"x-api-key: YOUR_API_KEY"

Master Key

Master-protected endpoints require:

"x-master-key: YOUR_MASTER_KEY"

Never expose authentication keys in public repositories or frontend source code.

4. Health Check

GET /health

Checks whether the backend process is running.

Example response:

{
  "success": true,
  "service": "NOXRIDGE UNIVERSAL BACKEND",
  "organization": "NOXRIDGE COMMUNITY",
  "status": "healthy",
  "version": "1.0.0"
}

5. System Status

GET /system/status

Returns backend runtime and service configuration status.

Response includes:

- Node.js version
- Server uptime
- API Key configuration state
- Master Key configuration state
- Backblaze B2 configuration state
- AI provider configuration state

This endpoint reports configuration state, not verified external connectivity.

6. Authentication Verification

Verify API Key

GET /auth/verify

Required header:

"x-api-key: YOUR_API_KEY"

Verify Master Key

GET /auth/verify/master

Required header:

"x-master-key: YOUR_MASTER_KEY"

7. AI Chat API

POST /ai/chat

Required headers:

"x-noxridge-user-id: ROBLOX_USER_ID"

"x-noxridge-wl-key: PLAYER_WL_KEY"

Content-Type:

"application/json"

Request body:

{
  "message": "Hello NOXRIDGE AI",
  "conversation": []
}

Conversation history example:

{
  "message": "What did I ask earlier?",
  "conversation": [
    {
      "role": "user",
      "content": "Hello"
    },
    {
      "role": "assistant",
      "content": "Hello! How can I help?"
    }
  ]
}

The AI service uses Google Gemini 3.1 Flash Lite through Google's OpenAI-compatible endpoint. Required authentication headers are x-noxridge-user-id and x-noxridge-wl-key. Gemini's API key is stored only in Render as GEMINI_API_KEY. PostgreSQL is required for persistent quota enforcement. The service enforces 9 chats per WL player per day, 450 requests globally per day, and 12 requests globally per minute. The daily quota date follows midnight Pacific time. There is no paid-provider fallback. A successful response includes remaining player and global quota in the quota object.

8. File Upload API

POST /upload

Required header:

"x-api-key: YOUR_API_KEY"

This general endpoint accepts only file, rbxm, and rbxl categories. Personal image/music uploads use POST /storage/upload with an account Bearer token.

Content-Type:

"multipart/form-data"

Fields:

Field| Description
file| File to upload
category| Upload category

Supported categories:

Category| Supported extensions
image| JPG, JPEG, PNG, WEBP, GIF
music| MP3, WAV, OGG, FLAC, M4A, AAC
file| PDF, ZIP, TXT
rbxm| RBXM, RBXMX
rbxl| RBXL, RBXLX

Maximum file size: 50 MB.

Uploaded objects are stored in Backblaze B2.

Roblox format validation currently checks basic file signatures. It does not parse or reconstruct the complete Roblox hierarchy or script source.

9. Rate Limits

Endpoint group| Limit
General API| 100 requests / 15 minutes
AI Chat| 20 requests / 15 minutes
Upload| 10 requests / 15 minutes

Limits are applied per client IP using the configured Express rate limiter.

10. Environment Variables

Variable| Purpose
NODE_ENV| Application environment
PORT| Server port
CORS_ORIGIN| Allowed browser origins
API_KEY| API authentication
MASTER_KEY| Master authentication
B2_ENDPOINT| Backblaze S3 endpoint
B2_REGION| Backblaze region
B2_BUCKET| Bucket name
B2_KEY_ID| Application Key ID
B2_APPLICATION_KEY| Application Key
AI_API_KEY| AI provider key
AI_BASE_URL| AI provider base URL
AI_MODEL| AI model identifier

11. Error Responses

All application errors use a standardized JSON structure:

{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error description."
  }
}

Common HTTP statuses:

Status| Meaning
400| Bad Request
401| Unauthorized
403| Forbidden
404| Route Not Found
413| Payload Too Large
429| Rate Limit Exceeded
500| Internal Server Error
502| Upstream Provider Error
503| Service Unavailable
504| Gateway Timeout

12. Security

- Keep all API credentials private.
- Use HTTPS in production.
- Do not commit ".env" files.
- Configure restricted Backblaze B2 application permissions.
- Do not expose Master Keys to public clients.
- Monitor API usage and upload limits.

---

NOXRIDGE COMMUNITY
NOXRIDGE UNIVERSAL BACKEND — API Documentation


13. Account API (PostgreSQL required)

The account endpoints are disabled until DATABASE_URL points to a persistent PostgreSQL database.

POST /account/register
Body: { "username": "player_name", "password": "at-least-10-characters" }
Creates a trial account. Trial duration is controlled by TRIAL_DURATION_HOURS (default 24 hours).

POST /account/login
Body: same username/password fields. Returns a bearer session token.

GET /account/me
Authorization: Bearer ACCOUNT_TOKEN
Returns the account plan and trial expiry.

POST /account/logout
Authorization: Bearer ACCOUNT_TOKEN
Revokes the current session.

GET /account/open-cloud-key/status
Authorization: Bearer ACCOUNT_TOKEN
Returns whether a permanent account has a saved key and its last update time. Never returns the key.

PUT /account/open-cloud-key
Authorization: Bearer ACCOUNT_TOKEN
Body: { "apiKey": "ROBLOX_OPEN_CLOUD_KEY" }
Available only to permanent accounts. The key is encrypted with AES-256-GCM before it is stored. Set KEY_ENCRYPTION_SECRET to a random secret of at least 32 characters.

DELETE /account/open-cloud-key
Authorization: Bearer ACCOUNT_TOKEN
Deletes the saved key.

POST /account/admin/promote
Header: x-master-key: MASTER_KEY
Body: { "username": "player_name" }
Owner-only endpoint to promote an account to permanent. Never place MASTER_KEY in the importer.

Trial policy:
- Trial accounts do not get their Open Cloud key saved in PostgreSQL.
- Trial users must provide their key transiently on each future Roblox Open Cloud operation; that operation endpoint still needs to be integrated.
- Permanent accounts can save one Open Cloud key for reuse.
- AI remains configured with the backend-owned AI_API_KEY, separate from users' Roblox keys.

Security notes:
- Passwords are stored as scrypt hashes, not plaintext.
- Session tokens are stored as SHA-256 hashes and expire after 30 days.
- Saved Open Cloud keys are encrypted at rest. Rotating KEY_ENCRYPTION_SECRET without re-encrypting stored keys makes existing saved keys unreadable.
- Account registration currently creates trial accounts; promotion is controlled by the master-key endpoint.


14. Roblox Open Cloud Asset Upload

POST /assets/upload
Authorization: Bearer ACCOUNT_TOKEN
Content-Type: multipart/form-data

Form fields:
- file: binary asset file
- assetType: Model, Decal, Audio, or Animation
- displayName: asset display name (1-50 characters)
- description: optional description (up to 1000 characters)
- creatorType: user or group
- creatorId: numeric Roblox user ID or group ID

Permanent accounts use the encrypted saved key. Trial accounts must include x-roblox-open-cloud-key on every request; the trial key is not persisted.

Supported formats:
- Model: .fbx, .gltf, .glb, .rbxm, .rbxmx
- Decal: .png, .jpg, .jpeg, .bmp, .tga
- Audio: .mp3, .ogg, .wav, .flac
- Animation: .rbxm, .rbxmx

Maximum file size: 20 MB per request. Roblox may enforce additional asset-type quotas, moderation, creator ownership, and key permission rules.

GET /assets/operations/:operationId
Authorization: Bearer ACCOUNT_TOKEN
Returns the Roblox operation status and, when processing completes, the asset ID.

The Open Cloud key must have asset write permissions and access to the intended creator/resource. Roblox documents this API as beta. The backend does not receive or store the key in plaintext for permanent accounts.


15. Personal Image and Music Storage (PostgreSQL required)

All personal storage endpoints require:
Authorization: Bearer ACCOUNT_TOKEN

POST /storage/upload
multipart/form-data fields:
- file: image or audio file
- category: image or music

GET /storage
Lists only the authenticated account's own stored files.

GET /storage/:id/download
Returns a signed private download URL valid for 15 minutes. The record is looked up using both the file ID and authenticated account ID; another account cannot list or download it.

Objects are stored under a per-account key prefix in the private Backblaze B2 bucket. B2 credentials remain server-side and are not exposed to users.

16. Roblox Image and Audio Publishing

POST /assets/upload
Authorization: Bearer ACCOUNT_TOKEN
multipart/form-data fields:
- file
- assetType: Image, Decal, or Audio
- displayName
- description (optional)
- creatorType: user or group
- creatorId: numeric Roblox user ID or group ID

GET /assets/operations/:operationId
Authorization: Bearer ACCOUNT_TOKEN

The Roblox Open Cloud key is selected from the authenticated account only: permanent accounts use their encrypted saved key; trial accounts must provide x-roblox-open-cloud-key on each request. Operation IDs are recorded against the account that created them, and status checks are restricted to that account.

Roblox's documented endpoints are POST https://apis.roblox.com/assets/v1/assets and GET https://apis.roblox.com/assets/v1/operations/{operationId}. Supported Image/Decal formats are PNG, JPEG, BMP, and TGA; Audio formats are MP3, OGG, WAV, and FLAC. Roblox's published content-upload limit is 20 MB per file; audio duration and monthly quota restrictions also apply.


17. Bypass Music (Owned Audio Processing)

POST /assets/bypass-music
Authorization: Bearer ACCOUNT_TOKEN
Content-Type: multipart/form-data

Fields:
- file: source audio file owned by the user or authorized for use
- displayName: resulting Roblox audio name (1-50 characters)
- description: optional description
- creatorType: user or group
- creatorId: numeric Roblox user ID or group ID
- mode: speed or slow
- speed: 1.0-2.0 for speed mode, 0.5-1.0 for slow mode
- pitch: integer semitones from -12 to 12
- volume: 0.0-1.0

The backend applies the requested audio effects, exports an MP3, stores a private copy under the authenticated account's B2 prefix, then submits the processed file to Roblox as an Audio asset using that account's Open Cloud key. The Roblox operation ID is account-bound and can be checked with GET /assets/operations/:operationId.

The source must be uploaded as a file. This endpoint does not download, extract, or alter audio from a Roblox asset ID and is not a moderation, rights, or upload-quota bypass. Users must have the rights and permissions to upload the source audio. The processed MP3 must remain within Roblox's 20 MB limit.


18. Importer WL Identity and Per-Player Roblox API Key Vault

The importer uses the existing NOXRIDGE whitelist credential. No separate NOXRIDGE account registration, login, or Bearer token is required for /assets routes.

Required headers for the /assets endpoints:
- x-noxridge-user-id: the Roblox UserId associated with the WL entry
- x-noxridge-wl-key: the existing raw WL key entered into the importer; the backend verifies it against the current remote whitelist and never stores the raw value

PUT /assets/open-cloud-key
JSON body: { "apiKey": "the player's Roblox Open Cloud API key" }

GET /assets/open-cloud-key/status
Returns whether the authenticated WL player's Roblox key is configured.

DELETE /assets/open-cloud-key
Deletes only that WL player's saved Roblox key.

The Roblox Open Cloud key is encrypted server-side with AES-256-GCM and stored against the verified WL UserId. Upload and operation-status routes resolve only that player's saved key. Image and Audio uploads also create a private Backblaze B2 copy under that player's own users/{UserId}/ prefix. Bypass Music stores its processed MP3 in the same per-player private area.

Required Render environment variables:
- DATABASE_URL
- KEY_ENCRYPTION_SECRET (at least 32 characters)

The existing WL credential is used as the proof of whitelist membership; it is not the Roblox API key. Never log or share either secret.
