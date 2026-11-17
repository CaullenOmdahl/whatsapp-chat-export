# Chrome Web Store listing — Chat Export for WhatsApp

Copy-paste material for the Chrome Web Store developer dashboard. Keep every field within the
store's limits; the character counts below are for the copy as written.

---

## Item name

**Chat Export for WhatsApp**

- 24 characters (limit: 45).
- Uses "for" to make clear this is a third-party tool, not the official WhatsApp app.

## Short description

**Export WhatsApp Web chats to HTML, TXT, JSON or CSV — with optional media. 100% local, no uploads.**

- 98 characters (limit: 132).

## Detailed description

```text
Save any WhatsApp Web conversation before it is gone.

Chat Export for WhatsApp adds the export button WhatsApp Web never had. Open a chat, click the
toolbar icon, choose a format, and get a complete, readable copy of the conversation as a local
file — no account, no server, no uploads.

FOUR FORMATS
• HTML — a styled page that opens in any browser; with media download, the report and files
  ship together in one .zip.
• TXT — WhatsApp-style plain text: [date, time] Sender: message.
• JSON — one structured object per message, ready for scripts and analysis.
• CSV — one row per message, opens cleanly in Excel or Google Sheets.

FULL HISTORY, NOT JUST WHAT'S ON SCREEN
WhatsApp Web only keeps a window of messages in the page. When you start an export, the
extension scrolls up through the chat by itself, loading older messages as it goes, then builds
the report from everything it captured.

YOUR OPTIONS
• Date range: all time, last 7, 30 or 90 days, or a custom start–end range.
• Media: skip it, leave a placeholder showing where each item was, or download the capturable
  media. Media exports come as one .zip holding the report and the files it references.
• Include system messages (joins, leaves, notices) if you want the full record.
• Include or exclude reactions.
• Show or hide sender names.

BUILT TO STAY OUT OF YOUR WAY
• Live progress with a Cancel button.
• Close the popup — the export keeps running, and the progress bar is restored when you reopen it.
• Recent export history for the last five exports.
• A diagnostics panel shows which page selectors matched, so you can tell when WhatsApp changes
  its UI and the extension needs an update.

PRIVATE BY DESIGN
This extension is 100% local. No network requests, no telemetry, no account, no server, no
cookies, no third-party services. Your conversations are read inside your own browser tab and
written to a file on your own computer. Chat data never leaves the browser. Your settings and a
short local export history are the only things stored, in Chrome's local extension storage.

BE HONEST ABOUT MEDIA
WhatsApp Web loads media lazily. Media that WhatsApp has already rendered in the page can be
saved. Media it has never loaded — items you never scrolled past or opened — cannot be captured;
those items are clearly marked as missing in the export rather than silently dropped.

GOOD TO KNOW
• Works on web.whatsapp.com in Chrome 102+ (and current Edge, Brave or Arc).
• WhatsApp Desktop and mobile apps are not supported.
• Requires a logged-in WhatsApp Web session.
• Very long chats are limited by how much history WhatsApp Web is willing to load.

OPEN SOURCE
MIT licensed. Not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta.
"WhatsApp" is used only to describe compatibility.
```

Approximate length: 2,750 characters (limit: 16,000).

## Single-purpose statement

```text
Chat Export for WhatsApp has one purpose: to export the conversation currently open in WhatsApp
Web into a local HTML, TXT, JSON or CSV file, optionally bundling the report and downloadable
media into a single .zip. It does not modify WhatsApp, send messages, manage contacts, or collect
browsing data, and it runs only on web.whatsapp.com.
```

## Category and listing metadata

| Field | Suggested value |
| --- | --- |
| Category | Productivity → Tools (alternatively "Social & Communication") |
| Language | English |
| Chrome Web Store visibility | Public |
| Region | All regions |
| Homepage URL | Repository URL |
| Support URL | Repository issue tracker |
| Privacy policy URL | Published `PRIVACY.md` (replace `<owner>` and `<repo>`) |

## Privacy practices answers

| Dashboard question | Answer |
| --- | --- |
| Does the item use remote code? | **No.** All JavaScript ships inside the package. |
| Does it collect or use personal/sensitive user data? | **No.** Nothing is collected, transmitted or sold. |
| Does it use cookies? | **No.** |
| Does it use authentication information? | **No.** It relies on the existing WhatsApp Web page; it never reads or stores credentials. |
| Does it disclose data to third parties? | **No.** There are no third parties and no network requests. |
| Certify data usage compliance | Yes — the extension does not collect data, so it complies by design. |

## Permission justifications

The store asks for a justification for each requested permission. Use these verbatim.

### `storage`

> Required to remember the user's export options (format, date range, media handling and the
> include/exclude toggles) between uses, to keep a local list of the last five exports for the
> history panel, and to mirror live export progress into session storage so that progress is
> restored if the popup is closed and reopened. All values stay in `chrome.storage` on the user's
> device; nothing is synced or transmitted.

### `scripting`

> Required to inject the extension's own bundled content script into the active WhatsApp Web tab
> when the user starts an export from the popup, including on tabs that were already open before
> the extension was installed or updated. It injects only the packaged `src/content/*` files, only
> into `https://web.whatsapp.com/*`, and only in response to a user action.

### `activeTab`

> Required to identify and act on the tab the user is currently viewing when they click the
> extension icon, so the export is applied to the intended WhatsApp Web conversation without
> requesting broad access to browsing history or all tabs.

### Host permission — `https://web.whatsapp.com/*`

> Required to read the conversation displayed on WhatsApp Web (message rows, sender names,
> timestamps, media previews) and to scroll the message list in order to load older history. This
> is the only site the extension runs on. The content is processed locally to build the export
> file; it is never transmitted anywhere.

## Graphics

All artwork is generated from the real popup UI by `npm run store-shots` and committed under
[`docs/store/`](store/). Regenerate after any UI change (`npm run screenshots && npm run store-shots`).
Everything is opaque RGB PNG, which is what the store requires.

| Asset | File | Size | Used for |
| --- | --- | --- | --- |
| Screenshot 1 | [`screenshot-1-export.png`](store/screenshot-1-export.png) | 1280×800 | Store listing, first position |
| Screenshot 2 | [`screenshot-2-formats.png`](store/screenshot-2-formats.png) | 1280×800 | Store listing |
| Screenshot 3 | [`screenshot-3-media.png`](store/screenshot-3-media.png) | 1280×800 | Store listing |
| Screenshot 4 | [`screenshot-4-progress.png`](store/screenshot-4-progress.png) | 1280×800 | Store listing |
| Screenshot 5 | [`screenshot-5-privacy.png`](store/screenshot-5-privacy.png) | 1280×800 | Store listing |
| Small promo tile | [`promo-tile-440x280.png`](store/promo-tile-440x280.png) | 440×280 | Optional tile on the store home page |
| Marquee | [`marquee-1400x560.png`](store/marquee-1400x560.png) | 1400×560 | Optional marquee slot |
| Store icon | [`../icons/icon128.png`](../icons/icon128.png) | 128×128 | Required listing icon |

Upload the five screenshots in numeric order. Captions (140 characters max, shown under each
screenshot):

1. **Export any WhatsApp chat in one click.** — pick a format, press export, get a file. No setup, no account.
2. **Four formats, one conversation.** — styled HTML, plain text, structured JSON and spreadsheet-ready CSV.
3. **Media comes along.** — photos, video, voice notes and documents bundled into one .zip with the report.
4. **Long chats, visible progress.** — watch the history load, cancel anytime; the export keeps running if you close the popup.
5. **Nothing leaves your browser.** — no network calls, no telemetry, and a diagnostics panel for when WhatsApp changes its page.

Screenshot rules: never show real personal data (the generated frames use the fixture conversation
"Design Team"), no device frames or browser chrome that imply an affiliation, no text smaller than
~14 px at 1280×800.

## Store review notes

- The extension requires an existing WhatsApp Web login; reviewers can create a test WhatsApp
  account and log in at <https://web.whatsapp.com>.
- No network permissions are requested, so nothing can be uploaded; local-only processing is the
  core design constraint.
- The extension does not automate WhatsApp actions (no sending, no deleting). It only reads the
  rendered conversation after the user asks for an export.

## Trademark and disclaimer (also shown in the listing footer)

> Chat Export for WhatsApp is not affiliated with, endorsed by, or sponsored by WhatsApp LLC or
> Meta. "WhatsApp" is a trademark of Meta Platforms, Inc. and is used only to describe
> compatibility with WhatsApp Web.

See [PRIVACY.md](../PRIVACY.md) for the policy text to publish, and [README.md](../README.md) for
installation and usage instructions.
