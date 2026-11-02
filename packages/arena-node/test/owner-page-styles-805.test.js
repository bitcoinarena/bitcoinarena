// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE STYLES WHAT ITS REACT SCREENS DRAW (kanban #805, 2026-10-30 after 2026.1.9.19: the uptime showed as plain lines, "We said
// tiles, right?"): owner.html does not load arena-web's arena.css - its styles are its own - so the tile classes the new UptimePanel and the
// Overview draw must be in its <style>; 9.19 shipped them only in arena.css and the tiles fell apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const bundle = readFileSync(new URL('../../arena-web/dist/owner.js', import.meta.url), 'utf8');

test('every tile class the owner bundle draws has a rule in the owner page\'s own styles', () => {
  for (const cls of ['up-tiles', 'up-tile', 'up-win', 'up-pct', 'up-bar', 'up-warn', 'up-why', 'si', 'glance']) {
    assert.ok(bundle.includes(cls), `the bundle draws .${cls}`);
    assert.match(style, new RegExp(`\\.${cls}\\b`), `owner.html styles .${cls}`);
  }
  assert.match(style, /\.pill\.bad\b/, 'the "Below inclusion" pill');
  assert.doesNotMatch(html, /<link[^>]*stylesheet|['"][^'"]*(arena|react)\.css['"]/, 'the page loads no other stylesheet - if it ever does, this test is moot');
});
