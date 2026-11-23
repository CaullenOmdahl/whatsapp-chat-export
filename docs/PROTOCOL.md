# Internal contract

Reference for anyone (or any agent) working on a part of the extension. Keep this file
in sync with `src/lib/namespace.js`, which is the source of truth for constants.

## Contexts

| Context | Files | Purpose |
| --- | --- | --- |
| Content script | `src/lib/*`, `src/content/*` | Runs inside `web.whatsapp.com`, scrapes the DOM, builds and saves the file. |
| Popup | `src/lib/namespace.js`, `src/lib/datetime.js`, `src/popup/*` | Settings UI, status display, triggers exports. |
| Service worker | `src/background/service-worker.js` | Opens the popup, seeds defaults, housekeeping. |

All library files are classic scripts (no ES modules) wrapped in an IIFE that attach to
`globalThis.WAEx`. The manifest lists them in dependency order. Popup pages load the
same files with `<script src>` before `popup.js`.

## Messaging: popup → content script

Send with `chrome.tabs.sendMessage(tabId, message)`; content replies through
`sendResponse` **and** broadcasts progress with `chrome.runtime.sendMessage`.

```js
// 1. Health check + chat snapshot. Replies through sendResponse; there is no
//    separate PONG broadcast. `state` is null when nothing is in flight and the
//    last finished export is older than 120s, so a stale success panel is not
//    resurrected on reopen. `scan` is optional and currently just documents the
//    popup's Refresh intent (the chat snapshot is always read live).
{ type: 'WAX:PING' }               // or { type: 'WAX:PING', scan: true }
// -> { ok: true, chat: ChatInfo, state: ExportState | null,
//      running: boolean, version: '1.0.0' }

// 2. Start an export. Replies immediately with { accepted: true }; all real
//    progress arrives as WAX:PROGRESS broadcasts and ends with WAX:RESULT.
{ type: 'WAX:EXPORT', settings: Settings }
// -> { accepted: true } | { accepted: false, error: { code, message, hint } }

// 3. Cancel the in-flight export.
{ type: 'WAX:CANCEL' }             // -> { ok: true, cancelling: boolean }

// 4. Ask for a selector-health report (diagnostics panel).
{ type: 'WAX:DIAGNOSE' }           // -> DiagnosticsReport (also broadcast below)

// 5. Same as PING, kept for callers that only want a snapshot.
{ type: 'WAX:SCAN' }               // -> same reply as PING
```

## Broadcasts: content script → popup

```js
{ type: 'WAX:PROGRESS', phase, loaded, total, detail, percent, startedAt }
{ type: 'WAX:RESULT',  ok: true,  filename, bytes, messageCount, format, zipped,
                        mediaCaptured, mediaMissing, warnings, chatName, isGroup,
                        dateRange, historyEntry }
{ type: 'WAX:RESULT',  ok: false, error: { code, message, hint }, warnings }
{ type: 'WAX:DIAGNOSTICS', report }
```

Ordering guarantees:

- `WAX:PROGRESS` is only emitted while working, plus one **terminal snapshot**
  (`phase: 'done' | 'error' | 'cancelled'`) immediately before the matching
  `WAX:RESULT`. Panels should let `WAX:RESULT` drive the terminal view and ignore the
  terminal progress snapshot, or treat both identically — either works.
- Cancelling ends as `WAX:RESULT` with `ok: false` and `error.code: 'CANCELLED'`;
  nothing is downloaded and the scroll position is restored.
- `phase: 'idle'` is never broadcast.

Error codes you must handle: `NO_CONVERSATION`, `NO_MESSAGES`, `ALREADY_RUNNING`,
`CANCELLED`, `PAGE_RELOADED`, `EXPORT_FAILED`.

The content script also mirrors the latest progress / result into
`chrome.storage.session` (key `wax:state`) so the popup can restore status after being
closed and reopened mid-export. The service worker raises the session storage access
level so content scripts may write it; the popup should still prefer the value from
the PING reply, which is authoritative.

## Media packaging

`mediaMode: 'download'` produces a single `.zip` containing the report at the archive
root plus one `media/NNNN-name.ext` file per captured item, and the report references
them by that relative path. Captured items get `media.zipPath`; items WhatsApp never
rendered stay `missing: true` and are labelled as such.

## Data shapes

```ts
type Settings = {
  version: 1;
  format: 'html' | 'txt' | 'json' | 'csv';
  dateRange: 'all' | '7d' | '30d' | '90d' | 'custom';
  customStart: string;            // 'YYYY-MM-DD' or ''
  customEnd: string;              // 'YYYY-MM-DD' or ''
  mediaMode: 'skip' | 'link' | 'download';
  includeSystem: boolean;
  includeReactions: boolean;
  senderLabels: boolean;
  maxMediaMb: number;
  restoreScroll: boolean;
};

type ChatInfo = {
  name: string;                   // contact or group name, '' when unknown
  isGroup: boolean;
  initials: string;               // 1-2 chars for the avatar
  renderedCount: number;          // unique message ids currently in the DOM
  dateRange: { start: number, end: number } | null;  // epoch ms
  found: boolean;                 // false when no chat is open
  reason?: string;                // why it was not found
};

type Message = {
  id: string;
  timestamp: number;              // epoch ms (best effort, see datetime.js)
  dateKey: string;                // 'YYYY-MM-DD'
  timeText: string;               // display time as WhatsApp rendered it
  author: string;
  isOutgoing: boolean;
  type: 'text'|'image'|'video'|'audio'|'voice'|'document'|'sticker'|'gif'
      | 'contact'|'location'|'poll'|'link'|'deleted'|'system'|'unknown';
  text: string;
  quoted: { author: string, text: string } | null;
  reactions: { emoji: string, count: number }[];
  media: {
    kind: string;
    fileName: string;
    mime: string;
    bytes: number;
    missing: boolean;             // item was rendered but not downloadable
    zipPath: string;              // set once captured, e.g. 'media/0001-image.jpg'
  } | null;
};

type ExportState = {
  phase: 'idle'|'scrolling'|'parsing'|'media'|'building'|'saving'|'done'|'cancelled'|'error';
  loaded: number;
  total: number | null;
  detail: string;
  percent: number | null;         // 0-100, null when indeterminate
  startedAt: number;
  finishedAt: number | null;
  filename?: string;
  bytes?: number;
  messageCount?: number;
  warnings?: string[];
  error?: { code: string, message: string, hint: string };
};

type DiagnosticsReport = {
  url: string;
  version: string;
  userAgent: string;
  mainPanel: boolean;
  messageList: boolean;
  scrollContainer: boolean;
  renderedRows: number;
  renderedMessages: number;       // unique message ids in the DOM
  parsedMessages: number;
  scroll: {
    found: boolean;               // scroll container detected
    scrollable: boolean;          // content overflows it right now
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  };
  chat: ChatInfo;                 // same shape as the PING reply
  selectors: {
    name: string;
    selector: string;             // the first selector from the fallback chain
    matches: number;              // how many nodes the chain matched
    alternatives: number;         // how many selectors the chain tries
  }[];
  warnings: string[];
};
```

`_internal` helpers on each module are not part of the contract; do not depend on them
from the popup, and never ship UI that calls them.

## Rules

- **No network requests from the extension's code.** The extension never transmits chat
  data. Everything stays in the tab and in local storage. Media is downloaded only by
  WhatsApp's own download manager via the page bridge. Do not add analytics, telemetry or
  remote code.
- **No `innerHTML` with message text.** User content is always written through
  `textContent` / DOM nodes, never interpolated into HTML strings.
- **Permissions stay minimal.** `storage`, `scripting`, `activeTab` only, plus the
  `https://web.whatsapp.com/*` host.
- **Fail soft.** Every selector lookup gets a fallback chain; a missing element yields a
  warning, never an exception that kills the export.
- **The popup must be usable while closed.** Never keep essential state only in the
  popup; mirror it to `chrome.storage.session`.
