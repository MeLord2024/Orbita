# Orbita — discovery and subscriptions (experimental v0.4.35 workstream)

This branch builds **on** `feature/global-presence-rooms-v0434`, not directly on `main`. Both milestones require validation before merging or deploying.

## Implemented

- A **Subscribe / Subscribed** control in the chat header.
- Local subscriptions saved in `chrome.storage.local` under `orbita.subscriptions.v1`; up to 100 normalized URL/language pairs. No registration or server-side subscription tracking.
- Under the existing **Feed** tab: **All**, **Active rooms**, **Subscriptions**. The other top-level tabs retain their existing behavior.
- Language filter applies to active rooms and subscriptions. Time filter applies to active-room message totals. The live online count is always current.
- The **Active rooms** list currently shows **only eight intentionally public global rooms** (RU, EN, DE, FR, ES, IT, JA, ZH). It includes real online counts and real message totals for the selected period; the list opens a room through the extension.
- New Worker endpoint `GET /api/discover?period=day&lang=*` and an index on `orb_msg(url, lang, ts)`.
- Fixes the double-hash mismatch in the v0.4.34 branch's virtual-room online count.

## Intentionally deferred

- Discovery of **all arbitrary website rooms** is NOT enabled. It would risk publishing private URLs or identifying browsing activity. It needs an explicit public-room registry, strict URL allowlist/validation, opt-in publication, spam resistance and data retention policy.
- **New-message counts in subscriptions** and server-side notifications are not implemented.
- Time filter does not yet filter local subscriptions, because local follows do not store message activity metrics.
- Search and reactions/notifications are future milestones.

## Deployment / test checklist

1. Follow the prerequisites in `docs/GLOBAL_ROOMS_V0434.md` (global presence schema and Worker).
2. Add the new `orb_msg_url_lang_ts` index from `server/cloudflare/schema.sql` to the existing D1 database.
3. Deploy the updated Worker to a **test** environment; verify `/api/discover?period=day&lang=ru` returns a `rooms` array.
4. Install the extension in a test Chromium profile, subscribe to a page, reload, and confirm the subscription persists.
5. Check the All / Active rooms / Subscriptions tabs, time and language filters, opening global rooms and unsubscribing.
6. Test with sync disabled, no network, and two browser profiles. No fake counts should appear.

## Known compatibility issue

The repository's current `extension/manifest.json` still declares **0.4.28**, despite the planned v0.4.34/v0.4.35 milestone names. Do **not** claim this branch is a tested v0.4.35 release. First reconcile the repository with the user's actual latest v0.4.33 archive, then bump the manifest version during release preparation.

## Server cost

The directory queries up to eight per-room counts for each refresh, and global presence uses recurring writes. Review Cloudflare D1 free-tier budgets and cache/rate-limit the discovery endpoint before production rollout.
