// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1386 (audit 2 #1204 RES-7): the census signer's door is anyone's, and an outsider re-sending valid requests (public data; a liquidation escrow's
// digest varies by its load height) held every session of a key - every holder answered "busy" to the real filer. A filer now signs its ask with its
// census node key; a holder counts a census node's sessions per asker, keeps unsigned asks in a small pool and lets the oldest of them go for a signed ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { createCensusSigner, gatherCensusSignature, signAsk, ASK_LIMITS } from '../src/census-sign.js';
import { censusKeyWork } from '../src/census-key-work.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { encodeCensusKeyRecord } from '../../arena-protocol/src/census-key.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const toScalar = (b) => BigInt(`0x${toHex(b)}`) % N;
const secret = (n) => taggedHash('ARENA/test/CensusSignAsker', Uint8Array.of(n));
let a0 = toScalar(secret(1));
if (secp256k1.getPublicKey(secret(1), true)[0] === 3) a0 = N - a0;
const co = [a0, toScalar(secret(2)), toScalar(secret(3)), toScalar(secret(4))];
const share = (x) => co.reduce((sum, c, i) => (sum + c * BigInt(x) ** BigInt(i)) % N, 0n);
const publicKey = schnorr.getPublicKey(secret(1));
const digestOf = (n) => taggedHash('ARENA/test/CensusSignAsker', Uint8Array.of(100 + n));
const record = encodeCensusKeyRecord({ networkId: new Uint8Array(32), epoch: 1, publicKey, censusHeight: 100, totalShares: 6, threshold: 4, transcriptHash: new Uint8Array(32) });
const FILER = { sk: secret(50), node: toHex(schnorr.getPublicKey(secret(50))) };
const census = new Set([FILER.node]);
const asker = { node: FILER.node, sign: (d) => schnorr.sign(d, FILER.sk) };
const holder = (n, xs, over = {}) => {
  const signer = createCensusSigner({ key: schnorr.getPublicKey(secret(10 + n)), work: censusKeyWork, held: () => ({ shares: new Map(xs.map((x) => [x, share(x)])), record }),
    check: async (r) => { if (r && r.asker) throw new Error('the check was handed the asker'); return { ok: true, digest: digestOf((r && r.d) || 0), publicKey }; },
    isAsker: (node) => census.has(node), ...over });
  return { url: `http://h${n}`, signer };
};
const wire = (holders) => async (url, init) => {
  const h = holders.find((x) => url.startsWith(x.url));
  const body = JSON.parse(init.body);
  const answer = url.endsWith('/commit') ? await h.signer.takeCommit(body) : await h.signer.takeShare(body);
  return { json: async () => answer };
};

test('#1386 unsigned asks over many digests fill only their pool; the census node\'s signed ask is still taken, and the key still signs', async () => {
  const hs = [holder(1, [1, 2]), holder(2, [3, 4]), holder(3, [5, 6])];
  // the outsider: valid requests, 8 load heights, re-sent - never a share asked
  let outsiderOpened = 0, outsiderRefused = 0;
  for (const h of hs) for (let i = 0; i < 64; i += 1) { const c = await h.signer.takeCommit({ d: i % 8 }); if (c.ok) outsiderOpened += 1; else outsiderRefused += 1; }
  console.log(`  MEASURED #1386: outsider 192 asks -> ${outsiderOpened} sessions, ${outsiderRefused} refused; holders hold ${hs.map((h) => h.signer.sessions()).join('/')}`);
  assert.ok(hs.every((h) => h.signer.sessions() <= ASK_LIMITS.anonymousPerKey), 'unsigned asks held more than their pool');
  // the real filer, signed: gathers the key's signature through the same holders
  const got = await gatherCensusSignature({ request: { d: 3 }, digest: digestOf(3), publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: wire(hs), asker });
  assert.equal(got.ok, true, got.why);
  assert.equal(schnorr.verify(got.signature, digestOf(3), publicKey), true);
  // the same, unsigned, while the pool is full: refused as busy by every holder
  const anon = await gatherCensusSignature({ request: { d: 3 }, digest: digestOf(3), publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: wire(hs) });
  assert.equal(anon.ok, false);
  assert.match(anon.refused.map((r) => r.why).join(' | '), /unsigned signing sessions open/);
});

test('#1386 a signed ask from a key outside the census, a stale one or a forged one counts as unsigned; a census node is capped per key on its own', async () => {
  const h = holder(1, [1, 2]);
  const stranger = { node: toHex(schnorr.getPublicKey(secret(77))), sign: (d) => schnorr.sign(d, secret(77)) };
  for (let i = 0; i < ASK_LIMITS.anonymousPerKey; i += 1) assert.equal((await h.signer.takeCommit(signAsk({ d: i }, stranger))).ok, true);
  assert.match((await h.signer.takeCommit(signAsk({ d: 9 }, stranger))).why, /unsigned signing sessions open for that key/);
  const stale = signAsk({ d: 9 }, asker, Date.now() - 11 * 60000);
  assert.match((await h.signer.takeCommit(stale)).why, /unsigned/);
  const forged = { ...signAsk({ d: 9 }, asker), d: 10 };
  assert.match((await h.signer.takeCommit(forged)).why, /unsigned/);
  // the census node: its own cap per key, unaffected by the strangers, and past it refused by name
  let mine = 0;
  for (let i = 0; i < 40; i += 1) { const c = await h.signer.takeCommit(signAsk({ d: 20 + (i % 8) }, asker)); if (c.ok) mine += 1; else assert.match(c.why, /from you/); }
  assert.equal(mine, ASK_LIMITS.perAskerKey);
});

test('#1386 without a census to ask (isAsker not given) the holder counts every ask as before', async () => {
  const h = holder(1, [1, 2], { isAsker: null });
  let opened = 0;
  for (let i = 0; i < 40; i += 1) if ((await h.signer.takeCommit(signAsk({ d: i % 16 }, asker))).ok) opened += 1;
  assert.equal(opened, 32, 'the old per-key cap');
});
