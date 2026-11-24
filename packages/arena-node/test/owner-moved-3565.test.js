// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE THAT MOVED, ON THE SITE'S OWNER PAGE (kanban #3565, an outside operator 2026-11-24: switched to Tailscale Funnel, the site found only
// the quick tunnel's old address and said "This node did not answer: Failed to fetch" and nothing more): where it was asked, what to do now
// (try again once the node announced its new address, or open the owner page on the node itself), and a Try again button - on the site only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');

function run(onSite) {
  const fn = HTML.slice(HTML.indexOf('function movedHint()'), HTML.indexOf('\nasync function start()'));
  const added = [];
  const els = new Map();
  const document = {
    getElementById: (id) => els.get(id) || null,
    createElement: (tag) => ({ tag, set id(v) { this._id = v; els.set(v, this); }, get id() { return this._id; } }),
  };
  const $ = (id) => (id === 'who' ? { after: (...n) => added.push(...n) } : null);
  const location = { reload: () => added.push('reloaded') };
  new Function('document', '$', 'location', 'ON_SITE', 'BASE', `${fn}\nmovedHint(); movedHint();`)(document, $, location, onSite, 'https://realistic-ecology-municipal-modified.trycloudflare.com');
  return added;
}

test('on the site, a node that does not answer: where it was asked, how to go on, and Try again - once', () => {
  const added = run(true);
  assert.equal(added.length, 2, 'a hint and a button, not twice');
  assert.match(added[0].textContent, /asked at https:\/\/realistic-ecology-municipal-modified\.trycloudflare\.com, the address it last announced/);
  assert.match(added[0].textContent, /new address followed by \/Dashboard\/owner\?here/);
  assert.equal(added[1].textContent, 'Try again');
  added[1].onclick();
  assert.equal(added[2], 'reloaded');
  assert.deepEqual(run(false), [], 'on the node itself there is nothing to look up');
  const start = HTML.slice(HTML.indexOf('async function start()'));
  assert.match(start, /catch \(e\) \{ movedHint\(\); \$\('who'\)\.textContent = 'This node did not answer: ' \+ e\.message; loadEnd\(\); return; \}/);
});
