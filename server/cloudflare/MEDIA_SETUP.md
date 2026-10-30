# Orbita media deployment — latest uploaded Worker (v0.5.10 base)

Source of truth: the user-provided active Cloudflare Worker `worker(3).js` (2026-10-30), not the old worker from Android APK or a stale PC archive.

## What changed
`worker-v0.5.10-media.js` is a complete, self-contained Worker. It keeps the original PC/Android chat APIs, moderation, categories, presence, and message schema unchanged. It adds:

- `POST /api/media` with JSON `{name,mime,base64}`; response `{key,url,kind,mime,size,name}`.
- `GET /api/media/<key>`, `HEAD`, byte-range `GET` for audio/video seek, and CORS `OPTIONS`.
- R2 object prefixes `photos/`, `videos/`, `music/`.
- Hard **1 MiB (1,048,576 bytes)** decoded file limit.
- Supported MIME: JPEG, PNG, WebP, MP4, WebM, MP3, OGG, M4A.
- Magic-byte validation, safe UUID object keys, immutable static reads, and upload quotas.

## Production setup

1. In Cloudflare dashboard, make a backup of your currently deployed Worker. Keep the current D1 database and all other bindings untouched.
2. **R2 > Create bucket**: `orbita-media` (any bucket name is fine).
3. Open the *existing live Orbita Worker* > Settings > Bindings > Add > R2 bucket. Set **variable name `MEDIA`**, choose bucket `orbita-media`.
4. Confirm existing D1 binding **`DB`** remains on the same database. This also backs upload rate limits via the *existing* `orb_rate` table. No SQL migration and no extra `MEDIA_RATE_LIMIT` binding are required by this merged Worker.
5. In Worker's editor replace **the entire Worker script** with `worker-v0.5.10-media.js`. Save and Deploy. **Do not deploy the media-only adapter by itself**.
6. Smoke-test `/api/health`, `/api/channels`, `/api/pull` and posting ordinary text. Check `OPTIONS /api/media`, upload a safe test JPEG below 1 MiB, open its returned URL, seek an MP4/MP3, test an oversized file (HTTP 413).
7. Test Android v0.3.55+ upload and rendering in chat; separately test PC extension to ensure legacy text-only chat is unaffected.

A successful APK or GitHub commit **does not deploy the Cloudflare Worker**. Live uploads require steps 2–6 to be completed in Cloudflare and verified.

## Important compatibility and operations

Android sends a validated media marker in message text, avoiding D1 schema changes. Desktop extension versions without a media renderer will show the marker text rather than a rich preview. PC and Android *interfaces remain independent*; only the server protocol is shared.

Media uploads are public, and files remain in R2 when messages are deleted unless a separate deletion/lifecycle policy is configured. Consider a bucket lifecycle and cleanup jobs before public scale. Rate limits: 8 uploads / 5 minutes and 50 / day per IP, hashed into D1; Cloudflare WAF/rate limiting is recommended as an additional layer if traffic grows.
