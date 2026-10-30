# Orbita test media storage: Cloudflare Workers KV (no credit card, 7 days)

Use **worker-v0.5.10-media-kv-7days.js** (NOT the older R2-backed worker-v0.5.10-media.js).

## Cloudflare steps

1. Open Cloudflare dashboard > **Storage & databases > Workers KV**. Create KV namespace **orbita-media**. R2 subscription is NOT required.
2. Open **Compute > Workers & Pages > orbita > Settings > Bindings > Add**.
3. Choose **KV namespace**, set variable name exactly **MEDIA**, select namespace **orbita-media**, save/deploy the binding. Keep the existing D1 **DB** binding unchanged.
4. Back up the currently deployed Worker source. Open **Edit code**, replace entire source with `worker-v0.5.10-media-kv-7days.js`, and **Save/Deploy**.
5. Verify `/api/health`, the original text chat, then test a photo/video/music upload below 1 MiB from Android. Open the media link and test audio/video seeking and file saving. Existing PC extension needs its own UI renderer for rich media; its text messages continue unchanged.

## Contract and behavior

- POST `/api/media` with JSON `{name,mime,base64}` returns media key and URL.
- GET / HEAD `/api/media/<key>` serves original file; GET supports HTTP Range (206).
- Key prefixes `photos/`, `videos/`, `music/`; no actual folders required.
- 1 MiB per-file decoded size limit; JPG, PNG, WebP, MP4, WebM, MP3, OGG, M4A.
- Each object written with `expirationTtl:604800` (7 days) and expiry metadata. KV deletes expired files automatically; missing/expired returns 410.
- No SQL migration. Existing D1 `orb_rate` used for anonymous upload quotas (8 / 5 minutes and 50 / day per IP).
- KV Free currently: 1 GB storage, 1,000 writes/day, 100,000 reads/day. Operations fail at free quota; there are no R2 fees and no R2 activation.

Notes: newly written KV values can take up to ~60 seconds to become visible in some regions due to eventual consistency. The message and reactions can remain in D1 after media expires; Android should show an unavailable-media state for expired attachments. Source edits alone do NOT deploy a Worker to Cloudflare.
