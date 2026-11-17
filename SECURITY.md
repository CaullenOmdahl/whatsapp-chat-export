# Security policy

## Supported versions

The latest release on the `main` branch is the only supported version. There are no
backports.

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |
| < 1.0 | No |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: go to the repository's **Security** tab →
**Report a vulnerability**. If that is unavailable, contact the maintainer through their
GitHub profile and ask for a private channel.

Please include:

- what the issue lets an attacker do,
- the affected version and browser,
- reproduction steps or a proof of concept,
- any suggested fix.

You can expect an acknowledgement within a few days. Fixes are shipped as a patch
release and the reporter is credited in the release notes unless they ask otherwise.

## What counts as a security issue here

The extension has an unusually small attack surface on purpose: it makes no network
requests, runs no remote code, and has no server. Reports are welcome for:

- **Chat data leaving the browser.** Any code path that could transmit message content,
  filenames or metadata off the device.
- **Injection into the exported file.** A crafted message (for example a filename or a
  quoted reply) escaping into the generated HTML/CSV and executing when the export is
  opened. The writers are expected to escape everything; a bypass is a real bug.
- **ZIP path traversal or file overwrite** through a crafted media filename.
- **Permission escalation.** A change that needs more than `storage`, `scripting`,
  `activeTab` and the WhatsApp host permission.
- **Cross-origin data access.** Reading or writing anything outside
  `https://web.whatsapp.com/*`.
- **Supply chain.** Any new runtime dependency, build script that executes on install, or
  GitHub Action pinned by tag instead of commit SHA in a release path.

## What is not a security issue

- A WhatsApp Web UI change that stops the scraper from finding messages. That is a
  functional bug; use the **bug report** template and include the Diagnostics output.
- Media that cannot be captured because WhatsApp never rendered it.
- Chrome warnings about the extension's permissions; they are documented in
  [PRIVACY.md](PRIVACY.md) and the store listing.
- The extension being unable to export a chat you cannot open in WhatsApp Web.

## Threat model, briefly

The extension trusts the WhatsApp Web page only as far as it must: it reads the DOM of
the conversation you have open and writes a local file. It does not trust message text —
everything is escaped on the way into the export formats — and it never evaluates page
content. The main risks it is designed against are (1) message content escaping into an
executable HTML context, and (2) accidental exfiltration through future changes. Both are
covered by tests (`test/formats.test.mjs`, `test/zip.test.mjs`, `test/manifest.test.mjs`).
