# Releasing

This is the checklist for cutting a release and submitting it to the Chrome Web Store. The
extension has no build step; "release" means packaging the source that is already in the repo.

## Versioning

Semantic versioning, applied to the extension's behaviour:

| Change | Bump |
| --- | --- |
| Selector fix, wording, bug fix with no API change | **patch** (1.0.x) |
| New format, new option, new export capability | **minor** (1.x.0) |
| Manifest/permissions change, storage schema break, anything that needs user action | **major** (x.0.0) |

The version lives in three places and they must agree:

1. `manifest.json` → `"version"`
2. `package.json` → `"version"`
3. `CHANGELOG.md` → the new `## [x.y.z] — YYYY-MM-DD` heading

`npm run build -- --verify-tag vX.Y.Z` fails if the git tag and the manifest disagree.

## Before tagging

```bash
npm ci
npm run lint          # static rules: permissions, no network, no innerHTML, manifest contract
npm test              # 8 suites
npm run smoke:chrome  # real Chrome: manifest loads, popup renders, content script injects
npm run build         # dist/whatsapp-chat-export-vX.Y.Z.zip
```

Manual pass on a real WhatsApp account (the test suite cannot cover these):

- [ ] Export a short direct chat and a large group chat.
- [ ] Every format opens: HTML in a browser, CSV in a spreadsheet, JSON parses, TXT reads cleanly.
- [ ] Media download produces a `.zip` whose report references `media/` files that exist.
- [ ] Cancel mid-export: nothing downloads, chat scroll position is restored.
- [ ] Close the popup mid-export: export completes, reopening shows the result.
- [ ] Reopen an hour later: the old success panel is not resurrected.
- [ ] A date range in the past only contains messages inside it.
- [ ] Diagnostics panel shows non-zero matches for every selector.
- [ ] Test at least one non-English WhatsApp UI language (timestamp parsing is locale-dependent).

## Tag and release

```bash
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

The [release workflow](../.github/workflows/release.yml) then verifies the tag, runs lint and the
test suite, builds the zip and publishes a GitHub release with the archive attached.

## Chrome Web Store submission

One-time setup:

1. Register a Chrome Web Store developer account (<https://chrome.google.com/webstore/devconsole>,
   one-off US$5 fee) and verify the contact email.
2. Publish the privacy policy at a stable public URL. The easiest option is to enable GitHub Pages
   for this repository and point the store at `https://<owner>.github.io/whatsapp-chat-export/PRIVACY.html`,
   or serve `PRIVACY.md`; a raw GitHub link also works but looks less trustworthy. The URL must not
   require a login.
3. Add the store screenshots from `docs/store/` (see [STORE.md](STORE.md)) and the promo tile.

For every submission:

- [ ] `dist/whatsapp-chat-export-vX.Y.Z.zip` built from a clean `main` checkout
- [ ] Zip contents reviewed (`unzip -l`): only `manifest.json`, `src/`, `icons/`, `README.md`,
      `LICENSE`, `PRIVACY.md`, `CHANGELOG.md`
- [ ] Listing text matches [STORE.md](STORE.md); screenshots regenerated if the UI changed
- [ ] Privacy tab answers match [PRIVACY.md](../PRIVACY.md): no data collected, no remote code
- [ ] Permission justifications (from STORE.md) pasted for each permission
- [ ] Single-purpose statement: "explicitly export the conversation the user has open in WhatsApp
      Web to a local file"
- [ ] Trademark disclaimer present in the listing footer
- [ ] Version number is higher than the currently published one
- [ ] "Publish" or "Submit for review" chosen; deferred publishing is fine if you want to pick a date

Review usually takes one to several business days. Extensions that request host permissions on a
consumer site are sometimes reviewed by a human, so keep the "How to test" notes for reviewers in
[STORE.md](STORE.md) up to date.

## After release

- [ ] Confirm the store listing renders correctly (icon, screenshots, privacy link).
- [ ] Confirm install → open WhatsApp Web → export works from the *published* build, not the
      unpacked folder.
- [ ] Add the version to the GitHub release notes and close the milestone.
- [ ] If something is wrong: fix forward with a patch release. The store allows unpublishing, but
      users who already installed keep the old version until an update ships.

## Security updates

For a reported vulnerability, ship a patch release without waiting for the next train, and mention
it in `SECURITY.md`'s supported-versions table and the release notes. Do not disclose details until
the update is published.
