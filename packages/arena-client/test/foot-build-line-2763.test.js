// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2763 (feedback #062/#067): over a game's own client the foot's "UI n" line ends left of the social links - its padding was counted for four
// links (100 + 4 x 24 + 3 x 6 = 214, the line at 230) and a fifth (Nostr) came: the X icon sat on "UI 668" at 1280x900. The padding is held here to the
// links the page carries, 24 px each, 6 px apart, from right 100 (right 198 with the top-up button), and 16 px of air.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const pad = (re) => { const m = re.exec(html); assert.ok(m, `the page holds ${re}`); return Number(m[1]); };

test('kanban #2763: the foot\'s UI line ends left of every social link, with and without the top-up button', () => {
  const social = html.slice(html.indexOf('<div id="arena-social" class="arena-social">'), html.indexOf('</div>', html.indexOf('<div id="arena-social" class="arena-social">')));
  const n = (social.match(/<a /g) || []).length;
  assert.ok(n >= 5, `${n} links`);
  const edge = (right) => right + n * 24 + (n - 1) * 6 + 16;
  assert.ok(pad(/html body\.arena-own-client #arena-build \{[^}]*padding-right: (\d+)px/) >= edge(100), `the line ends at ${edge(100)} or further left`);
  assert.ok(pad(/html body\.arena-topup-on #arena-build \{ padding-right: (\d+)px/) >= edge(198), `with the top-up button: ${edge(198)} or further left`);
});
