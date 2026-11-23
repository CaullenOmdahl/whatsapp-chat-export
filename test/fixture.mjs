/**
 * A realistic WhatsApp Web conversation DOM, used by the extractor tests.
 *
 * The markup mirrors the structure WhatsApp actually renders: `#main` with a header,
 * a scrollable message list of `div[role="row"]` rows, `data-id` on message nodes and
 * the localised `data-pre-plain-text` attribute. Class names are the obfuscated ones
 * WhatsApp ships today, on purpose: the scraper must not depend on them.
 */

const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const dateDivider = (label) => `
  <div role="row">
    <div class="x1n2onr6"><div class="x1rg5ohu"><span class="_11JPr" dir="auto">${esc(label)}</span></div></div>
  </div>`;

const systemRow = (text) => `
  <div role="row">
    <div class="x1n2onr6" data-testid="system-status">
      <div class="x1rg5ohu"><span class="_11JPr">${esc(text)}</span></div>
    </div>
  </div>`;

const reaction = (text) =>
  `<div data-testid="reaction-bubble" class="_aju6"><span class="_11JPr">${esc(text)}</span></div>`;

const msg = ({ id, outgoing, pre, body = '', quote = '', media = '', reactions = '', extraClass = '' }) => `
  <div role="row">
    <div class="_amk4">
      <div class="${outgoing ? 'message-out' : 'message-in'} focusable-list-item ${extraClass}" data-id="${id}">
        <div class="_amk6">
          <div class="copyable-text" data-pre-plain-text="${esc(pre)}">
            ${quote}
            <div class="_akbu"><span class="selectable-text copyable-text" dir="ltr"><span>${body}</span></span></div>
            ${media}
          </div>
          ${reactions}
        </div>
      </div>
    </div>
  </div>`;

const quoteBlock = (author, text) => `
  <div class="_aju6 quoted-mention">
    <span title="${esc(author)}" class="_11JPr">${esc(author)}</span>
    <span class="_11JPr">${esc(text)}</span>
  </div>`;

const EMOJI_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const emoji = (alt) => `<img alt="${esc(alt)}" class="emoji" src="${EMOJI_SRC}">`;

const imageMedia = (src, captionSelectable = true) => `
  <div class="_akbu" style="width:240px;height:160px">
    <img src="${src}" data-testid="media" alt="photo.jpg" class="_11JPr" width="240" height="160">
  </div>`;

const documentMedia = (fileName) => `
  <div data-testid="document-thumb" class="_akbu">
    <span title="${esc(fileName)}" class="_11JPr">${esc(fileName)}</span>
    <span dir="auto">1.2 MB</span>
  </div>`;

const voiceMedia = () => `<div data-testid="audio-play" class="x1rg5ohu"></div>`;

/**
 * A one-to-one chat as current WhatsApp renders it (2026-11): opaque data-ids and no
 * direction classes at all. The user's own messages carry their own name.
 */
export function directChatRows() {
  const row = (id, author, time, body) => `
  <div role="row">
    <div class="_amk4">
      <div class="focusable-list-item" data-id="${id}">
        <div class="copyable-text" data-pre-plain-text="${esc(`[${time}, 12/11/2023] ${author}: `)}">
          <span class="selectable-text copyable-text" dir="ltr"><span>${esc(body)}</span></span>
        </div>
      </div>
    </div>
  </div>`;
  return [
    dateDivider('12 November 2023'),
    row('3EB0D1', 'Jordan Roe', '09:15', 'Morning! Is the unit back online?'),
    row('3EB0D2', 'Sam Smith', '09:17', 'Yes, rebooted it an hour ago.'),
    row('3EB0D3', 'Jordan Roe', '09:18', 'Great, thanks.'),
  ];
}

/** Rows in chronological order. Keep in sync with tests' expected values. */
export function conversationRows() {
  return [
    dateDivider('12 November 2023'),
    systemRow('Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.'),

    msg({
      id: 'false_120363000000000000@g.us_AAA1',
      outgoing: false,
      pre: '[09:15, 12/11/2023] Alice: ',
      quote: quoteBlock('Bob', 'Are we still on for Friday?'),
      body: "Yes! Let's do 10am",
    }),

    msg({
      id: 'false_120363000000000000@g.us_AAA2',
      outgoing: false,
      pre: '[09:16, 12/11/2023] Bob: ',
      body: `Perfect.<br>I'll bring coffee ${emoji('☕')}`,
    }),

    msg({
      id: 'true_120363000000000000@g.us_AAA3',
      outgoing: true,
      pre: '[09:20, 12/11/2023] You: ',
      body: `Great ${emoji('👍')}`,
    }),

    msg({
      id: 'false_120363000000000000@g.us_AAA4',
      outgoing: false,
      pre: '[09:21, 12/11/2023] Bob: ',
      media: imageMedia('blob:https://web.whatsapp.com/9f1c2d3e-media'),
      body: "Here's the deck",
      reactions: reaction('👍 2'),
    }),

    msg({
      id: 'true_120363000000000000@g.us_AAA5',
      outgoing: true,
      pre: '[09:22, 12/11/2023] You: ',
      body: 'https://example.com/deck',
    }),

    msg({
      id: 'true_120363000000000000@g.us_AAA6',
      outgoing: true,
      pre: '[09:30, 12/11/2023] You: ',
      media: documentMedia('Q4-plan.pdf'),
    }),

    msg({
      id: 'false_120363000000000000@g.us_AAA7',
      outgoing: false,
      pre: '[09:31, 12/11/2023] Bob: ',
      media: voiceMedia(),
    }),

    dateDivider('25 December 2023'),

    msg({
      id: 'true_120363000000000000@g.us_BBB1',
      outgoing: true,
      pre: '[18:00, 25/12/2023] You: ',
      body: `Merry Christmas! ${emoji('🎄')}`,
    }),

    msg({
      id: 'false_120363000000000000@g.us_BBB2',
      outgoing: false,
      pre: '[18:01, 25/12/2023] Bob: ',
      body: '<span><em>This message was deleted</em></span>',
      extraClass: 'x1n2onr6',
    }),

    msg({
      id: 'false_120363000000000000@g.us_BBB3',
      outgoing: false,
      pre: '[18:02, 25/12/2023] Bob: ',
      body: 'See you in January.<br><br>Happy holidays!',
    }),
  ];
}

/** Older rows, prepended while the test simulates loading history by scrolling up. */
export function olderRows(tag = '') {
  return [
    msg({
      id: 'false_120363000000000000@g.us_OLD1' + tag,
      outgoing: false,
      pre: '[11:00, 05/11/2023] Carol: ',
      body: 'Kicking off the design review thread.',
    }),
    msg({
      id: 'true_120363000000000000@g.us_OLD2' + tag,
      outgoing: true,
      pre: '[11:05, 05/11/2023] You: ',
      body: 'Thanks Carol, adding the deck now.',
    }),
  ];
}

export function buildFixtureHtml({ rows = conversationRows(), older = [], overflow = 'auto', title = 'Design Team' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>WhatsApp</title></head>
<body>
  <div id="app">
    <div class="two">
      <div id="side">
        <div role="listitem" data-testid="cell-frame-container" data-id="false_120363000000000000@g.us">
          <span dir="auto" title="Design Team">Design Team</span>
        </div>
      </div>
      <div id="main">
        <header>
          <div class="_amk4"><div class="_amk6">
            <div dir="auto" role="button">
              <span dir="auto" title="${esc(title)}" class="_11JPr">${esc(title)}</span>
            </div>
          </div></div>
          <div class="_amk4"><span dir="auto" title="online" class="_11JPr">online</span></div>
        </header>
        <div id="msg-scroller" style="overflow-y:${overflow};height:600px">
          <div role="application" class="x1n2onr6">
            ${older.join('\n')}
            ${rows.join('\n')}
          </div>
        </div>
        <footer>
          <div contenteditable="true" role="textbox" aria-label="Type a message"></div>
        </footer>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/** A page without an open conversation, like WhatsApp right after loading. */
export function buildEmptyFixtureHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"></head>
<body>
  <div id="app">
    <div class="two">
      <div id="side"></div>
      <div id="main">
        <div class="x1n2onr6 x1iyjqo2 x6ikm8r">
          <div class="x1n2onr6"><span>WhatsApp Web</span></div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;
}
