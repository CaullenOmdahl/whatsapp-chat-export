# Contributing

Thanks for taking the time to help. This is a small, deliberately dependency-free
project: read this page before opening a pull request.

## Quick start

```bash
git clone https://github.com/CaullenOmdahl/whatsapp-chat-export.git
cd whatsapp-chat-export
npm ci            # installs jsdom, the only dev dependency
npm test          # runs every suite
```

To try your change in the browser: `chrome://extensions` → Developer mode → **Load
unpacked** → select the repo folder. After editing content-script or popup files,
press the reload icon on the extension card and reload the WhatsApp tab.

Optional real-browser check (needs Chrome installed):

```bash
npm run smoke:chrome
```

## Ground rules

These come from [docs/PROTOCOL.md](docs/PROTOCOL.md); a pull request that breaks one
of them will be asked to change.

1. **No network.** Chat data and message content never leave the browser. `fetch` may
   only read `blob:` / `data:` URLs that already exist in the page (that is how media
   is captured). No analytics, telemetry, remote config or remote code.
2. **No new permissions.** The manifest asks for `storage`, `scripting`, `activeTab`
   and host access to `https://web.whatsapp.com/*`. Widening that needs a very good
   reason and a discussion in an issue first.
3. **No `innerHTML` with user content.** Message text, chat names and filenames are
   always written through `textContent` or DOM nodes. The exported HTML document is
   built with the escaping helpers in `src/lib/formats.js`.
4. **Classic scripts only.** No bundler, no ES modules in shipped files. Every library
   file is an IIFE that attaches to the global `WAEx` namespace, and
   `src/lib/namespace.js` is the source of truth for constants and load order.
5. **Fail soft.** Selector lookups get fallback chains; a missing element becomes a
   warning, never an exception that kills an export.

## What is most useful

- **Selector fixes.** WhatsApp Web ships obfuscated, rotating markup. When a selector
  stops matching, the few structural hooks in `src/content/extractor.js` need updating.
  Include the output of the popup's **Diagnostics** panel and, if possible, a minimal
  HTML snippet of the new structure with message content redacted.
- **Locale/timestamp bugs.** WhatsApp renders dates differently per language. Add a test
  case in `test/datetime.test.mjs` with the exact `data-pre-plain-text` string.
- **Accessibility and keyboard support** in the popup.
- **Docs**: a clearer explanation, a new troubleshooting entry, a translation.

## Tests

Every behavioural change needs a test. The suites are plain Node scripts:

| File | Covers |
| --- | --- |
| `test/manifest.test.mjs` | Packaging, permissions, referenced files, icons |
| `test/datetime.test.mjs` | Timestamp parsing and date ranges |
| `test/formats.test.mjs` | HTML/TXT/JSON/CSV writers |
| `test/zip.test.mjs` | The ZIP container (CRCs validated with Python) |
| `test/extractor.test.mjs` | Scraper against the simulated DOM in `test/fixture.mjs` |
| `test/e2e.test.mjs` | Content script end to end, downloaded file checked on disk |
| `test/popup.test.mjs` | Real popup wired to the real content script |

`npm test` runs all of them. If you change the fixture DOM to match a new WhatsApp
structure, update the expected values and say so in the pull request.

## Pull requests

- One logical change per pull request; describe **why**, not just what.
- Run `npm test` (and `npm run smoke:chrome` if you touched the manifest or popup page).
- Update the docs when behaviour changes: `README.md`, `docs/PROTOCOL.md`,
  `docs/TROUBLESHOOTING.md`, `CHANGELOG.md` under `## [Unreleased]`.
- If you change the visible UI, regenerate screenshots with `npm run screenshots` and
  mention it.
- Never commit `node_modules/`, `test/out/` or `dist/`.

## Commit messages

Conventional-ish prefixes are appreciated but not enforced:
`feat:`, `fix:`, `docs:`, `test:`, `chore:`. Keep the subject under ~72 characters and
use the body to explain the reasoning.

## Reporting bugs and requesting features

Use the issue templates. For anything security-related, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contribution is licensed under the project's MIT
license (see [LICENSE](LICENSE)).
