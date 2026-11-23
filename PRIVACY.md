# Privacy Policy — Chat Export for WhatsApp

**Effective date:** 2026-11-24
**Applies to:** the browser extension "Chat Export for WhatsApp" (version 1.1.0 and later) for Chromium-based browsers.

## The short version

Chat Export for WhatsApp collects **nothing**. It has no account system, no server, no analytics, no telemetry, no cookies and no third-party services. Your conversations are read from the WhatsApp Web page that is already open in your browser and are turned into a file that is saved to your own computer. Nothing is uploaded anywhere. The one network activity is optional: when you choose to download media, WhatsApp's own code downloads it from WhatsApp's servers (see below).

## What the extension stores

The extension uses `chrome.storage.local`, which is storage managed by your browser on your own device. It stores only:

1. **Your settings** — the format, date range, media handling, and include/exclude toggles you chose, so the popup remembers them next time.
2. **A local export history** — a list of your last five exports (chat name, format, time, message count and file size) so the popup can show recent activity. You can clear it by removing the extension, or by clearing the extension's data from your browser's extension settings.

While an export is running, live progress is mirrored to `chrome.storage.session` (in-memory browser session storage) so that closing and reopening the popup does not lose the progress bar. That data is discarded when the browser session ends.

Nothing in the extension's storage is synced, uploaded or shared.

## What happens to your chat data

- Message text, sender names, timestamps, reactions and media are read from WhatsApp Web's own in-memory message store for the open chat, **inside your browser tab**. If that is not possible, they are read from the rendered page instead.
- They are assembled into an HTML, TXT, JSON or CSV file (and, when media download is enabled, a single `.zip` containing the report plus the capturable media) **in memory**.
- The file is handed to your browser's normal download mechanism and saved to your computer.
- The extension's own code makes **no network requests**. It has no `fetch` of remote URLs, no XHR and no WebSocket, and contains no remote URLs. There is no remote logging and no crash reporting.
- **Media download.** Only when the Media option is set to *Download*, the extension asks WhatsApp Web's own download manager to download and decrypt each photo, video, voice note, sticker and document in the exported range. WhatsApp's code fetches them from WhatsApp's media servers, the same way it does when you open a photo, including media you never opened. With *Placeholders* or *None*, no media is downloaded.
- The extension sends nothing to its authors or any third party. The only network requests are the ones WhatsApp's own code makes for the media download described above.

## What the extension does **not** do

- It does not read or export chats you have not opened. It only reads the conversation currently open in the active WhatsApp Web tab.
- It does not bypass WhatsApp's end-to-end encryption or access any server-side message store. It reads what WhatsApp Web has already loaded in your browser, and media downloads go through WhatsApp's own download manager.
- It does not sell, rent, share or transmit your data to anyone.
- It does not use cookies, fingerprinting, advertising identifiers, or cross-site tracking.
- It does not execute remote code. All code is shipped inside the extension package.

## Permissions and why they exist

| Permission | Why it is needed |
| --- | --- |
| `storage` | Save your settings and the five-entry local export history; mirror live progress so it survives the popup closing. |
| `scripting` | Inject the content script, and the page bridge that reads WhatsApp's message store, into an already-open WhatsApp Web tab when the popup triggers an export. |
| `activeTab` | Act on the tab you are currently viewing, only after you click the extension icon. |
| Host access to `https://web.whatsapp.com/*` | Read the conversation displayed on WhatsApp Web. This is the only site the extension runs on. |

The extension requests no other permissions.

## Third parties

None. The extension includes no third-party SDKs, fonts, analytics, crash reporters or advertising components. No data is shared with third parties because the extension transmits nothing; the only network activity is WhatsApp's own media download described above.

## Children

The extension is a general-purpose utility and is not directed at children. It collects no personal information from anyone.

## Changes to this policy

If a future version changes how data is handled, this document will be updated and the effective date changed, and the change will be noted in [CHANGELOG.md](CHANGELOG.md). The extension's core promise — local processing only, nothing uploaded — is intended to remain permanent.

## Contact

Questions about this policy: **your-email-here**

> *Maintainers: replace `your-email-here` with a real contact address before publishing to the Chrome Web Store. The policy above is accurate for version 1.1.0 as shipped.*

## Related documents

- [README.md](README.md) — what the extension does and how to install it.
- [docs/STORE.md](docs/STORE.md) — Chrome Web Store listing and permission justifications.
- [LICENSE](LICENSE) — MIT license terms.
