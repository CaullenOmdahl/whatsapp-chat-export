# Chat Export for WhatsApp

[![CI](https://github.com/CaullenOmdahl/whatsapp-chat-export/actions/workflows/ci.yml/badge.svg)](https://github.com/CaullenOmdahl/whatsapp-chat-export/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-00a884.svg)](LICENSE)
[![No network](https://img.shields.io/badge/network-none-00a884.svg)](#privacy)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-00a884.svg)](manifest.json)

**Save any WhatsApp Web conversation as a self-contained HTML transcript, plain text, structured JSON, or a spreadsheet-ready CSV — locally, in one click.**

> **Why this exists:** WhatsApp lets you "export chat" on your phone, but on WhatsApp Web there is no save button. This extension adds one, and it never sends your messages anywhere.

> **Not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta.** "WhatsApp" is used only to describe compatibility with WhatsApp Web.

---

## Contents

- [Status](#status)
- [Features](#features)
- [Install](#install)
- [Usage](#usage)
- [What the four formats look like](#what-the-four-formats-look-like)
- [How it works](#how-it-works)
- [Options reference](#options-reference)
- [FAQ](#faq)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing, security and support](#contributing-security-and-support)
- [Privacy](#privacy)
- [License](#license)

---

## Status

**1.0.0 — pre-release, being tested.** Load it unpacked and try it against your own chats; the
Chrome Web Store listing is being prepared. See [CHANGELOG.md](CHANGELOG.md) for what shipped and
[docs/RELEASING.md](docs/RELEASING.md) for the release and store checklist. Bug reports are welcome
via the issue templates.

---

## Features

| Format | Best for | What you get |
| --- | --- | --- |
| **HTML** | Reading and archiving | A styled page that opens in any browser; CSS inline, no JavaScript. With media download, the report and its files ship together in one `.zip`. |
| **TXT** | Portability and search | WhatsApp-style plain text (`[date, time] Sender: message`), readable in any editor. |
| **JSON** | Scripts and analysis | One message per object with ids, timestamps, authors, types, text, quotes, reactions and media metadata. |
| **CSV** | Excel and Google Sheets | One row per message; quoted for commas, quotes and newlines. |

Plus:

- **One-click export** of the conversation that is currently open. The extension scrolls up through the chat by itself to load history as it goes.
- **Loads older history** instead of only the handful of messages WhatsApp keeps on screen.
- **Date ranges:** all time, last 7 / 30 / 90 days, or a custom start–end range. Older messages are skipped and early scrolling stops once the cutoff is reached.
- **Media handling:** skip media, leave a placeholder letting you see where each item was, or download the capturable media. Media exports arrive as a single `.zip` containing the report and the files it references.
- **Include system messages** (joins, leaves, "Messages and calls are end-to-end encrypted", etc.) if you want them.
- **Include reactions**, and toggle **sender names** on or off.
- **Live progress with a Cancel button.** Closing the popup does not stop an export; reopen it and the live progress is restored.
- **Recent export history** for the last five exports.
- **Diagnostics panel** that shows which page selectors matched, so it is obvious when WhatsApp changes its UI and this extension needs an update.
- **100% local.** No account, no server, no telemetry, no network requests at all. See [PRIVACY.md](PRIVACY.md).

---

## Install

This build is installed from source (unpacked), not from a store listing. It takes about a minute.

### Option A — download a release (easiest)

1. Open the [Releases](https://github.com/CaullenOmdahl/whatsapp-chat-export/releases) page and download
   `whatsapp-chat-export-v*.zip` from the latest release.
2. Extract it. You should end up with a folder containing `manifest.json`.
3. Continue from step 2 under Option B.

### Option B — from source

```bash
git clone https://github.com/CaullenOmdahl/whatsapp-chat-export.git
cd whatsapp-chat-export
```

You should end up in a folder named `whatsapp-chat-export` that contains `manifest.json`.

1. Open **`chrome://extensions`** in Chrome (or `edge://extensions` in Edge, `brave://extensions` in
   Brave, `arc://extensions` in Arc).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the **`whatsapp-chat-export`** folder itself — the folder that contains `manifest.json`,
   not the folder above it.
5. Open **<https://web.whatsapp.com>** and log in by scanning the QR code with your phone.
6. Open the chat you want to export.
7. Click the extension's toolbar icon. Pin it first if you like (puzzle-piece icon → pin).
8. Choose a format and options, then click **Export chat**.
9. The finished file lands in your browser's **Downloads** folder. If you chose media download, you
   get a single `.zip` holding both the report and its media files.

To update, pull the new code (or download the newer release) and press the reload icon on the
extension's card in `chrome://extensions`. Reload any open WhatsApp Web tab afterwards.

> **Requirements:** Chrome 102+ or a Chromium browser with equivalent Manifest V3 support (current
> Edge, Brave or Arc), a working WhatsApp Web session, and the chat open in the active tab. There is
> no build step — the extension is plain, dependency-free JavaScript. Node.js is only needed to run
> the tests and build the release zip.

## Usage

1. Open <https://web.whatsapp.com> and open a chat or group.
2. Click the toolbar icon.
3. Pick a format, a date range, and how to handle media.
4. Click **Export chat**. Keep the tab open; the popup shows live progress. You can close the popup while it runs — the export continues and the progress bar is restored when you reopen it.
5. Watch for the completion summary (message count, file size, any warnings) and open the downloaded file.

Reports are named like `WhatsApp Chat with Alice - 2026-11-18.html`. With media download enabled, the archive is a single file, `WhatsApp Chat with Alice - 2026-11-18.zip`, containing the report at its root and the captured files under `media/`; the report references them by that relative path. Extract the archive to view the report with its media in place.

### What the four formats look like

Real files generated by the shipped writers live in [`docs/examples/`](docs/examples/): [HTML](docs/examples/example-chat.html), [TXT](docs/examples/example-chat.txt), [JSON](docs/examples/example-chat.json), [CSV](docs/examples/example-chat.csv). Open the HTML one in a browser to see exactly what an export looks like. Regenerate them with `npm run examples`.

The examples below use a short conversation between **Alice** and **Bob** and are abridged — the HTML has extra inline CSS, and the JSON has a `stats` block and two more messages.

**HTML** — a styled, self-contained transcript (styles inlined; no scripts, no external assets):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>WhatsApp Chat with Bob</title>
  <style>/* WhatsApp-like transcript styles, inlined */</style>
</head>
<body>
  <div class="wrap">
    <header class="top"><h1>Bob</h1><p>3 messages · 17 Nov 2026</p></header>
    <div class="day"><span>17 Nov 2026</span></div>
    <div class="msg in">
      <div class="bubble">
        <div class="author">Bob</div>
        <div class="text">Are we still on for tomorrow?</div>
        <div class="meta"><span>14:02</span></div>
      </div>
    </div>
    <div class="msg out">
      <div class="bubble">
        <div class="text">Yes — I'll bring the slides.</div>
        <div class="meta"><span>14:03</span></div>
      </div>
    </div>
  </div>
</body>
</html>
```

**TXT** — plain text with a header and a day divider, close to WhatsApp's own export:

```text
WhatsApp Chat with Bob
Exported 2026-11-18 08:20:00 · 3 messages
Conversation dates: 17 Nov 2026 – 17 Nov 2026
--------------------------------------------------------

--- 17 Nov 2026 ---

[2026-11-17 14:02:00] Bob: Are we still on for tomorrow?
[2026-11-17 14:03:00] Alice: Yes — I'll bring the slides.
[2026-11-17 14:05:00] Bob: Perfect. See you at 9.
```

**JSON** — structured for scripts (schema shown abridged):

```json
{
  "schema": "chat-export/v1",
  "generator": "Chat Export for WhatsApp 1.0.0",
  "exportedAt": "2026-11-18T01:20:00.000Z",
  "chat": { "name": "Bob", "isGroup": false },
  "settings": { "format": "json", "mediaMode": "link", "includeSystem": false,
                "includeReactions": true, "dateRange": "all" },
  "stats": { "total": 3, "incoming": 2, "outgoing": 1, "byType": { "text": 3 },
             "participants": [ { "name": "Bob", "count": 2 } ],
             "dateRange": { "start": "2026-11-17T07:02:00.000Z",
                            "end": "2026-11-17T07:05:00.000Z" } },
  "messages": [
    {
      "id": "false_1234567890@c.us_3EB0A1B2C3D4",
      "timestamp": 1794898920000,
      "timestampISO": "2026-11-17T07:02:00.000Z",
      "date": "2026-11-17",
      "time": "14:02:00",
      "author": "Bob",
      "direction": "incoming",
      "type": "text",
      "text": "Are we still on for tomorrow?",
      "quoted": null,
      "reactions": [],
      "media": null
    }
  ]
}
```

**CSV** — one row per message, UTF-8 with a BOM so Excel detects the encoding:

```csv
timestamp_iso,timestamp_ms,date,time,author,direction,type,text,quoted_author,quoted_text,reactions,media_kind,media_file,media_missing,message_id
2026-11-17T07:02:00.000Z,1794898920000,2026-11-17,14:02:00,Bob,incoming,text,Are we still on for tomorrow?,,,,,,,false_1234567890@c.us_3EB0A1B2C3D4
2026-11-17T07:03:00.000Z,1794898980000,2026-11-17,14:03:00,Alice,outgoing,text,Yes — I'll bring the slides.,,,,,,,true_1234567890@c.us_3EB0A1B2C3D4
```

---

## How it works

- **A content script runs inside the WhatsApp Web tab.** It only activates on `https://web.whatsapp.com/*`, reads the page that is already rendered in your browser, and has no network access of its own.
- **It finds the conversation panel and the message list** through a small set of selectors, each with a fallback chain. If a lookup fails, the export records a warning instead of crashing.
- **It loads history by scrolling up incrementally**, waiting for WhatsApp to render older messages, and repeating until it reaches the top of the chat or passes your date cutoff.
- **Each rendered message is identified by its `data-id` attribute**, which is stable enough to avoid double-counting when rows are recycled while scrolling. Timestamps are read from WhatsApp's `data-pre-plain-text` attribute (or the row's time element as a fallback).
- **Messages are parsed into a common shape** (author, outgoing flag, type, text, quote, reactions, media) so HTML, TXT, JSON and CSV all come from one pass.
- **Media is captured from what WhatsApp has already rendered.** Images and other previews are fetched from the blob/data URLs in the page and bundled with the report into a generated `.zip`; media WhatsApp has never loaded cannot be fetched, so it is marked missing instead of silently dropped.
- **The output file is built in the browser** as a `Blob`, saved through an object URL and a local download. Nothing is uploaded; the only copy of the data is the file you receive.
- **Progress is mirrored into session storage**, which is why closing and reopening the popup does not lose the live status. The content script keeps working as long as the WhatsApp tab is open.

A longer walkthrough of the modules and message flow is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Options reference

| Option | Values | Default | What it does |
| --- | --- | --- | --- |
| **Format** | HTML, TXT, JSON, CSV | `HTML` | Output file type. HTML is a styled standalone page; JSON and CSV are for scripts and spreadsheets. |
| **Date range** | All time, Last 7 days, Last 30 days, Last 90 days, Custom range | `All time` | Limits the export to messages within the range. Older messages are skipped while scrolling. |
| **Custom range** | start date and end date (`YYYY-MM-DD`) | empty | Used only when **Date range** is *Custom range*. Both ends are inclusive; leave one blank for open-ended. |
| **Media handling** | None, Placeholders, Download (`.zip`) | `Placeholders` | *None* leaves media out entirely; *Placeholders* records where each item was; *Download* collects capturable files and the report into a single `.zip`. |
| **Include system messages** | on / off | `off` | Includes joins, leaves, group changes and WhatsApp's notices about encryption and calls. |
| **Include reactions** | on / off | `on` | Adds emoji reactions (and counts) to the messages they belong to. |
| **Show sender names** | on / off | `on` | Labels each message with its sender. Turn off for a cleaner one-to-one transcript. |
| **Max media download** | megabytes | `250` | Safety cap on total media bytes collected in the `.zip`. Once the cap is reached, remaining media is listed as missing rather than downloaded. |

Settings are saved in `chrome.storage.local`; the last five exports are kept in the history list. Neither ever leaves your browser.

---

## FAQ

**Does it work on WhatsApp Desktop?**
No. It works only inside a Chromium browser on <https://web.whatsapp.com>. The extension needs a normal web page it is allowed to run in; the desktop app is a separate application.

**Does it send my data anywhere?**
No. It makes zero network requests. There is no account, no server, no analytics and no telemetry. Chat data is read from the open tab, assembled in memory, and written to a local file. See [PRIVACY.md](PRIVACY.md).

**Why are some images missing?**
WhatsApp Web loads media lazily. An image, video, voice note or document is only available to the extension once WhatsApp has actually rendered it — typically because you scrolled past it and it loaded on screen. Items that were never opened or rendered cannot be downloaded afterwards, so they are exported as "missing" placeholders. There is no way to fetch them after the fact from the browser alone.

**Why did it stop early?**
WhatsApp Web virtualises the message list: only a window of rows exists in the page at any time, and history is loaded in chunks while scrolling. Very long chats are therefore bounded by how much history WhatsApp is willing to load and how long the export is allowed to scroll. The export stops at the top of the loaded history or at your date cutoff, or when a built-in safety cap (scroll steps or elapsed time) is reached; either way the summary lists what was captured and any warning.

**Does it need my phone?**
No. It uses the WhatsApp Web session that is already logged in. Your phone is needed only to set up or refresh that WhatsApp Web login, as usual.

**Does it work in other Chromium browsers?**
Yes — Edge, Brave and Arc support the same unpacked extension flow, with the same steps (use that browser's `…://extensions` page). Firefox and Safari are not supported.

**Is it free?**
Yes, MIT licensed. Use it, fork it, ship it. See [LICENSE](LICENSE).

**Does it work on group chats?**
Yes. Sender names are shown per message by default, and system messages can be included. Group-specific details are captured to the extent WhatsApp renders them.

---

## Troubleshooting

If an export fails, stops early, or a format looks wrong, start with [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). It explains the diagnostics panel (selectors, matched rows, warnings), what each error code means, and how to work around a WhatsApp Web redesign. The most common cause of "nothing exported" after a WhatsApp update is changed selectors; the diagnostics panel tells you exactly which one broke.

---

## Development

The extension is deliberately small: classic scripts on one global `WAEx` namespace, no bundler, no
runtime dependencies. Reload it from `chrome://extensions` after editing.

```bash
npm run lint      # static rules: permissions, no network, no innerHTML, manifest contract
npm test          # all suites
npm run build     # dist/whatsapp-chat-export-v1.0.0.zip, ready for the Chrome Web Store
```

Continuous integration runs `lint`, the full test suite on Node 20 and 22, and the packaged build on
every push and pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Tagging
`vX.Y.Z` publishes a release with the built zip attached
([`.github/workflows/release.yml`](.github/workflows/release.yml)). The step-by-step release and
store-submission checklist is in [docs/RELEASING.md](docs/RELEASING.md).

### Repository layout

```text
whatsapp-chat-export/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── release.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── dependabot.yml
├── docs/
│   ├── examples/
│   │   ├── example-chat.csv
│   │   ├── example-chat.html
│   │   ├── example-chat.json
│   │   └── example-chat.txt
│   ├── store/
│   │   ├── marquee-1400x560.png
│   │   ├── promo-tile-440x280.png
│   │   ├── screenshot-1-export.png
│   │   ├── screenshot-2-formats.png
│   │   ├── screenshot-3-media.png
│   │   ├── screenshot-4-progress.png
│   │   └── screenshot-5-privacy.png
│   ├── ARCHITECTURE.md
│   ├── PROTOCOL.md
│   ├── RELEASING.md
│   ├── STORE.md
│   └── TROUBLESHOOTING.md
├── icons/
│   ├── icon.svg
│   ├── icon128.png
│   ├── icon16.png
│   ├── icon32.png
│   └── icon48.png
├── scripts/
│   ├── build.mjs
│   └── lint.mjs
├── src/
│   ├── background/
│   │   └── service-worker.js
│   ├── content/
│   │   ├── content.js
│   │   ├── extractor.js
│   │   └── media.js
│   ├── lib/
│   │   ├── datetime.js
│   │   ├── formats.js
│   │   ├── namespace.js
│   │   └── zip.js
│   └── popup/
│       ├── popup.css
│       ├── popup.html
│       └── popup.js
├── test/
│   ├── screenshots/
│   │   ├── action-cancel.png
│   │   ├── action-custombad.png
│   │   ├── action-export-done.png
│   │   ├── chrome-real-popup.png
│   │   ├── diag-bottom.png
│   │   ├── diag-copied.png
│   │   ├── diag.png
│   │   ├── done-dark.png
│   │   ├── done-long.png
│   │   ├── done.png
│   │   ├── error-dark.png
│   │   ├── error.png
│   │   ├── exporting-dark.png
│   │   ├── exporting-indeterminate.png
│   │   ├── exporting-media.png
│   │   ├── exporting.png
│   │   ├── loading.png
│   │   ├── no-chat.png
│   │   ├── no-tab.png
│   │   ├── not-ready.png
│   │   ├── ready-auto-dark.png
│   │   ├── ready-dark.png
│   │   ├── ready-download-dark.png
│   │   ├── ready-download.png
│   │   ├── ready-full.png
│   │   ├── ready-long.png
│   │   └── ready.png
│   ├── chrome-smoke.mjs
│   ├── datetime.test.mjs
│   ├── e2e.test.mjs
│   ├── extractor.test.mjs
│   ├── fixture.mjs
│   ├── formats.test.mjs
│   ├── harness.mjs
│   ├── make-examples.mjs
│   ├── manifest.test.mjs
│   ├── popup-preview.html
│   ├── popup-preview.mjs
│   ├── popup.test.mjs
│   ├── run.mjs
│   ├── store-shots.html
│   ├── store-shots.mjs
│   └── zip.test.mjs
├── .editorconfig
├── .gitignore
├── .nvmrc
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── PRIVACY.md
├── README.md
├── SECURITY.md
├── manifest.json
├── package-lock.json
└── package.json
```

The tree lists source files. `test/out/` (reports produced by the test suite) and `node_modules/` are generated and intentionally omitted.

### Tests

```bash
cd whatsapp-chat-export
npm test
```

The tests are plain Node scripts (`jsdom` is the only dev dependency) and run in six suites:

| Suite | What it proves |
| --- | --- |
| `datetime.test.mjs` | Every timestamp/locale format WhatsApp can render, day/month order inference, date ranges. |
| `formats.test.mjs` | The four writers: HTML escaping, CSV quoting and BOM, JSON schema, TXT layout, filenames. |
| `zip.test.mjs` | The hand-written ZIP container: CRC-32 vectors, deflate, unicode names, path-traversal safety. Validated by Python's `zipfile`. |
| `extractor.test.mjs` | The scraper against a simulated WhatsApp DOM: chat header, quotes, reactions, media, system notices, scroll-to-load, cancellation, date-range cut-off, virtualisation recovery, diagnostics. |
| `e2e.test.mjs` | The real content script end to end: exports HTML+media (ZIP contents opened and checked), CSV, JSON with a date range, and the failure paths. |
| `popup.test.mjs` | The real popup page wired to the real content script: boot, settings persistence, a full export triggered by clicking the button, history, degraded states. |
| `manifest.test.mjs` | Packaging: MV3 fields, minimal permissions, every referenced file exists, icon dimensions, no inline script or `eval`. |

`npm test` runs all of them and fails if any check fails. `npm run screenshots` regenerates the popup screenshots in `test/screenshots/` from `test/popup-preview.html`.

There is also an optional real-browser check. It loads the unpacked extension into headless Chrome through the DevTools `Extensions` domain, confirms the MV3 service worker starts, opens the popup as a real extension page (watching for CSP violations), and injects the content script into a live `web.whatsapp.com` page:

```bash
npm run smoke:chrome
```

It needs a locally installed Chrome (`CHROME_BIN` to override the binary) and skips the live-WhatsApp assertions when there is no network. Nothing about it is required to build or run the extension.

### Icons

`icons/icon.svg` is the vector source: a rounded green tile (`#25D366` → `#00A884`) with a white speech bubble and a download arrow. The PNGs are rendered at 4× and downsampled with Lanczos for clean edges; the 16 px and 32 px variants use a slightly larger bubble and a thicker arrow so the shape still reads at toolbar size.

To regenerate with Inkscape or librsvg plus ImageMagick:

```bash
# render the vector large, then downsample to the four required sizes
rsvg-convert -w 512 -h 512 icons/icon.svg -o /tmp/wax-icon-512.png
for size in 16 32 48 128; do
  magick /tmp/wax-icon-512.png -filter Lanczos -resize "${size}x${size}" "icons/icon${size}.png"
done
```

Check `icon16.png` by eye afterwards; the arrow should remain a distinct downward shape, not a blob. The PNGs must be exactly 16×16, 32×32, 48×48 and 128×128.

### Coding rules

These come from [docs/PROTOCOL.md](docs/PROTOCOL.md), which is the contract between the popup, the content script and the service worker:

- **Classic scripts only.** No ES modules; every library file is an IIFE that attaches to the global `WAEx` namespace. `src/lib/namespace.js` is the source of truth for constants, defaults and file load order.
- **No network requests.** `fetch` may only read `blob:`/`data:` URLs that already exist in the page (that is how media is captured). Never call a remote URL, and never add analytics, telemetry or remote code. Chat data must stay in the tab and in the downloaded file.
- **No `innerHTML` with user content.** Message text is always inserted via `textContent` or DOM nodes, never interpolated into HTML strings.
- **Minimal permissions.** `storage`, `scripting`, `activeTab`, plus host access to `https://web.whatsapp.com/*`. Do not widen them.
- **Fail soft.** Every selector gets a fallback chain; a missing element becomes a warning, not an exception that kills the export.
- **The popup may close at any time.** Essential state lives in the content script and `chrome.storage.session`, never only in the popup.

Project documents:

| Document | Contents |
| --- | --- |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Message protocol, settings shape, data types, the rules the code must follow |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the three contexts fit together, selector strategy, failure modes |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Selector breakage, missing media, cancelled exports |
| [docs/RELEASING.md](docs/RELEASING.md) | Versioning, release checklist, Chrome Web Store submission |
| [docs/STORE.md](docs/STORE.md) | Store listing copy, permission justifications, graphics |

The extension's artwork (icons) is in [icons/](icons/), the store screenshots and promo tiles are in
[docs/store/](docs/store/), and sample exports for each format are in [docs/examples/](docs/examples/).

---

## Contributing, security and support

- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, the five ground rules, what is
  most useful to send in a pull request, and the test layout.
- **Questions and ideas:** [GitHub Discussions](https://github.com/CaullenOmdahl/whatsapp-chat-export/discussions).
- **Bugs:** use the issue form; include the popup's **Diagnostics** report, which contains selector
  match counts but no message content.
- **Security:** please report privately — see [SECURITY.md](SECURITY.md). Do not open a public issue
  for a vulnerability.
- **Code of conduct:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

> **Not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta.** "WhatsApp" is used only
> to describe compatibility with WhatsApp Web. The extension only reads the conversation you have
> open; it never automates WhatsApp actions.

---

## Privacy

Short version: **nothing is collected, nothing is transmitted, and chat data never leaves your browser.** The extension stores your option settings and a five-entry export history in `chrome.storage.local`; exports run entirely in the WhatsApp tab. Read the full policy in [PRIVACY.md](PRIVACY.md).

---

## License

MIT — see [LICENSE](LICENSE). Copyright 2026 Chat Export for WhatsApp contributors.

**Disclaimer:** Chat Export for WhatsApp is an independent project. It is not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta. "WhatsApp" is a trademark of Meta Platforms, Inc., used here only to describe compatibility with WhatsApp Web. Use it only on conversations you have the right to export, and respect the privacy of the people in them.
