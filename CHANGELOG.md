# Changelog

All notable changes to **Chat Export for WhatsApp** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4] — 2026-11-24

### Fixed

- **Messages are no longer exported blank.** WhatsApp keeps messages away from the viewport as
  empty placeholders and fills them in only when they scroll into view. 1.0.3 collected the
  placeholders as messages and never read them again: a 932-message export had 883 messages
  with no author, text or date, and the rest on the wrong days. Placeholders are now left
  pending, loading always finishes with a downward sweep that waits for each screen to fill
  in, and any that never do are counted in a warning rather than exported empty.
- A message without its own timestamp takes the time of the message above it on the page,
  not of whichever message was parsed last.
- The success panel lists every warning instead of only "2 warnings" with the text hidden
  in a tooltip.
- A one-to-one chat is no longer marked as a group in the export because the user's own
  messages carry a second name. Incoming messages WhatsApp shows without an author line
  (deleted messages, some stickers) are attributed to the other person in a one-to-one chat.
- **Your own messages are recognised again.** WhatsApp no longer puts `.message-out` /
  `.message-in` on messages, so every message was exported as incoming. Direction now comes
  from, in order: the old classes, the bubble tail (`tail-out`), delivery ticks, and which
  side of the list the bubble sits on. If none of those is available in a one-to-one chat,
  the author who is not the contact is taken to be you, with a warning saying so.
- **Long and multi-paragraph messages are exported in full.** WhatsApp now splits such a
  message across many text elements (17 in one live message); only the last one was kept.
  Every element is read in order, with line breaks between paragraphs, and the first
  paragraph is no longer mistaken for a quoted reply.
- Stickers are also recognised by WhatsApp's current `sticker-container` marker.
- Deleted messages read "This message was deleted" instead of exporting as a blank line.
- WhatsApp notices that carry a `data-id` (the encryption notice, for example) are exported
  as system messages. They were counted as unread placeholders, which also caused a false
  "could not confirm the first message" warning.
- Media that could not be read is reported once per kind ("Could not read 8 sticker
  files…") instead of once per file, and the routine "N messages were recovered…" note is
  gone.

### Tools

- `scripts/wa-probe.js`: paste into DevTools on WhatsApp Web to save a structure-only report
  (no message text, names, numbers or ids) of the open chat's markup, for diagnosing the
  next WhatsApp page change.

### Docs

- README: "How it works" describes the two-pass load and placeholders; new Limitations
  section.

## [1.0.3] — 2026-11-24

### Fixed

- **Exports contain the whole conversation again, not one screenful.** Current WhatsApp Web
  builds give each message a `data-id` that is a single opaque token instead of the old
  `true_…`/`false_…` form. The extractor rejected every one, so nothing was collected while
  scrolling and an export held only the messages on screen when loading finished. Any
  `data-id` inside a message row now counts; message direction comes from the
  `.message-out`/`.message-in` element, with the delivery ticks as a fallback.
- **A slow page of older messages no longer ends loading early** ([#6]). A round used to be
  called idle after 1.1 s of quiet DOM, and two such rounds at the top ended the export
  silently. Each round now waits the full 4 s, a page that swaps rows without growing the list
  counts as progress, and at the top the loader scrolls away and back once before concluding.
- **Partial exports say so.** A warning appears when loading stalls before the top, or when
  the top of the list is a message rather than WhatsApp's opening notice.
- One-to-one chats are no longer labelled as groups because of the user's own messages.
- The *Include reactions* option is honoured; reactions were always collected before.
- README release and build examples no longer name an old version ([#5]).

### Note

- The 1.0.2 entry below says an 811-message chat exported in full. That was wrong: on the
  WhatsApp Web build in use at the time 1.0.2 still exported one screen of messages, for the
  `data-id` reason above.

[#5]: https://github.com/CaullenOmdahl/whatsapp-chat-export/issues/5
[#6]: https://github.com/CaullenOmdahl/whatsapp-chat-export/issues/6

## [1.0.2] — 2026-11-18

### Fixed

- **The whole conversation is exported, not just the part that was on screen.** The
  loader only ever scrolled upwards, so if WhatsApp had restored the chat to the
  beginning (or anywhere other than the newest message) it found "nothing older" and
  stopped. A second pass now walks down to the newest message whenever the conversation
  did not start there, collecting every page as it loads. Confirmed against a phone
  export of an 811-message chat: v1.0.1 exported the opening 26 messages, v1.0.2
  exports all 811.
- Progress explains which direction is running ("Scrolling back through history" /
  "Catching up to the newest message").
- Date ranges with both ends now report coverage-based progress.

## [1.0.1] — 2026-11-18

### Fixed

- **History loading now reaches the beginning of the conversation.** The message list is
  detected even when WhatsApp hides its scrollbar (`overflow: hidden`), which previously
  made the extension give up and export only the messages already on screen. When jumping
  to the top stops producing new pages, loading falls back to viewport-sized scroll steps,
  and each round now waits for the next page instead of giving up after a few seconds.
- **The message count in the popup is accurate.** It counted DOM nodes rather than unique
  message ids, so it could show a much higher number than the export contained.
- Messages that WhatsApp removes from the DOM while scrolling are still included, because
  history is parsed while loading instead of only at the end.
- Loading stops when the selected date range is covered, not before and not long after.

### Changed

- The history budget is now 10 minutes (was 4) with a clear warning if it is reached, so
  long conversations load as far back as WhatsApp allows.
- The date range option explains how far back it will scroll.
- CI runs the suite on Node 22 and 24; Node 22 is now the minimum for development
  (jsdom 31 requires it).
- Dependency and GitHub Actions updates from Dependabot, with Actions still pinned to
  commit SHAs and grouped into a single pull request per ecosystem.

## [1.0.0] — 2026-11-18

First public release.

### Added

- One-click export of the currently open WhatsApp Web conversation, with automatic incremental scroll-up to load older history.
- Four export formats:
  - **HTML** — styled transcript that opens in any browser, with media bundled alongside it when requested.
  - **TXT** — WhatsApp-like plain text.
  - **JSON** — structured messages for scripts and analysis.
  - **CSV** — one row per message, ready for Excel or Google Sheets.
- Date range options: all time, last 7 days, last 30 days, last 90 days, and a custom start–end range.
- Media handling modes: skip media, export placeholders for each media item, or download capturable media into a single `.zip` that also contains the report.
- Options to include or exclude system messages, include or exclude reactions, and show or hide sender names.
- Media size limit (adjustable 10–2048 MB, default 250 MB) for media downloads, shown in the popup when Media is set to Download.
- Live progress UI with a Cancel button.
- Exports keep running when the popup is closed; reopening the popup restores live progress.
- Recent-export history for the last five exports.
- Diagnostics panel reporting which DOM selectors matched and which warnings were raised.
- Fully local operation: no network requests, no telemetry, no account, no server.
- Extension icons at 16, 32, 48 and 128 px, with an SVG source.
- Documentation: README, privacy policy, architecture notes, Chrome Web Store copy, troubleshooting guide and internal protocol reference.
- Repository tooling: `npm run lint` (static rules), `npm run build` (Chrome Web Store zip), CI on Node 20 and 22, and a tag-driven release workflow.
- Contributor documents: CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue and pull-request templates, Dependabot.
- Chrome Web Store artwork generated from the real popup: five 1280×800 screenshots, a 440×280 promo tile and a 1400×560 marquee.
- Sample exports for every format in `docs/examples/`.

### Security

- No remote code and no network access; all processing happens in the WhatsApp Web tab.
- Minimal permissions: `storage`, `scripting`, `activeTab`, and host access to `https://web.whatsapp.com/*`.

### Known limitations

- Media that WhatsApp Web has not rendered (never scrolled past or opened) cannot be captured and is marked as missing.
- Very long chats are bounded by how much history WhatsApp Web loads during the scroll phase.
- Browser only: WhatsApp Desktop is not supported.

---

**Disclaimer:** Chat Export for WhatsApp is not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta. "WhatsApp" is used only to describe compatibility.
