// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (order books): A STRANGER'S POST /batch-void BUYS ~119 BIP-340 CHECKS, NO SIGNATURE OF HIS OWN NEEDED (bypass of #1686).
// #1686 bounded a void's `declines` to the round's seats (7 verifies at most). #2026 then added `sets`: up to seats + 1 sets, each
// { batchId, ids, sigs }, and for EACH set #counted verifies up to SIG_TRIES_PER_SEAT x seats (14) signatures - before anything says
// the void can stand. The door is open to anybody, needs no signature of the caller, checks no k range (unlike the void ask), and a set
// is any ids list hashed by the caller to its batchId. So one POST /batch-void of 8 made-up sets of junk signatures under the round's
// public seat keys makes the seat run 8 x 14 + 7 = 119 BIP-340 verifies in JS on its one thread, then answers 403 - without limit.
// SAFE: a void that cannot stand costs the seat no more than its declines do (at most one verify per round seat), a stranger's
// junk sets included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { bookBatchId } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { BATCH_MS } from '../../arena-protocol/src/order-book.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-r2a2', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const junk = () => toHex(new Uint8Array(randomBytes(64)));

test('wf1489-r2-attest-2: a stranger\'s POST /batch-void of made-up sets costs no more signature checks than its declines', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const seat = w.nodes[0];
  const url = `http://127.0.0.1:${seat.port}/batch-void?round=${rid}`;
  const seats = w.c.nodes.map((k) => toHex(k));
  const declines0 = () => seats.map((s) => ({ seat: s, signature: junk() }));
  try {
    // kanban #2678: the door now checks k against the round's book (as #askStands) - a batch far outside it is refused before any verify;
    // the cost is measured on a batch inside the book, where only the shared verify budget bounds it
    const far = await fetch(url, { method: 'POST', body: JSON.stringify({ k: '123456789', declines: declines0(), sets: [] }) });
    assert.equal(far.status, 409, 'a batch outside the round\'s book is refused');
    const K = Math.floor(Number(w.c.committeeTimeMs) / Number(BATCH_MS));
    const declines = () => seats.map((s) => ({ seat: s, signature: junk() }));
    const sets = () => Array.from({ length: seats.length + 1 }, (_, i) => {
      const ids = [toHex(new Uint8Array(randomBytes(32)))];
      return { batchId: toHex(bookBatchId({ roundId: w.rid, k: BigInt(K + 0), orderIds: ids })), ids,
        sigs: seats.flatMap((s) => [{ seat: s, signature: junk() }, { seat: s, signature: junk() }]) };
    });
    const post = async (body) => { const t0 = process.hrtime.bigint(); const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) }); await r.text();
      return { status: r.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };
    // warm up, then the declines-only cost (the #1686 bound) and the cost with junk sets, each the mean of 10 POSTs
    await post({ k: String(K), declines: declines() });
    const mean = async (mk) => { let t = 0, st = 0; for (let i = 0; i < 10; i++) { const r = await post(mk()); t += r.ms; st = r.status; } return { ms: t / 10, status: st }; };
    const base = await mean(() => ({ k: String(K), declines: declines() }));
    const padded = await mean(() => ({ k: String(K), declines: declines(), sets: sets() }));
    console.log('  MEASURED:', JSON.stringify({ declinesOnly: { ms: Math.round(base.ms), status: base.status }, withJunkSets: { ms: Math.round(padded.ms), status: padded.status, sets: seats.length + 1, sigsPerSet: 2 * seats.length },
      ratio: Number((padded.ms / base.ms).toFixed(1)) }));
    assert.equal(padded.status, 403);
    assert.ok(padded.ms < 3 * base.ms, `one stranger's POST /batch-void with made-up sets took ${Math.round(padded.ms)} ms of the seat (declines alone: ${Math.round(base.ms)} ms) and was refused 403`);
  } finally { await w.close(); }
});
