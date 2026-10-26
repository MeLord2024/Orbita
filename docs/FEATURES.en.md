# Orbita — Features and Technical Reference (English)

[← Main page](../README.md) · [Русская полная документация](FEATURES.ru.md)

> **Version:** v0.4.33. This is an English overview of the implementation and user-facing behavior. The [original Russian feature checklist](FEATURES.ru.md) is the complete source document, including the detailed status table, deployment instructions and known omissions.

## What Orbita does

Orbita is a Manifest V3 Chromium extension that places a movable, resizable, translucent chat window above the current page. A room is identified by the **page URL and room language**, not by a centralized community. The extension includes a shared-server synchronization mode and an offline/local mode.

The project does not require npm dependencies for the extension. The default visual theme is **Frutiger Aero**, with glass-like surfaces, gradients and decorative backgrounds.

## Installation and use

1. Download the latest release ZIP and extract it somewhere permanent.
2. Visit `chrome://extensions`, enable Developer mode and select **Load unpacked**.
3. Choose the `extension` directory containing `manifest.json`.
4. Open any page and press `Alt+O` or `Alt+Shift+O`, or click the toolbar icon.
5. Change keyboard shortcuts at `chrome://extensions/shortcuts` if they conflict.

The extension targets Chromium browsers version 114 or newer. See [INSTALL.md](../INSTALL.md) for the existing detailed Russian troubleshooting guide.

## Rooms, nicknames and identity

- Each URL and language selection has its own conversation.
- `http` and `https` versions of the same page share a room.
- Users can link website mirrors so their messages and reactions are shared; messages retain an origin-host label.
- Anonymous use is available by default, with nicknames stored per website rather than globally.
- Glass-gradient avatars are available without registration.
- The UI is translated into **RU, EN, DE, FR, ES, IT, JA and ZH**; room selection supports **54 languages**.
- If a site cannot load, the extension can open a standalone channel tab for its URL.

## Messaging and moderation

- Vote up or down on individual messages.
- Mark up to **10 messages as important** during a rolling 24-hour period.
- Browse top messages by day, week, month, year or all time.
- Three reports or ten downvotes can collapse a message. Its vote/report counts remain visible and the message can be revealed.
- Users can collapse their own messages or delete them for everyone.
- The right panel includes a global top feed, the user's messages and replies.

## Visual effects

Effects are applied by **dragging** their icons onto another person's message. Clicking a card does not spend a charge. The per-device charge limits use a rolling 24-hour window.

| Effect | Charges / 24 h | Behavior |
|---|---:|---|
| Fireball | 3 | Flames, embers and glow inside the message bubble, for up to 12 hours or until extinguished. |
| Shield | 1 | Removes the existing animation and protects the message against new effects for one hour. |
| Fiery horns | 3 | Animated fiery hand-sign graphics rising through the message bubble. |
| Flaming like | 3 | A repeating sequence of fiery thumbs-up graphics. |
| Silence | 1 | Suspends animations throughout the current room for three minutes; prior effects resume if still within their original lifetime. |

Charges are spent only on successful applications. A shield prevents other effects while active. The user-facing help explains that charges recover 24 hours after use.

## Appearance and notifications

- Multiple skins, including the default Frutiger Aero theme.
- Custom background images, gradients and opacity.
- The chat window can be dragged and resized; dimensions and position can be remembered per site.
- Notification sounds include three built-in Web Audio tones or a custom MP3 up to 3 MB.
- Notification volume can be adjusted; first-page loading and the user's own posts do not trigger new-message sounds.

## Privacy and synchronization

The shared server URL is embedded in the extension build, rather than editable through the UI. Synchronization is on by default but can be disabled in settings. In local-only mode, chat history remains in the browser.

According to the project's Russian technical documentation:

- A derived public alias is sent instead of the raw `deviceId`.
- The server uses a token derived from room URL and language rather than a plaintext room URL.
- Message deletion uses a derived verification key.
- Rate-limiting uses a daily hash based on IP.
- Shared-server messages are retained for **30 days**.

These are implementation descriptions from the project documentation, **not an independent security audit**. Public room messages are not end-to-end encrypted private chats.

## Optional server deployment

The repository includes two server implementations:

| Option | Files | Storage |
|---|---|---|
| Cloudflare Worker + D1 | `server/cloudflare/worker.js`, `server/cloudflare/schema.sql` | D1 / SQLite |
| Supabase Edge Function | `server/supabase/function_orbita.ts`, `server/supabase/schema.sql` | PostgreSQL |

The documented API routes are `/api/health`, `/api/presence`, `/api/pull`, `/api/push`, `/api/patch` and `/api/delete`. The default build uses the shared Cloudflare Worker endpoint. Changing the server requires changing the extension build.

For the full deployment procedure, complete implementation checklist and feature-status notes, refer to the [Russian source documentation](FEATURES.ru.md).

## Downloads

- [Latest release](https://github.com/MeLord2024/Orbita/releases/latest)
- [Repository](https://github.com/MeLord2024/Orbita)
- [Russian main page](../README.ru.md)
