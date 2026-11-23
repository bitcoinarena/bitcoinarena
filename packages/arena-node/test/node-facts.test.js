// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A NODE SAYS ABOUT ITSELF (kanban #984): signed, newest kept, readable after it went offline, and it carries no address or secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createNodeFactsBook, measureFacts, measureBandwidth, measureOrigin, signFacts, PROBE_BYTES, FACTS_KEEP_GAP_MS } from '../src/node-facts.js';

const secret = new Uint8Array(32).fill(3), pubkey = schnorr.getPublicKey(secret);
const sign = (d) => schnorr.sign(d, secret), verify = (s, m, k) => schnorr.verify(s, m, k);
const book = (over = {}) => { let now = 1000000; const b = createNodeFactsBook({ db: new DatabaseSync(':memory:'), verify, nowMs: () => now, ...over }); return { b, at: (n) => { now = n; } }; };
const said = (atMs, facts = { cores: 12, ramMb: 36000 }) => signFacts({ node: pubkey, atMs, facts, sign });

test('a record of its own node is kept, the newest stands, and it stays with its age once the node is gone', () => {
  const { b, at } = book();
  assert.deepEqual(b.offer(said(1000)), { ok: true, kept: true });
  assert.deepEqual(b.offer(said(500)), { ok: true, kept: false });
  assert.equal(b.offer(said(2000, { cores: 8 })).kept, false, 'one too soon after the held one is not kept (kanban #2425)');
  assert.equal(b.offer(said(1000 + FACTS_KEEP_GAP_MS, { cores: 8 })).kept, true);
  at(1000000 + 7200000);
  const [r] = b.list();
  assert.equal(r.record.facts.cores, 8);
  assert.ok(r.ageS >= 7200, 'its age is said');
});

test('a forged record, a changed figure, a future date and an unbonded node are refused', () => {
  const { b } = book({ isBonded: () => true });
  const s = said(1000);
  assert.match(b.offer({ ...s, record: { ...s.record, facts: { cores: 99 } } }).why, /not signed/);
  assert.match(b.offer(said(1000000 + 3600000)).why, /future/);
  assert.match(book({ isBonded: () => false }).b.offer(said(1000)).why, /no bond/);
  assert.match(b.offer(said(1000, { pad: 'x'.repeat(2000) })).why, /too large/);
});

test('a seat that reads no census yet refuses nobody', () => {
  assert.equal(book({ isBonded: () => null }).b.offer(said(1000)).ok, true);
});

test('the measured facts name the machine, and nothing that points at it', () => {
  const f = measureFacts({ release: '2026.1.9.21', once: { cores: 12, country: 'AR', colo: 'EZE', bandwidthMbps: 40 } });
  assert.ok(f.cores > 0 && f.ramMb > 0);
  assert.deepEqual(Object.keys(f).sort(), ['arch', 'bandwidthMbps', 'colo', 'commit', 'cores', 'country', 'cpu', 'kernel', 'os', 'freeRamMb', 'guardian', 'load', 'node', 'platform', 'ramMb', 'release', 'roles', 'uptimeS'].sort());
});

test('the bandwidth is the middle of the peers that answered', async () => {
  const fetcher = async (u) => { if (u.includes('dead')) throw new Error('no'); return new Response(new Uint8Array(PROBE_BYTES)); };
  let t = 0;
  const v = await measureBandwidth(['http://a', 'http://dead', 'http://b'], { fetcher, nowMs: () => (t += 100) });
  assert.equal(v, 80);
  assert.equal(await measureBandwidth(['http://dead'], { fetcher }), null);
});

test('cores, country and bandwidth are measured once and kept; a value not read is tried again', async () => {
  const { b } = book(); let asked = 0;
  assert.equal(await b.once('country', async () => { asked++; return null; }), null);
  assert.equal(await b.once('country', async () => { asked++; return 'DE'; }), 'DE');
  assert.equal(await b.once('country', async () => { asked++; return 'FR'; }), 'DE');
  assert.equal(asked, 2);
});

test('the origin is the country and the data centre of the trace, and the address goes nowhere', async () => {
  const fetcher = async () => new Response('fl=1\nip=203.0.113.9\ncolo=EZE\nloc=AR\nwarp=off\n');
  const got = await measureOrigin({ fetcher });
  assert.deepEqual(got, { country: 'AR', colo: 'EZE' });
  assert.ok(!JSON.stringify(got).includes('203.0.113.9'));
  assert.equal(await measureOrigin({ fetcher: async () => { throw new Error('no'); } }), null);
});
