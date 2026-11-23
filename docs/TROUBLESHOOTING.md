# Troubleshooting — Chat Export for WhatsApp

Most problems fall into one of three buckets: the tab is not in the state the extension expects,
WhatsApp Web changed its DOM, or the browser blocked the download. This guide works through each in
order and ends with how to use the diagnostics panel and how to report a selector break.

If you only read one section, read [The diagnostics panel](#the-diagnostics-panel) — it answers
"is this a selector problem?" in about five seconds.

---

## Quick checklist

Before anything else:

1. Is the WhatsApp Web tab open and logged in at <https://web.whatsapp.com>?
2. Is a **chat actually open** (not just the chat list)? The extension exports the conversation in
   the main panel, so a chat must be selected.
3. Is the extension **enabled** on `chrome://extensions`, and did you reload the WhatsApp tab after
   installing or updating it?
4. Is the popup being opened on the **WhatsApp Web tab** (not on another tab or a Chrome page)?
5. Did you wait for WhatsApp to finish loading the conversation before exporting? The first export
   in a fresh tab can start before the message list exists.

If all five are true, open the diagnostics panel.

---

## The diagnostics panel

The panel reports which page selectors currently match. It is the fastest way to tell a normal
problem (no chat open) from a WhatsApp UI change (selectors stopped matching).

### Opening it

- Click the **gear icon** at the top of the popup, or the **Diagnostics** button in the popup
  footer.
- The popup must be opened on the WhatsApp Web tab. If it is not, the panel tells you to open
  WhatsApp Web first.
- **Copy report** copies the whole report as JSON, ready to paste into a bug report.

### Reading it

At the top you get the page URL and four numbers:

| Field | What it means | Healthy value |
| --- | --- | --- |
| **Rendered rows** | Message rows WhatsApp currently has in the DOM. | More than 0 when a chat is open. |
| **Parsed messages** | Messages the parser could build from those rows. | At or near rendered rows. |
| **Message list** | Whether the scroll container for the history was found. | `scrollable`. `not found` / `not scrollable` means history cannot be loaded — report it with the copy below. |
| **Scroll height** | Total height of the loaded message list. | Grows while the export runs; a large number means a lot of history is loaded. |

Below that, **Selector health** lists every named selector, the actual CSS selector currently in
use, and how many elements it matched:

| Selector name | Healthy value | If it is 0 |
| --- | --- | --- |
| Conversation panel | 1 (or more) | WhatsApp is not showing a conversation, or the panel wrapper changed. Open a chat; if it stays 0, this is the break to report. |
| Chat title | 1 | The title hook changed. Exports still work, but the chat name and file name fall back to a generic value. |
| Message rows | More than 0 | The message list has not rendered yet, or the row markup changed. |
| Message nodes | More than 0 | The `data-id` hook changed. This is the most serious selector break; scrolling and de-duplication depend on it. |
| Timestamp attributes | More than 0 | Timestamps cannot be read from `data-pre-plain-text`; dates fall back to rendered text and may be less accurate. |
| Message text | More than 0 | Text bubbles were not found; messages may export with missing text. |
| Quoted replies | 0 is fine | Only matches when the visible messages contain quoted replies. |

At the bottom, **Warnings** lists anything the export has already noticed — missing scroll
container, unparseable timestamps, media that could not be read, and similar degraded cases.

### Interpreting combinations

- **Rendered rows 0, Parsed messages 0** → no chat open, WhatsApp still loading, or the
  conversation panel was not found. Check the panel and title selectors.
- **Rendered rows > 0, Parsed messages 0** → the rows exist but parsing failed. Look at the
  message-node, timestamp and text selectors; this is a classic post-update break.
- **Message list is `not found` / `not scrollable`, but selectors match** → the history cannot be
  scrolled, so only visible messages export. Copy the report and file a bug.
- **Everything matches, but the export stops early** → not a selector problem; see
  [The export stopped early](#the-export-stopped-early).
- **Everything matches, but media is missing** → expected for media WhatsApp has not rendered; see
  [Media is missing from the export](#media-is-missing-from-the-export).

The diagnostics report contains **no message text** — only the page URL, selector names, match
counts and warnings. It is safe to share.

---

## Common problems

### "No conversation found" / the Export chat button does nothing

1. Open a chat in WhatsApp Web, wait for messages to appear, then reopen the popup.
2. Reload the WhatsApp tab (`Ctrl/Cmd+R`), wait for it to finish loading, and try again. After
   installing or updating the extension, a reload is required before the content script exists in
   tabs that were already open.
3. Check that the popup is running on the `web.whatsapp.com` tab. The extension uses `activeTab`,
   so it acts on the tab you are viewing when you open the popup.
4. If the tab is in a different Chrome window or is a PWA/app window, open a normal
   `https://web.whatsapp.com` tab instead.

### "No messages matched this export"

This is the `NO_MESSAGES` error, meaning the filters removed everything:

- **Date range too narrow** — a custom range with no messages, or a preset where the chat simply has
  no recent messages. Widen the range.
- **History not loaded yet** — for a chat that opens on "Today", the scroll phase must load older
  messages before a 30/90-day filter can match anything. Retry, keeping the tab visible, or widen
  the range to **All time**.
- **System-only content** — a chat containing only system notices with *Include system messages*
  off will produce no messages by design.

### The export stopped early

The result panel and its warnings list say why. Current versions have these safety caps:

- **4000 scroll rounds**,
- a **10-minute** time budget, and
- a **150,000 message** ceiling.

Hitting one produces a warning such as "Stopped after 4000 scroll steps…". Other, normal stop
reasons:

- **The oldest message was reached.** WhatsApp had nothing older to give; the export is complete.
- **Your date range was covered.** Scrolling stops as soon as the start of the range is loaded.
- The WhatsApp tab was reloaded or closed, which tears down the content script (`PAGE_RELOADED`).
- You pressed **Cancel**.

How loading works: the extension walks **backwards to the oldest message and then forwards to the
newest one**. Backwards, it jumps to the top of the list so WhatsApp fetches the previous page,
waits for that page to render, parses it, and repeats; when a jump stops producing new messages it
falls back to viewport-sized scroll steps. If the chat was not showing its newest message when the
export started (WhatsApp restores your last scroll position), a second pass then steps down to the
newest message, collecting each page as it loads. Each attempt waits up to four seconds for
WhatsApp to deliver a page, even if nothing on screen changes meanwhile, and at the top it scrolls
away and back once more before concluding there is nothing older. If the top of the list is still
a message rather than WhatsApp's opening notice, the export finishes with a warning that the first
message could not be confirmed.

WhatsApp does not render a whole conversation at once — it loads older pages as the list is
scrolled, so a long chat takes time. While it runs, the progress line counts messages as they are
loaded (`Loading older messages… 1,240 so far`). Keep the WhatsApp tab in the foreground for the
duration; you can press **Cancel** at any point and nothing is saved.

If it stops far short of the beginning of a long chat, open **Diagnostics** and check:

1. **Message list** says `scrollable` (not `not found` / `not scrollable`). If not, the scroll
   container was not detected — copy the report and file a bug.
2. **Rendered rows** is much larger than **Parsed messages** — the row markup probably changed.
3. **Scroll height** is not growing while the progress counter is stuck — WhatsApp is not loading
   more pages, possibly because the page is in the background.

**Older versions:** 1.0.0 could stop after the messages already on screen when WhatsApp hid the
message list's scrollbar (fixed in 1.0.1). 1.0.1 only scrolled upwards, so a chat restored to its
first message exported only the opening page (fixed in 1.0.2). 1.0.0–1.0.2 did not recognise the
message ids current WhatsApp Web builds use, so every export held only the screenful of messages
visible when loading finished, and a page that took more than about a second to arrive could end
loading early (both fixed in 1.0.3). Update and reload the WhatsApp tab if you are on anything older.

### Media is missing from the export

Expected behaviour, and documented deliberately:

- WhatsApp Web only loads media that has been rendered on screen. If an item was never scrolled
  into view or opened, its bytes do not exist in the page and **cannot** be captured. It exports as
  a placeholder marked missing — it is not a bug.
- Some previews exist as thumbnails without a downloadable source; those are also marked missing.
- **Size limit** (default 250 MB, adjustable from 10 to 2048 MB while Media is set to *Download*)
  stops collection when the cap is reached. Remaining items are marked missing and the summary
  includes a cap warning.
- To maximise captured media, use **Download** mode, start from the oldest message you need, and
  scroll through the chat once so WhatsApp renders the media before exporting.

Media is **never** fetched from WhatsApp servers; only already-loaded page data is used.

### The download did not start, or Chrome asked to allow multiple downloads

- Check `chrome://downloads` for a blocked entry, and check the downloads bubble/toolbar.
- If Chrome asks "Allow this site to download multiple files?", choose **Allow**. A media export
  downloads a single `.zip`, but browsers may still prompt depending on settings.
- Check that downloads are not disabled by policy, and that the Downloads folder exists and is
  writable.
- A large media archive (up to the cap) takes time to assemble before the download appears. Watch
  the popup's "Saving file" phase; do not close the tab.

### I closed the popup — did the export stop?

No. The export runs in the WhatsApp tab, not in the popup. Reopen the popup and live progress is
restored from session storage. The export does stop if the **WhatsApp tab** is closed, reloaded or
crashed. Keep that tab open until the summary appears.

### "An export is already running"

A previous run is still active for that tab. Either wait for it to finish or press **Cancel**. If
the popup shows a stale state after a crash, reload the WhatsApp tab and reopen the popup; the
extension refuses a second concurrent export by design.

### The exported HTML has no images / broken image icons

- If you used **Download**, the report lives *inside* the `.zip`. Extract the whole archive first,
  then open the report from inside the extracted folder so its relative `media/` paths resolve.
- If you used **Placeholders**, images are intentionally replaced by a note saying where each item
  was.
- If an item was never rendered by WhatsApp, the HTML shows a "not loaded in WhatsApp, so it was not
  saved" placeholder (or is omitted in **None** mode).
- If no media was captured at all, no `.zip` is produced and the report downloads on its own.

### The CSV looks wrong in Excel

- The CSV is UTF-8 **with a BOM**, which modern Excel detects. If your version still shows garbled
  characters, import it via **Data → From Text/CSV** and choose UTF-8 (65001).
- The file uses commas as separators. For locales that expect semicolons, import it as CSV rather
  than double-clicking.
- Long numbers (message ids) may be formatted as scientific notation by Excel. Import the
  `message_id` column as text.
- Line endings are CRLF; that is normal.

### The JSON has no messages, or a script fails to parse it

- Confirm the file starts with `{` and is valid UTF-8; the export is pretty-printed JSON. Use
  `JSON.parse` (JavaScript) or `json.load` (Python) as usual.
- The top-level keys are `schema`, `generator`, `exportedAt`, `chat`, `settings`, `stats` and
  `messages`. The schema id is `chat-export/v1`.
- Messages with no recoverable timestamp still appear with `timestamp: null`; handle that in your
  script.

### The TXT looks different from WhatsApp

TXT is a plain-text rendering, not a screenshot: it adds an export header, day dividers and a
footer, and it records media as bracketed labels (including the path inside the archive when media
was downloaded). That is intentional.

### It worked before and broke after a WhatsApp update

That is the expected failure mode. WhatsApp ships frequent DOM changes. Run the diagnostics panel,
note which selector dropped to 0, and report it (see below). Until an update lands, you can try
opening a different chat to force WhatsApp to re-render, reloading the tab, or using the oldest
messages already in the DOM. Do not edit files inside the installed extension; changes are lost on
update and can break the signature/integrity of what you are testing.

### The extension updated but the old version is still running

On `chrome://extensions`, press the reload icon on the extension's card, then reload the WhatsApp
Web tab. Old content-script instances only go away with the tab reload. If you loaded the extension
from two different folders, remove the duplicate — two copies can both answer, producing confusing
behaviour.

---

## When a selector breaks

A selector break is not a crash: the extension degrades, records warnings, and keeps going. Here is
the practical procedure.

1. **Confirm it is a selector break.** Open Diagnostics on the affected chat. A named selector with
   `matches: 0` that should be non-zero is the signal.
2. **Capture the report.** Press **Copy report** and save the JSON. It includes the page URL,
   selector names, match counts and warnings — no message text.
3. **Check the obvious alternatives.** A chat must be open; the tab must be on a current
   `web.whatsapp.com`; reload the tab once.
4. **Report it** with the report JSON, your browser version (`chrome://version`), the extension
   version, and a one-line description of what failed (e.g. "message text exported as empty for
   every message"). The project issue tracker is the place for this.
5. **Wait for an update** rather than hand-editing the installed folder. If you are a developer,
   see [Extending safely](ARCHITECTURE.md#extending-safely) and
   [PROTOCOL.md](PROTOCOL.md) for the selector and diagnostics contract.

A useful bug report:

```text
What I did: opened chat "Alice", chose HTML + All time, clicked Export
What happened: file downloaded, but every message body is empty
Expected: message text in the HTML
Browser: Chrome 142.0.x, extension 1.0.0
Diagnostics report: <paste the JSON from "Copy report">
```

---

## Still stuck?

- Re-read the [FAQ](../README.md#faq) for behaviour that is by design (missing media, long-chat
  limits, browser-only support).
- Reinstall cleanly: remove the extension, load the unpacked folder again, reload the WhatsApp tab.
- Check [CHANGELOG.md](../CHANGELOG.md) for known limitations in the version you are running, and
  [PRIVACY.md](../PRIVACY.md) if your question is about what is stored or transmitted.

If the problem is data loss (a report that is empty, truncated, or claims far fewer messages than
the chat has), include the export summary numbers and any warnings — those are the most useful
signals for reproducing it.
