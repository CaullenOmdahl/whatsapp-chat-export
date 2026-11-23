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
The extension reads the open chat from WhatsApp Web's own message store, so it gets exact times,
senders, full text, captions, quoted messages and reactions. When you start an export, it asks
WhatsApp to load older messages, as far back as WhatsApp Web itself can load or your chosen date
range goes. If WhatsApp's internals cannot be reached, it falls back to scrolling and reading the
page, and tells you so in a warning.

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
Nothing is uploaded anywhere: no telemetry, no analytics, no account, no server, no cookies, no
third-party services. The extension's own code makes no network requests. Your conversations are
read inside your own browser tab and written to a file on your own computer. Your settings and a
short local export history are the only things stored, in Chrome's local extension storage.

BE HONEST ABOUT MEDIA
When Media is set to Download, every photo, video, voice note, sticker and document in the
exported range is downloaded by WhatsApp's own download manager from WhatsApp's media servers,
the same way WhatsApp does when you open a photo, including media you never opened. Nothing is
sent to anyone else. Media WhatsApp can no longer download (for example, expired on its servers)
is clearly marked as not loaded in the export rather than silently dropped. With Placeholders or
None, no media is downloaded.

GOOD TO KNOW
• Works on web.whatsapp.com in Chrome 111+ (and current Edge, Brave or Arc).
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
| Does it disclose data to third parties? | **No.** There are no third parties: nothing is sent to the developer or anyone else. The only network activity is WhatsApp's own media download, at the user's request. |
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

> Required to inject the extension's own bundled content script, and its page-world bridge that
> reads WhatsApp Web's message store, into the active WhatsApp Web tab when the user starts an
> export from the popup, including on tabs that were already open before the extension was
> installed or updated. It injects only packaged files (`src/content/*`, `src/page/bridge.js`),
> only into `https://web.whatsapp.com/*`, and only in response to a user action.

### `activeTab`

> Required to identify and act on the tab the user is currently viewing when they click the
> extension icon, so the export is applied to the intended WhatsApp Web conversation without
> requesting broad access to browsing history or all tabs.

### Host permission — `https://web.whatsapp.com/*`

> Required to read the conversation displayed on WhatsApp Web (message rows, sender names,
> timestamps, media previews), to ask WhatsApp to load older history (or scroll the message list),
> and to have WhatsApp's own download manager fetch media when the user chooses to download it.
> This is the only site the extension runs on. The content is processed locally to build the
> export file; the extension never transmits it anywhere.

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
5. **Nothing is uploaded.** — no telemetry, no analytics, and a diagnostics panel for when WhatsApp changes its page.

Screenshot rules: never show real personal data (the generated frames use the fixture conversation
"Design Team"), no device frames or browser chrome that imply an affiliation, no text smaller than
~14 px at 1280×800.

## Store review notes

- The extension requires an existing WhatsApp Web login; reviewers can create a test WhatsApp
  account and log in at <https://web.whatsapp.com>.
- The extension's own code makes no network requests and nothing is uploaded; processing is local.
  With Media set to Download, WhatsApp's own code downloads media from WhatsApp's servers at the
  extension's request. The extension needs Chrome 111+ (page-world content script).
- The extension does not automate WhatsApp actions (no sending, no deleting). It only reads the
  rendered conversation after the user asks for an export.

## Trademark and disclaimer (also shown in the listing footer)

> Chat Export for WhatsApp is not affiliated with, endorsed by, or sponsored by WhatsApp LLC or
> Meta. "WhatsApp" is a trademark of Meta Platforms, Inc. and is used only to describe
> compatibility with WhatsApp Web.

See [PRIVACY.md](../PRIVACY.md) for the policy text to publish, and [README.md](../README.md) for
installation and usage instructions.
