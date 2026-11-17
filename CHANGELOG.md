# Changelog

All notable changes to **Chat Export for WhatsApp** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
