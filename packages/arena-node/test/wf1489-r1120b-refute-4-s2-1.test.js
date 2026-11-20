// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3060 (skeptic 2, c931b11c1): "every lock at once". refusedReturn now hands the stake lock and its fee lock to
// the seats concurrently (Promise.all over still.map(handRefusedLock)); before #3060 it handed the stake to every seat first, then the fee.
// A seat keeps a refused FEE lock beside the handout whose kept STAKE lock is of the same transaction (kanban #1945) - and when that stake
// is not kept yet, beside the first handout of the player's key it holds. A player with two tries (each join deals a fresh handout under
// the same player key, the retry/reload path) whose fee POST reaches one seat before the stake POST (honest network jitter, well inside
// SEAT_READ_MS) gets the fee kept there under the OTHER try's fee id; the seat where the stake came first keeps it under the right one.
// The fee lock's forfeit needs both seats under one id: it never gathers, the fee waits for its expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import * as PL from '../../arena-client/src/page-lock.js';
import { playerFor } from '../../arena-client/src/join.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#1489 r1120b-refute-4-s2-1: refusedReturn hands stake and fee lock at once; a two-try player\'s fee lock lands under different ids at two seats', { timeout: 120000 }, async () => {
  const refusing = { why: null };
  const w = await lockRound({ serveOpts: { refusedFor: () => refusing.why, unenteredGraceMs: 1e12 } });
  try {
    const base = (d) => `http://127.0.0.1:${d.port}`;
    const seed = rand(32);
    const player = playerFor({ ...w.c, id: w.rid }, { seed, curve: pageCurve }).pubkey;
    const deal = async () => {
      const e = rand(32);
      const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: player,
        ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
        needed: w.needed, curve: feldmanGroup });
      assert.equal(dealt.ok, true, dealt.why);
      return dealt.handout;
    };
    // two tries of one player (same player key): both handouts at every seat
    const tries = [await deal(), await deal()];
    for (const h of tries) for (const d of w.nodes) assert.equal((await fetch(`${base(d)}/handout`, { method: 'POST', body: encodeHandout(h) })).status, 201);
    // the lock is the try that is NOT the first handout a seat lists (so the fee-first seat picks the other try)
    const firstId = toHex(w.b.round.handoutsOf(w.rid)[0].id);
    const mine = tries.find((h) => toHex(handoutId(h)) !== firstId);
    const txid = rand(32);
    const stake = { paymentImage: { kind: 'point', bytes: mine.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk, refundPk: refundKeyOf(player), expiration: w.port.height + 200 };
    const fee = { paymentImage: { kind: 'hash', bytes: rand(32) }, amountMsat: 2000n, claimPk: w.claimPk, refundPk: refundKeyOf(player), expiration: w.port.height + 200 };
    await w.port.put({ txid, outIdx: 0n }, stake);
    await w.port.put({ txid, outIdx: 1n }, fee);
    refusing.why = 'test: this signer node refuses the round';
    // honest network: 300 ms of latency on one POST per seat (seat a: the fee; seat b: the stake), far inside SEAT_READ_MS (15 s)
    const urls = w.nodes.map(base);
    const fetcher = async (url, opts = {}) => {
      const u = String(url);
      if (opts.method === 'POST' && u.includes('/refused-lock')) {
        const idx = String(JSON.parse(opts.body).outpoint).split(':')[1];
        if ((u.startsWith(urls[0]) && idx === '1') || (u.startsWith(urls[1]) && idx === '0')) await sleep(300);
      }
      return fetch(url, opts);
    };
    const client = {
      async lockStatus(txHex, outIdx) {
        const st = await w.port.status({ txid: new Uint8Array(Buffer.from(txHex, 'hex')), outIdx: BigInt(outIdx) });
        return JSON.stringify({ block_count: st.blockCount, stored: st.stored ? { contract_id: st.stored.contractId, blocks_left: st.stored.blocksLeft } : null });
      },
    };
    const kept = { lock: { outpoint: { txid, outIdx: 0 }, fields: stake, feeLock: { outpoint: { txid, outIdx: 1 }, fields: fee } } };
    const look = await PL.lookOwed({ round: w.c, roundId: w.rid, seed, curve: pageCurve, nodes: urls, fetcher, client, kept });
    // what each seat keeps the fee lock under
    const feeIdAt = async (d) => {
      const listed = await (await fetch(`${base(d)}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(player))}`)).json();
      return listed.filter((l) => l.outpoint === `${toHex(txid)}:1`).map((l) => l.entryId);
    };
    const ids = [await feeIdAt(w.a), await feeIdAt(w.b)];
    const forfeitAt = async (eid) => { const f = await fetch(`${base(w.a)}/forfeit?round=${toHex(w.rid)}&entry=${eid}`); return { status: f.status, why: f.status === 200 ? '' : (await f.text()).slice(0, 200) }; };
    const feeBack = ids[0].length ? await forfeitAt(ids[0][0]) : { status: 0, why: 'not listed at seat a' };
    console.log('  FACTS r1120b-refute-4-s2-1:', JSON.stringify({ stake: { state: look.stake.state, how: look.stake.how, why: look.stake.why }, feeIds: ids.map((x) => x.map((i) => String(i).slice(0, 12))), feeBack }));
    assert.ok(ids[0].length && ids[1].length, 'the fee lock is not kept at both seats');
    assert.ok(ids[0].some((i) => ids[1].includes(i)), `the player's 2000 msat fee lock is kept under different ids at the two seats (a: ${ids[0]}, b: ${ids[1]}): its forfeit never gathers`);
    assert.equal(feeBack.status, 200, `the fee lock's forfeit: ${feeBack.why}`);
  } finally { await w.close(); }
});
