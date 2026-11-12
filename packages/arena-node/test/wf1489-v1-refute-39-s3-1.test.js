// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 / #1533 refute, skeptic 3 (second copies: the owner page on the Arena site reads the seats' address book too).
// pages/owner.html siteBase (kanban #668, #809, #1432) finds the owner's node ONLY by its key in the seats' GET /address-announcements
// (or local= on the same machine). A node just installed on a remote server has no bond yet, so it is in no census: since #1533 every
// seat that has read its census refuses its announcement (409), and the link the installer hands the owner (FinishSteps ownerSite:
// OWNER_SITE#node=<key>, no local=) never finds the node - the owner cannot reach the page where the first bond is set up (#728).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { createAddressBook } from '../src/address-book.js';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const block = (start) => { const a = HTML.indexOf(start); assert.ok(a >= 0, start); let i = HTML.indexOf('{', a), d = 0; for (; i < HTML.length; i++) { if (HTML[i] === '{') d++; else if (HTML[i] === '}' && !--d) break; } return HTML.slice(a, i + 1); };
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const json = (v) => ({ ok: true, json: async () => v });
const T0 = Date.now();

test('a new remote node, not bonded yet, is found by the owner page on the site through the seats', async () => {
  // a seat whose census is read: three bonded seats
  const census = new Set([1, 2, 3].map(() => Buffer.from(schnorr.getPublicKey(new Uint8Array(randomBytes(32)))).toString('hex')));
  const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify, nowMs: () => Date.now(), isCensusNode: (hex) => census.has(String(hex)) });
  // the owner's node, installed on a remote server a minute ago: its quick tunnel, announced to the census seats (announceOwn)
  const s = new Uint8Array(randomBytes(32)); const KEY = Buffer.from(schnorr.getPublicKey(s)).toString('hex');
  const AT = 'https://fresh-remote-node.trycloudflare.com';
  const r = book.take(signAddressAnnouncement({ node: KEY, endpoint: AT, atMs: T0 - 1000 }, (d) => schnorr.sign(d, s)));
  console.log(`POST /address-announcement of the unbonded node: ${JSON.stringify(r)}`);
  const fetcher = async (url) => {
    if (url === '/daily.json') return json({ testnet: { node: ['https://seat-1'] } });
    // the seat's GET /address-announcements (server.js, kanban #2066: ?node=<key> also answers that key's announcement held outside the census)
    const u = new URL(url, 'https://site.example');
    if (u.origin + u.pathname === 'https://seat-1/address-announcements') {
      const node = /^[0-9a-f]{64}$/i.test(u.searchParams.get('node') || '') ? u.searchParams.get('node').toLowerCase() : null;
      return json({ announcements: node ? book.list({ node }).filter((a) => a.node === node) : book.list() });
    }
    if (url === AT + '/owner/version') return { ok: true };
    throw new Error('not asked here: ' + url);
  };
  const siteBase = new Function('fetch', 'HASH', 'NODE_KEY', 'boot', `${block('async function siteBase()')}; return siteBase;`)(fetcher, new URLSearchParams(''), KEY, () => {});
  const found = await siteBase();
  console.log(`the owner page on the site finds the node at: ${found}`);
  assert.equal(found, AT, 'the owner page on the site cannot find a new node before its bond: the first bond cannot be set up from the link the installer gives');
  // kanban #2066: census-only stays in force everywhere else - not in the plain list (what other seats pull), not an endpoint, and moved
  // into the book once the census names the node (its first bond)
  assert.equal(book.list().some((x) => x.node === KEY), false, 'the unbonded node is in the plain list other seats pull');
  const entry = { pubkey: Buffer.from(KEY, 'hex'), advert: { endpoint: 'https://census.example', timestamp: 0 } };
  assert.equal(book.endpointOf(entry), 'https://census.example');
  census.add(KEY); book.prune();
  assert.equal(book.list().some((x) => x.node === KEY), true, 'bonded, the node is in the book');
  assert.equal(book.endpointOf(entry), AT);
});

test('the bucket for nodes outside the census holds at most ADDRESS_PENDING_MAX, the oldest announced goes first', async () => {
  const { ADDRESS_PENDING_MAX } = await import('../src/address-book.js');
  const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify, nowMs: () => Date.now(), isCensusNode: () => false });
  const keys = [];
  for (let i = 0; i < ADDRESS_PENDING_MAX + 20; i++) {
    const s = new Uint8Array(randomBytes(32)); const k = Buffer.from(schnorr.getPublicKey(s)).toString('hex'); keys.push(k);
    assert.equal(book.take(signAddressAnnouncement({ node: k, endpoint: 'https://n' + i + '.example', atMs: T0 - 1000 }, (d) => schnorr.sign(d, s))).status, 409);
  }
  assert.equal(book.list({ node: keys[0] }).length, 0, 'the oldest was dropped');
  assert.equal(book.list({ node: keys.at(-1) }).length, 1);
  assert.equal(book.list().length, 0);
});
