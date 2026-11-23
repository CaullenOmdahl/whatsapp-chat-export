# Architecture — Chat Export for WhatsApp

This document explains how the extension works end to end, for contributors and for anyone
auditing what it does with their data. The authoritative technical contract is
[PROTOCOL.md](PROTOCOL.md); this file is the narrative version.

## Design constraints

1. **Local only.** The extension's own code makes no network requests, runs no remote code and has
   no account. Chat content is read from the page and WhatsApp's in-memory store, assembled in
   memory and written to a local file. Nothing is uploaded; the only network activity is WhatsApp's
   own download manager fetching media from WhatsApp's servers at the extension's request, and only
   when media handling is *Download*.
2. **Fail soft.** WhatsApp Web is a moving target. A selector that stops matching must produce a
   warning and a degraded export, never an exception that loses the whole run.
3. **No build step.** Classic scripts on a single `WAEx` global, loaded in dependency order by
   `manifest.json`. The popup loads the same libraries with plain `<script>` tags. This keeps the
   unpacked folder directly loadable and easy to audit.
4. **The popup is disposable.** The popup can be closed at any moment; the export lives in the
   WhatsApp tab and mirrors its progress to session storage.
5. **Minimal permissions.** `storage`, `scripting`, `activeTab`, and `https://web.whatsapp.com/*`.
   Chrome 111 or newer is required for the `"world": "MAIN"` content script.

## The three contexts

```text
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ TOOLBAR CLICK                                                                       │
│   Chrome opens the popup ──chrome.tabs.sendMessage──▶ content script                │
│   service worker (install/startup only): seeds storage, session access              │
│                                                                                     │
│ WHATSAPP WEB TAB (https://web.whatsapp.com)                                         │
│   WhatsApp page DOM                    content script (isolated world, WAEx)        │
│   ├─ #main conversation panel   ─────▶ extractor                                    │
│   ├─ div[data-id] message rows  ─────▶   │ parse · filter · dedupe                  │
│   └─ scroll container           ◀──────  │ scroll up to load history                │
│                                          ▼                                          │
│                                     format writers ──▶ Blob ──▶ object URL ──▶ file │
│                                          │                                          │
│                                          └──▶ chrome.storage.session (progress)     │
│                                                    │                                │
│   popup (reopened) ◀────────────────────────────────┘ restores live progress        │
│                                                                                     │
│ chrome.storage.local: settings + last 5 exports      ~/Downloads/report.*           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

| Context | Entry point | Responsibility |
| --- | --- | --- |
| **Service worker** | `src/background/service-worker.js` | Runs in the background: seeds default settings and an empty history on install/startup, grants content scripts read access to session storage, and prunes stale export state. It never sees chat data. |
| **Popup** | `src/popup/popup.html` + `popup.js` | Settings UI, status/progress display, history list, diagnostics panel. Sends commands to the content script. It never scrapes the page itself. |
| **Content script** | `src/content/content.js` (with `extractor.js`, `media.js`) | Runs inside `web.whatsapp.com`. Scrapes the open conversation, builds the file, triggers the download, reports progress. |

`src/lib/*` is shared: `namespace.js` (constants, defaults), `datetime.js` (timestamp parsing),
`zip.js` (a small dependency-free ZIP writer), `formats.js` (HTML/TXT/JSON/CSV serialisers).

## Export flow

1. **The user opens the popup on a WhatsApp Web tab.** The popup asks the content script for a
   health check (`WAX:PING`). The reply includes the detected chat name, whether a chat is open,
   the number of currently rendered message rows and any in-flight export state.
2. **The user picks settings and clicks Export chat.** The popup normalises the settings against
   `WAEx.DEFAULT_SETTINGS`, saves them to `chrome.storage.local`, and sends `WAX:EXPORT`.
3. **The content script acknowledges immediately** and begins loading history. By default this
   goes through the page bridge (see [Page bridge and message store](#page-bridge-and-message-store));
   steps 4 and 5 below describe the screen-reading fallback used when the bridge cannot reach
   WhatsApp's internals. Progress arrives
   in the popup as `WAX:PROGRESS` broadcasts, and is mirrored to `chrome.storage.session` under
   `wax:state`.
4. **Scroll phase, two passes (fallback).** The extractor first walks **backwards**: repeatedly scrolling the
   message-list container to the top and waiting for the previous page to render. WhatsApp loads
   older pages on scroll, so each round gains a chunk. Newly seen rows are parsed **immediately**
   and stored in an id → message map, which keeps them even if WhatsApp removes their nodes later
   and makes the progress count exact. If the conversation was not already showing its newest
   message when the export started — WhatsApp restores the last scroll position, which may be the
   first message — a second pass steps **forwards** a viewport at a time until the newest message
   is reached, loading each appended page. Without that pass a chat scrolled to its start would
   export only the opening page.

   Two scroll strategies are used: a jump to the very top (fast, triggers a page load), and — when
   a jump stops producing new messages — viewport-sized steps, which is what a human scroll looks
   like and covers builds that only load on real scroll gestures. A round is considered "grew" when
   the number of message nodes or the scroll height increases; otherwise the loop waits while the
   list is still mutating. It stops when:
   - no new messages arrive in the direction being walked across repeated attempts,
   - the oldest message seen is older than the selected date cutoff,
   - a safety cap is hit (**4000** scroll rounds, a **10-minute** time budget or **150,000**
     messages), which produces a warning, or
   - the user presses Cancel.
5. **Parse phase (fallback).** The parsed map from the scroll phase is the primary source. A final DOM pass
   adds system notices and anything rendered after the last harvest, then the two are merged by
   `data-id`, timestamps are backfilled for untimed system rows, and the list is sorted. For each
   message the extractor reads the message text and metadata,
   determines the message type, parses the timestamp, picks up sender name, quoted message and
   reactions, resolves media descriptors, and then applies the options: system-message filter,
   date-range filter and reaction handling.
6. **Media phase** (only when media handling is *Download*). On the store path, each media item in
   the exported range is downloaded and decrypted by WhatsApp's own download manager through the
   page bridge and added to the in-memory ZIP under `media/`, subject to the media cap. In
   fallback mode, items are read from the page's already-loaded `blob:`/`data:` URLs. Items that
   cannot be fetched are flagged `missing`.
7. **Build and save.** The format writer serialises the message array. For HTML, captured media is
   referenced by its `media/…` path inside the archive. The content script creates a `Blob`, fires a
   local download via an anchor and object URL, and sends `WAX:RESULT` with the filename, byte size,
   message count and warnings. When at least one media file was captured, the report is added to the
   ZIP as well, and the single resulting archive is the download. The popup adds an entry to the
   five-item history.
8. **Cleanup.** The temporary object URL is revoked, the chat's original scroll position is
   restored, and the export state is settled. Cancelling or failing ends the same way, with an
   error/result record instead of a file.

## Page bridge and message store

The rendered page is a poor source of truth: it virtualises messages into empty placeholders, splits
long text across several nodes and dropped the direction classes used to tell your messages from
others'. So the primary path reads WhatsApp's own in-memory message store instead.

- `src/page/bridge.js` runs in WhatsApp Web's own page JavaScript world (a manifest content script
  with `"world": "MAIN"`, which is why Chrome 111+ is required; `scripting` injects it into an
  already-open tab). It reads the open chat with `require('WAWebCollections').Chat.getActive()` and
  its `chat.msgs`, and returns every loaded message as structured data: exact time, sender, whether
  you sent it, type, full text, caption, quoted message, reactions, each album photo as its own
  message, deleted messages and calls. No scrolling is needed for that. It is read-only and never
  sends, edits, deletes or marks messages.
- `src/content/page-bridge.js` (isolated world) talks to it over `window.postMessage`. Requests are
  `ping`, `state`, `loadEarlier`, `messages` and `media`. When the bridge starts it sets a
  `data-wax-bridge` attribute on `<html>`, so the content script can detect it without waiting for a
  timeout.
- `src/content/internal.js` normalises the bridge's data into the shared message model and drives
  loading.

**Older history** is requested with WhatsApp's own loader (`WAWebChatLoadMessages`). If that function
is not found, the message list is scrolled to the top instead. Loading continues until WhatsApp
reports no earlier messages, the start of the chosen date range is reached, or a limit or stall is
hit. It is still limited to what WhatsApp Web itself can load (it may offer to load older messages
from the phone).

**Media** (Download mode) is fetched by `WAWebDownloadManager`, which downloads and decrypts each
item from WhatsApp's media servers, the same as when you open a photo. Media WhatsApp can no longer
download is marked as not loaded, with one warning per kind.

**Fallback.** WhatsApp renames its internals between releases. If they cannot be reached, the export
falls back to the screen-reading method described below (`src/content/extractor.js`) and says so in
a warning. That method is slower and can miss messages and media.

To find new internal names after a WhatsApp update, paste
[`scripts/wa-internals-probe.js`](../scripts/wa-internals-probe.js) into DevTools on the WhatsApp
tab. It is read-only; it saves `wa-internals-<time>.json` to Downloads containing only names, types,
booleans and counts, no message content. [`scripts/wa-probe.js`](../scripts/wa-probe.js) does the
same for the rendered page structure.

## Scraping strategy (fallback)

WhatsApp Web is a React app with generated class names, so the extension deliberately avoids
depending on hashed classes. It looks for **stable structural hooks**, in a fallback chain per
element:

| Target | Primary hook | Fallbacks |
| --- | --- | --- |
| Conversation panel | `#main` | `[data-testid="conversation-panel-wrapper"]`, `div[role="main"]`, a structural `#app` path |
| Message rows | `div[role="row"]` | message nodes carrying `data-id` |
| Message nodes | `div[data-id]` (the stable per-message id) | nested `[data-id]` inside a row |
| Chat title | `header [data-testid="conversation-info-header-chat-title"]` | `header span[dir="auto"][title]`, `header span[title]`, `header h1` |
| Message text | `.selectable-text` | `.copyable-text`, then whole-row text |
| Timestamp + author | `data-pre-plain-text` on the row | `<time>`/`title` attributes, then metadata text |
| Quoted reply | `[data-testid="quoted-message"]` | `.quoted-mention`, localized `aria-label` matches |
| Reactions | reaction chips inside the bubble | accessible labels |
| Media | `img`, `video`, `audio`, anchors with `blob:`/`data:` URLs | preview elements with type hints |

The conversation's scroll container is not selected by a fixed selector at all. It is found by
walking up from a message row and taking the outermost ancestor whose content overflows and which
actually scrolls — with a fallback search inside the panel. Two details matter in practice:

- Computed `overflow` is **not** required to be `auto`/`scroll`. WhatsApp sometimes hides the
  scrollbar (`overflow: hidden`) while still letting the list scroll programmatically; requiring a
  visible scrollbar made the extension miss the container and export only the messages on screen
  (fixed in 1.0.1).
- Ambiguous containers are verified with a tiny `scrollTop` probe. Containers that already declare
  themselves scrollable are not probed, because probing would make WhatsApp load a page of history
  before the export begins.

When a selector matches nothing, the lookup records a warning and tries the next candidate. The
diagnostics report (`WAX:DIAGNOSE`) exposes, for every named selector, the CSS selector text and
the number of matches, plus counts for the panel, list, scroll container, rendered rows and parsed
messages. That is the early-warning system for a WhatsApp redesign: a single selector dropping to
zero matches, or `renderedRows > 0` with `parsedMessages == 0`, points straight at the broken step.

### Why `data-id`

Each rendered message carries a `data-id` that is unique and stable for that message, so it is the
identity used everywhere: de-duplication, the render count, and the scroll loop's "did anything new
appear?" check. Older WhatsApp builds used ids like `true_…`/`false_…`, which also encoded the
message direction; current builds (seen November 2026) use one opaque token, so any non-empty
`data-id` inside a message row counts. Current builds also dropped the `.message-out` /
`.message-in` classes, so direction comes from the first signal available: those classes, the
bubble tail (`data-testid="tail-out"`, first bubble of a run only), delivery ticks, then which side
of the list the bubble sits on. In a one-to-one chat with none of these, the author who is not the
contact is taken to be the user, with a warning. Raw `div[data-id]`
nodes are de-duplicated by id and nested wrappers collapse to one, because WhatsApp can nest or
re-render them.

Messages are parsed as they appear rather than at the end, so a message whose node is removed
later still reaches the export. The final DOM pass only adds notices and anything the loop did
not see.

WhatsApp (as of November 2026) keeps messages away from the viewport as empty placeholders: the
`data-id` node with no timestamp attribute, text or media. A placeholder is never collected;
it stays pending and is parsed again once WhatsApp fills it in. That is why loading always ends
with a downward sweep from the oldest loaded message, a viewport at a time, waiting up to
`hydrateTimeoutMs` per step for on-screen placeholders to fill in. Placeholders that never fill
in are counted in a warning. A message with no timestamp of its own borrows the one of the
message above it on the page.

### Timestamps

`data-pre-plain-text` is the most reliable source because it contains the formatted date and time
of the message (and, in groups, the sender). `datetime.js` parses the common locale formats and
falls back to the row's `<time>`/`title` attributes and then to the current day. Timestamps are
stored as epoch milliseconds plus a `YYYY-MM-DD` date key. If a timestamp cannot be recovered, the
message is kept with a best-effort value and a warning; it is never dropped silently.

## Data model

Every format is generated from the same `Message[]` array (see the TypeScript shapes in
[PROTOCOL.md](PROTOCOL.md)):

- `id`, `timestamp`, `dateKey`, `timeText`
- `author`, `isOutgoing`
- `type` — text, image, video, audio, voice, document, sticker, gif, contact, location, poll,
  link, deleted, system, unknown
- `text`, `quoted`, `reactions`, `media` (`{ kind, fileName, mime, bytes, missing, zipPath }`)

Format writers are pure functions from that array to a string. This keeps the formats consistent
and unit-testable without a browser.

## Media handling

In **Download** mode on the store path, the media phase:

1. collects every photo, video, voice note, sticker and document in the exported range,
2. asks the page bridge to download each one through WhatsApp's own download manager
   (`WAWebDownloadManager`), which fetches and decrypts it from WhatsApp's servers; the bytes come
   back to the content script over `postMessage`,
3. derives a file name and MIME type, adds the bytes to the ZIP under `media/`,
4. records `zipPath` for the report, or `missing: true` when WhatsApp can no longer download it,
5. stops downloading once `maxMediaMb` is reached, marking the remainder as missing.

Media that is unavailable (for example expired on WhatsApp's servers) is exported as an explicit
"missing" placeholder with one warning per kind. The extension does not guess or reconstruct it.

In **fallback** mode the extension can only capture what the page has already turned into a
blob/data URL, so items never rendered on screen are marked missing. With *Placeholders* or *None*
no media is downloaded.

The ZIP writer (`src/lib/zip.js`) is dependency-free and uses the STORE method for media (which is
already compressed) and DEFLATE for the report text when the browser exposes `CompressionStream`.
Because the report references media by relative `media/…` paths, it is placed inside the archive
at the root: the archive is the single download, named after the chat and date. If no media was
captured, the report is downloaded on its own instead.

## Storage

| Key | Area | Contents |
| --- | --- | --- |
| `wax:settings` | `chrome.storage.local` | The normalised settings object (format, date range, media mode, toggles, cap). |
| `wax:history` | `chrome.storage.local` | Last five export summaries: chat name, format, timestamp, message count, byte size, filename. |
| `wax:state` | `chrome.storage.session` | Live/most-recent export state: phase, loaded, total, detail, percent, timestamps, result or error. |

Session storage is what makes "close the popup, reopen it, progress is still there" work. It is
in-memory and dies with the browser session. Local storage holds only settings and small history
metadata — never message content.

## Security and privacy properties

- **No network requests from the extension's code.** The only `fetch` calls operate on `blob:`/`data:`
  URLs; no `XMLHttpRequest`, no `WebSocket`, no remote URL, no remote script, no analytics. Lint
  enforces this. Media downloads go only through WhatsApp's own download manager via the page
  bridge, and nothing is ever sent anywhere else.
- **The page bridge is read-only.** It runs in WhatsApp's page world, so it only reads the message
  store and never sends, edits, deletes or marks messages.
- **User content never touches `innerHTML`.** Format writers escape text (`&`, `<`, `>`, quotes,
  newlines as appropriate) and the HTML writer emits markup around escaped text; DOM APIs use
  `textContent`. This blocks a message containing HTML from executing in the exported report or the
  extension's own UI.
- **CSV is UTF-8 with a BOM** and RFC 4180 quoting, so Excel and Sheets open it correctly.
- **Least privilege.** Only the four declared permissions; the content script only matches
  `https://web.whatsapp.com/*`.
- **No remote code.** Everything is packaged. (Downloading media needs WhatsApp's own connection to
  its servers.)

## Failure modes

| Failure | Behaviour |
| --- | --- |
| No WhatsApp tab / no chat open | Popup shows a clear prompt; no export starts (`NO_CONVERSATION`). |
| No messages matched the filters | Export ends with `NO_MESSAGES` and suggests widening the date range or loading more history. |
| An export is already running | Second request is refused with `ALREADY_RUNNING`; the popup keeps showing the live one. |
| Selector no longer matches | Warning recorded, fallback tried; export continues with whatever is available. |
| Media unavailable | Item marked missing; one warning per kind surfaced in the summary. |
| WhatsApp internals not found | Falls back to screen reading, with a warning that the conversation was read from the screen. |
| Media cap reached | Remaining items marked missing; warning explains the cap. |
| User cancels | Scroll/parse/media loops stop at the next checkpoint; state becomes `cancelled`. |
| Popup closed mid-export | Content script continues; state mirrored to session storage; reopened popup restores it. |
| WhatsApp tab closed/reloaded | Content script is torn down; the export stops with `PAGE_RELOADED` and the popup reports the break. |

## Testing approach

The repo's `test/` suite runs on Node and targets the library code and the content pipeline,
where the interesting logic lives:

- `datetime.js` — timestamp parsing across formats and fallbacks.
- `namespace.js` — settings normalisation/defaults (exercised indirectly by the other suites).
- `formats.js` — each writer's shape, escaping and CSV quoting.
- `zip.js` — ZIP structure, local headers, central directory and CRC.
- `extractor.js` — the scraper run against a `jsdom` fixture that imitates WhatsApp's DOM:
  message rows, `data-id`, `data-pre-plain-text`, scrolling and date filtering.
- `content.js` end to end — the full content script against the fixture, with the generated
  download captured and validated on disk.

`test/fixture.mjs` builds the simulated conversation and day dividers; `test/harness.mjs` provides
the fake `chrome.*` surface, script loader and download capture. Live WhatsApp Web is still the
final acceptance check for selector health, with the diagnostics panel as the fast signal. There is
no browser automation dependency and no network in tests. `test/store.test.mjs` covers the store
path against a simulated bridge.

## Extending safely

When WhatsApp changes its DOM:

1. Run the diagnostics panel and note which selector has zero matches.
2. Add a new candidate to the front of that selector's fallback chain in the extractor rather than
   editing the old entry; keep old hooks for users on older WhatsApp builds.
3. Add or update a diagnostics selector entry so the next break is visible.
4. Bump the version and add a [CHANGELOG](../CHANGELOG.md) entry.

Never add a network call from the extension's own code, never interpolate message text into an HTML string, and never move
essential state into the popup. Those three rules are the whole security and reliability model.
