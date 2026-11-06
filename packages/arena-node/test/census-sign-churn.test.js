// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1187 A SIGNING CHECK DRAWS A NONCE FOR A BOUNDED NUMBER OF ASKS. Before: the door is anyone's, and a request that passed `check` once (a real started bond, public bytes) passed it every
// time, so each ask drew a nonce pair and a session that lived 10 minutes; the same ask repeated also took a place in the proof judge's queue each time, and 32 of them left an honest
// start's proof answered undefined. Now a holder keeps a few sessions per digest and per key and refuses past them before any nonce, a filer that gives up hands its sessions back, and the
// same proof asked again while it is judged waits on that one replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { createCensusSigner, gatherCensusSignature, SESSION_LIMITS } from '../src/census-sign.js';
import { createProofJudge } from '../src/proof-judge.js';
import { censusKeyWork } from '../src/census-key-work.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { encodeCensusKeyRecord } from '../../arena-protocol/src/census-key.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const toScalar = (b) => BigInt(`0x${toHex(b)}`) % N;
const secret = (n) => taggedHash('ARENA/test/CensusSignChurn', Uint8Array.of(n));
let a0 = toScalar(secret(1));
if (secp256k1.getPublicKey(secret(1), true)[0] === 3) a0 = N - a0;
const co = [a0, toScalar(secret(2)), toScalar(secret(3)), toScalar(secret(4))];
const share = (x) => co.reduce((sum, c, i) => (sum + c * BigInt(x) ** BigInt(i)) % N, 0n);
const publicKey = schnorr.getPublicKey(secret(1));
const digestOf = (n) => taggedHash('ARENA/test/CensusSignChurn', Uint8Array.of(100 + n));
const record = encodeCensusKeyRecord({ networkId: new Uint8Array(32), epoch: 1, publicKey, censusHeight: 100, totalShares: 6, threshold: 4, transcriptHash: new Uint8Array(32) });
// a holder whose check passes any request naming a digest: what a real started bond and public proof bytes give anyone at the door
const holder = (n, xs, over = {}) => {
  const checks = { n: 0 };
  const signer = createCensusSigner({ key: schnorr.getPublicKey(secret(10 + n)), work: censusKeyWork, held: () => ({ shares: new Map(xs.map((x) => [x, share(x)])), record }),
    check: async (r) => { checks.n += 1; return { ok: true, digest: digestOf((r && r.d) || 0), publicKey }; }, ...over });
  return { url: `http://h${n}`, signer, checks };
};
const wire = (holders) => async (url, init) => {
  const h = holders.find((x) => url.startsWith(x.url));
  const body = JSON.parse(init.body);
  const answer = url.endsWith('/commit') ? await h.signer.takeCommit(body) : await h.signer.takeShare(body);
  return { json: async () => answer };
};

test('#1187 the same request asked 200 times opens a few sessions, not 200; many requests of one key stop at the key\'s cap; past the total nothing is even checked', async () => {
  const h = holder(1, [1, 2]);
  let opened = 0, refused = 0;
  for (let i = 0; i < 200; i += 1) { const c = await h.signer.takeCommit({ d: 0 }); if (c.ok) opened += 1; else refused += 1; }
  console.log(`  FACTS #1187: 200 asks of one request -> ${opened} nonces drawn, ${h.signer.sessions()} sessions open, ${refused} refused`);
  assert.equal(h.signer.sessions(), SESSION_LIMITS.perDigest, 'sessions open for one request');
  assert.equal(opened, SESSION_LIMITS.perDigest);
  const k = holder(2, [3]);
  for (let d = 0; d < 100; d += 1) await k.signer.takeCommit({ d });
  console.log(`  FACTS #1187: 100 requests of one key -> ${k.signer.sessions()} sessions open`);
  assert.equal(k.signer.sessions(), SESSION_LIMITS.perKey, 'sessions open for one key');
  // the total: a holder of many keys, one ask per key, and past the total the check is not run
  const keys = Array.from({ length: 6 }, (_, i) => schnorr.getPublicKey(secret(40 + i)));
  let at = 0;
  const many = holder(3, [4], { rosterOf: () => ({ total: 6, threshold: 4 }), limits: { ...SESSION_LIMITS, total: 8 },
    check: async () => { at += 1; return { ok: true, digest: digestOf(at), publicKey: keys[at % keys.length] }; } });
  for (let i = 0; i < 20; i += 1) await many.signer.takeCommit({});
  assert.equal(many.signer.sessions(), 8);
  assert.equal(at, 8, 'past the total the holder spends no check on an ask');
  const c = await many.signer.takeCommit({});
  assert.match(c.why, /signing sessions open/);
});

test('#1187 a filer that comes up short hands back every session it drew; its retries never fill a holder\'s cap', async () => {
  const hs = [holder(1, [1, 2]), holder(2, [3])];   // 3 of the 4 shares the key takes
  for (let i = 0; i < 10; i += 1) {
    const got = await gatherCensusSignature({ request: { d: 0 }, digest: digestOf(0), publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: wire(hs) });
    assert.equal(got.ok, false);
  }
  console.log(`  FACTS #1187: 10 short tries -> sessions open at the holders: ${hs.map((h) => h.signer.sessions()).join(', ')}`);
  assert.deepEqual(hs.map((h) => h.signer.sessions()), [0, 0]);
  // and once the fourth share is there, the next try signs: nothing of the ten before is in its way
  const all = [...hs, holder(3, [4])];
  const got = await gatherCensusSignature({ request: { d: 0 }, digest: digestOf(0), publicKey, threshold: 4, urls: all.map((h) => h.url), fetchFn: wire(all) });
  assert.ok(got.ok, got.why);
  assert.ok(schnorr.verify(got.signature, digestOf(0), publicKey));
  assert.deepEqual(all.map((h) => h.signer.sessions()), [0, 0, 0]);
});

test('#1187 a holder whose x another holder brought first gets its session back', async () => {
  const hs = [holder(1, [1, 2]), holder(4, [2, 3]), holder(2, [3, 4])];
  const got = await gatherCensusSignature({ request: { d: 0 }, digest: digestOf(0), publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: wire(hs), atOnce: 1 });
  assert.ok(got.ok, got.why);
  assert.deepEqual(hs.map((h) => h.signer.sessions()), [0, 0, 0], 'the one left out holds nothing open');
});

test('#1187 the same proof asked 40 times at once takes one place in the judge\'s queue: an honest proof behind it is judged', async () => {
  // a judge of 32 places (the default); bytes that read as no proof are judged false, which is enough to show the queue
  const judge = createProofJudge({ committeeOf: () => ({ ok: false, why: 'not yet' }), censusOf: () => ({ ok: false }), coreOf: () => null, beaconOf: () => ({ ok: false }), replayRunOf: () => null });
  const flood = Uint8Array.of(0xee, 1, 2, 3), honest = Uint8Array.of(0xee, 9, 9, 9);
  const asks = Array.from({ length: 40 }, () => judge(flood));
  const said = await judge(honest);
  const flooded = await Promise.all(asks);
  const tooMany = flooded.filter((x) => /too many proofs/.test(x.why)).length;
  console.log(`  FACTS #1187: 40 asks of one proof at once, then an honest one -> honest: ${String(said.why).slice(0, 60)}; ${tooMany} of the 40 refused as too many`);
  assert.doesNotMatch(String(said.why), /too many proofs/, 'the honest proof is judged');
  assert.equal(tooMany, 0);
  assert.equal(judge.queued(), 0);
});
