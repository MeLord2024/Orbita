# Orbita v0.4.34 — global online and language rooms

## Status

**Development branch only.** Do not merge or distribute as a working release until the Cloudflare Worker and D1 schema have been updated and tested. No production deployment is performed by this change.

## What changed

- A new anonymous, installation-level global heartbeat, independent of open chat tabs.
- Global count shown on the browser extension icon, including when the overlay is closed.
- Compact badge labels (`1K+`, `12K`, etc.); exact count appears in the action tooltip.
- Eight fixed global rooms (RU, EN, DE, FR, ES, IT, JA, ZH), using internal virtual URLs such as `https://global.orbita.invalid/ru`. **These are identifiers only; the extension opens its own `chat.html` page, not the virtual URL.**
- A localized button in the chat header opens the corresponding language room in a new tab and displays the server-reported number of room participants.
- New server endpoints: `POST /api/global-presence`, `GET /api/global-stats`, `GET /api/global-rooms`.
- New D1 table: `orb_global_pres`.

## Deploy prerequisites

1. Apply the new `orb_global_pres` D1 table and index from `server/cloudflare/schema.sql` to the **existing production D1 database**. Do not delete existing tables or data.
2. Deploy the updated `server/cloudflare/worker.js` to the Worker used by `extension/store.js`.
3. Verify `GET /api/global-stats` returns `{"ok":true,"online":0,...}` (or a positive number), and `GET /api/global-rooms` returns eight keys.
4. Load the extension unpacked in a test Chrome profile. Open no chats; after the initial heartbeat, the badge should show the global online count. Test two independent profiles to ensure each is counted once.
5. Open the Russian global room, verify the room count and send a message; then verify the same room on a second profile.
6. Test disabled synchronization, offline behavior, reopening Chrome, UI language changes, and existing ordinary room badges.

## Operational caveats

- This counter represents **recently connected pseudonymous installations**, not guaranteed distinct humans. Multiple browser profiles or reinstalls can be counted separately; clients can spoof requests. It is not a verified unique-user metric.
- A heartbeat is scheduled approximately every four minutes, with a five-minute online timeout. MV3 alarms and sleeping browsers make it approximate.
- **D1 write cost:** one write per connected installation every four minutes can reach about 360 writes per installation per day, before other traffic. At scale this requires a more efficient presence backend or paid capacity. Review actual Cloudflare limits before launch.
- The server does not receive browsing URLs in the global-presence endpoint. It stores a stable pseudonymous installation alias; protect and rate-limit this endpoint if exposed to abuse.
- Existing clients that have not upgraded to v0.4.34 are not counted by the new global metric.
- A room shows a dash when the server count is unavailable; no fabricated online counts are displayed.

## Deferred to later phases

Global discovery/feed filters, subscriptions, global full-text search, and personalized notifications are **not part of this branch**.
