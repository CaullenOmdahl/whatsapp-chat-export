# Privacy Policy — Chat Export for WhatsApp

**Effective date:** 2026-11-18
**Applies to:** the browser extension "Chat Export for WhatsApp" (version 1.0.0) for Chromium-based browsers.

## The short version

Chat Export for WhatsApp collects **nothing**. It has no account system, no server, no analytics, no telemetry, no cookies and no third-party services. Your conversations are read from the WhatsApp Web page that is already open in your browser and are turned into a file that is saved to your own computer. Chat data never leaves your browser.

## What the extension stores

The extension uses `chrome.storage.local`, which is storage managed by your browser on your own device. It stores only:

1. **Your settings** — the format, date range, media handling, and include/exclude toggles you chose, so the popup remembers them next time.
2. **A local export history** — a list of your last five exports (chat name, format, time, message count and file size) so the popup can show recent activity. You can clear it by removing the extension, or by clearing the extension's data from your browser's extension settings.

While an export is running, live progress is mirrored to `chrome.storage.session` (in-memory browser session storage) so that closing and reopening the popup does not lose the progress bar. That data is discarded when the browser session ends.

Nothing in the extension's storage is synced, uploaded or shared.

## What happens to your chat data

- Message text, sender names, timestamps, reactions and media are read from the WhatsApp Web page **inside your browser tab**.
- They are assembled into an HTML, TXT, JSON or CSV file (and, when media download is enabled, a single `.zip` containing the report plus the capturable media) **in memory**.
- The file is handed to your browser's normal download mechanism and saved to your computer.
- The extension makes **no network requests**. It does not contact WhatsApp, Meta, the extension's authors, or any other service. There is no remote logging and no crash reporting.
- Some media is loaded from blob or data URLs that WhatsApp Web has already created in the page. That is local page data, not a new network request by the extension.

## What the extension does **not** do

- It does not read or export chats you have not opened. It only sees the conversation currently rendered in the active WhatsApp Web tab.
- It does not bypass WhatsApp's end-to-end encryption or access any server-side message store.
- It does not sell, rent, share or transmit your data to anyone.
- It does not use cookies, fingerprinting, advertising identifiers, or cross-site tracking.
- It does not execute remote code. All code is shipped inside the extension package.

## Permissions and why they exist

| Permission | Why it is needed |
| --- | --- |
| `storage` | Save your settings and the five-entry local export history; mirror live progress so it survives the popup closing. |
| `scripting` | Inject the content script into an already-open WhatsApp Web tab when the popup triggers an export. |
| `activeTab` | Act on the tab you are currently viewing, only after you click the extension icon. |
| Host access to `https://web.whatsapp.com/*` | Read the conversation displayed on WhatsApp Web. This is the only site the extension runs on. |

The extension requests no other permissions.

## Third parties

None. The extension includes no third-party SDKs, fonts, analytics, crash reporters or advertising components. No data is shared with third parties because no data is transmitted at all.

## Children

The extension is a general-purpose utility and is not directed at children. It collects no personal information from anyone.

## Changes to this policy

If a future version changes how data is handled, this document will be updated and the effective date changed, and the change will be noted in [CHANGELOG.md](CHANGELOG.md). The extension's core promise — local processing only, no transmission — is intended to remain permanent.

## Contact

Questions about this policy: **your-email-here**

> *Maintainers: replace `your-email-here` with a real contact address before publishing to the Chrome Web Store. The policy above is accurate for version 1.0.0 as shipped.*

## Related documents

- [README.md](README.md) — what the extension does and how to install it.
- [docs/STORE.md](docs/STORE.md) — Chrome Web Store listing and permission justifications.
- [LICENSE](LICENSE) — MIT license terms.
