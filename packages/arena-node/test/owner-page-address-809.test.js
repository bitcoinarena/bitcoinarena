// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE FINDS THE NODE AT ITS NEWEST ADDRESS THAT ANSWERS, AND SAYS WHAT IT WAITS FOR (kanban #809, the owner 2026-10-30 after
// 2026.1.9.20: "After startup of .20 it shows loading for a really really long time. There should be a progress bar" - it loaded after
// 2-3 minutes). test host seats 1 and 2, outside the census the node announces to, still named its quick tunnel of 10:14Z, gone since a
// restart; they answered first, the page took the first answer and asked that dead address until the browser gave up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const block = (start) => { const a = HTML.indexOf(start); assert.ok(a >= 0, start); let i = HTML.indexOf('{', a), d = 0; for (; i < HTML.length; i++) { if (HTML[i] === '{') d++; else if (HTML[i] === '}' && !--d) break; } return HTML.slice(a, i + 1); };
const KEY = 'b3'.repeat(32);
const OLD = 'https://choose-ellis-nextel-reliance.trycloudflare.com', NEW = 'https://burton-charms-twenty-endorsed.trycloudflare.com';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (v) => ({ ok: true, json: async () => v });

// siteBase from the page, with its fetch, the hash, the key and the bar given here
function siteBaseWith(fetcher, { boots = [] } = {}) {
  const f = new Function('fetch', 'HASH', 'NODE_KEY', 'boot', `${block('async function siteBase()')}; return siteBase;`);
  return f(fetcher, new URLSearchParams(''), KEY, (pct, step) => boots.push(step));
}

test('the newest address that answers wins, not the first seat to answer with an old one', async () => {
  const asked = [];
  const fetcher = async (url, opt = {}) => {
    asked.push(url);
    if (url === '/daily.json') return json({ testnet: { node: ['https://seat-1', 'https://seat-2', 'https://seat-5'] } });
    if (url === 'https://seat-1/address-announcements') return json({ announcements: [{ node: KEY, endpoint: OLD, atMs: 1000 }] });
    if (url === 'https://seat-2/address-announcements') return json({ announcements: [{ node: KEY, endpoint: OLD, atMs: 1000 }] });
    if (url === 'https://seat-5/address-announcements') { await wait(300); return json({ announcements: [{ node: KEY, endpoint: NEW, atMs: 2000 }] }); }
    if (url === NEW + '/owner/version') return { ok: true };
    if (url === OLD + '/owner/version') { await new Promise((r, no) => opt.signal && opt.signal.addEventListener('abort', () => no(new Error('aborted')))); }
    throw new Error('not asked here: ' + url);
  };
  const boots = [];
  const t0 = Date.now();
  assert.equal(await siteBaseWith(fetcher, { boots })(), NEW);
  assert.ok(Date.now() - t0 < 5000, `found in ${Date.now() - t0} ms, not minutes`);
  assert.ok(!asked.includes(OLD + '/owner/version'), 'the old address is not even tried once the newer one answers');
  assert.ok(boots.some((s) => /^Reaching your node at burton-charms/.test(s)), 'the bar says which address it tries');
});

test('a newest address that does not answer falls back to an older one that does; none answering gives the newest', async () => {
  const fetcher = (versionOk) => async (url, opt = {}) => {
    if (url === '/daily.json') return json({ testnet: { node: ['https://seat-1', 'https://seat-5'] } });
    if (url === 'https://seat-1/address-announcements') return json({ announcements: [{ node: KEY, endpoint: OLD, atMs: 1000 }] });
    if (url === 'https://seat-5/address-announcements') return json({ announcements: [{ node: KEY, endpoint: NEW, atMs: 2000 }] });
    if (url.endsWith('/owner/version')) { if (versionOk(url)) return { ok: true }; throw new Error('530'); }
    throw new Error('not asked here: ' + url);
  };
  assert.equal(await siteBaseWith(fetcher((u) => u.startsWith(OLD)))(), OLD);
  assert.equal(await siteBaseWith(fetcher(() => false))(), NEW);
});

test('the page shows a bar with its step and seconds, not one word, until the node is shown', () => {
  assert.match(HTML, /<div class="sub" id="who"><div class="boot" id="boot"><span class="boot-bar"><i id="boot-i"/);
  assert.doesNotMatch(HTML, /id="who">loading…</);
  for (const step of ['Loading the owner screens', 'Asking your node', 'Signing in']) assert.ok(HTML.includes(`'${step}'`), step);
  assert.match(HTML, /\.boot-bar\{/, 'its own styles');
});
